#!/usr/bin/env python3
"""Build a compact binary trie from the Public Suffix List.

The image is searched in place, straight out of the `include_bytes!` slice, so
the reader never builds a heap copy. That is what the layout below is for.

Binary format (DFS preorder):
    Node   = [header] [index?] [entry₁ entry₂ ...]
    header = u8: bit 7 = suffix boundary
                 bit 6 = index present
                 bit 5 = a "*" wildcard child is present
                 bits 0-4 = child count, or 0x1F meaning a u16_le count follows
    index  = [entry_offset:u24_le] * child_count, each relative to the node's
             first byte; present only when the child count reaches INDEX_MIN
    entry  = [label_len:u8] [label_bytes...] [subtree_len:varint] [child node]
             the subtree length is written only when the node has no index

Children are sorted by label bytes, so a node with an index is binary-searched
and one without is scanned linearly.

Every node needs some way to step from one entry to the next, because entries
are variable-length and each child is inlined. A node pays for exactly one:
an index, which also gives random access, or a per-entry subtree length, which
only gives the step. Charging both would pay twice for the same capability.

Which one is cheaper depends on the fan-out, and the split is measured against
the real list rather than guessed. 9,722 of the 10,934 nodes are leaves and 580
more hold a single child, so an index everywhere would be dead weight on 95% of
nodes and grows the image past what it replaces. At INDEX_MIN the 20 widest
nodes — the root among them, with 1,449 children — take the index and the rest
scan at most INDEX_MIN-1 short labels.

The wildcard bit is what the fifth header bit buys. A lookup has to ask every
node it passes whether a `*` child exists, because a wildcard rule outranks a
non-boundary exact match, and almost every answer is no: searching for it was
half of all the searching a lookup did. Answering from a bit costs one byte on
the 41 nodes whose child count no longer fits five bits, 82 bytes over the whole
image.

Reads:  data/public_suffix_list.dat
Writes: src/psl.bin
"""

import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PSL_PATH = REPO_ROOT / "data" / "public_suffix_list.dat"
OUTPUT_PATH = REPO_ROOT / "src" / "psl.bin"

# Child count at which a node earns an offset index instead of per-entry subtree
# lengths. Measured against the real list: 64 covers the 20 widest nodes, which
# hold 44% of all edges, and lands under the size of the format it replaces,
# while 48 would exceed it. Keep in step with `INDEX_MIN` in src/trie.rs.
INDEX_MIN = 64

# Child count that no longer fits the header's 5-bit field; a u16 follows.
COUNT_ESCAPE = 0x1F


def build_trie(psl_path: Path) -> dict:
    """Parse PSL rules into a trie with {s: bool, c: {label: node}}."""
    trie: dict = {"s": False, "c": {}}

    with open(psl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("//"):
                continue

            rule = line.lstrip(".")
            labels = rule.split(".")
            labels.reverse()

            node = trie
            for label in labels:
                label_lower = label.lower()
                if not label_lower:
                    print(f"Empty label in PSL rule: {rule}", file=sys.stderr)
                    sys.exit(1)
                if label_lower not in node["c"]:
                    node["c"][label_lower] = {"s": False, "c": {}}
                node = node["c"][label_lower]

            node["s"] = True

    return trie


def varint(value: int) -> bytes:
    """LEB128, low 7 bits per byte, high bit marking continuation."""
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def serialize_node(node: dict) -> bytearray:
    """Serialize a trie node to binary format (DFS preorder)."""
    # Sort children by label bytes: both the binary search and the linear scan
    # rely on ascending order, and the reader verifies it.
    children = sorted(node["c"].items())
    count = len(children)

    has_index = count >= INDEX_MIN

    entries = []
    for label, child in children:
        label_bytes = label.encode("utf-8")
        if len(label_bytes) > 255:
            print(f"Label too long ({len(label_bytes)} bytes): {label}", file=sys.stderr)
            sys.exit(1)
        body = serialize_node(child)
        entry = struct.pack("<B", len(label_bytes)) + label_bytes
        if not has_index:
            entry += varint(len(body))
        entries.append(entry + body)

    header = bytearray()
    has_wildcard = any(label == "*" for label, _ in children)
    flags = (
        (0x80 if node["s"] else 0)
        | (0x40 if has_index else 0)
        | (0x20 if has_wildcard else 0)
    )
    if count < COUNT_ESCAPE:
        header += struct.pack("<B", flags | count)
    else:
        if count > 0xFFFF:
            print(f"Node has too many children: {count}", file=sys.stderr)
            sys.exit(1)
        header += struct.pack("<BH", flags | COUNT_ESCAPE, count)

    index = bytearray()
    if has_index:
        # Offsets are relative to the node's first byte, so a subtree can be
        # written once and placed anywhere.
        offset = len(header) + 3 * count
        for entry in entries:
            index += struct.pack("<I", offset)[:3]
            offset += len(entry)

    return header + index + b"".join(entries)


def count_suffixes(node: dict) -> int:
    total = 1 if node.get("s") else 0
    for child in node.get("c", {}).values():
        total += count_suffixes(child)
    return total


def count_nodes(node: dict) -> int:
    total = 1
    for child in node.get("c", {}).values():
        total += count_nodes(child)
    return total


def main() -> None:
    if not PSL_PATH.exists():
        print(f"PSL data not found: {PSL_PATH}", file=sys.stderr)
        sys.exit(1)

    trie = build_trie(PSL_PATH)

    n_rules = count_suffixes(trie)
    n_nodes = count_nodes(trie)
    print(f"Parsed {n_rules} PSL rules, {n_nodes} trie nodes")

    binary = serialize_node(trie)
    OUTPUT_PATH.write_bytes(binary)

    kb = len(binary) / 1024
    print(f"Written {kb:.0f} KB to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
