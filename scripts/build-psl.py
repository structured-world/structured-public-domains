#!/usr/bin/env python3
"""Build a compact binary trie from the Public Suffix List.

Binary format (DFS preorder):
    Node  = [flags:u8] [num_children:u16_le] [child₁ child₂ ...]
    Child = [label_len:u8] [label_bytes...] [child_node]

    flags: bit 0 = suffix boundary (s=true)
    Children sorted by label (enables binary search at runtime).

Reads:  data/public_suffix_list.dat
Writes: src/psl.bin
"""

import shutil
import struct
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PSL_PATH = REPO_ROOT / "data" / "public_suffix_list.dat"
OUTPUT_PATH = REPO_ROOT / "src" / "psl.bin.zst"


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


def serialize_node(node: dict) -> bytearray:
    """Serialize a trie node to binary format (DFS preorder)."""
    buf = bytearray()

    # flags: bit 0 = suffix boundary
    flags = 1 if node["s"] else 0
    buf += struct.pack("<B", flags)

    # Sort children by label for binary search at runtime
    children = sorted(node["c"].items())
    buf += struct.pack("<H", len(children))

    for label, child in children:
        label_bytes = label.encode("utf-8")
        if len(label_bytes) > 255:
            print(f"Label too long ({len(label_bytes)} bytes): {label}", file=sys.stderr)
            sys.exit(1)
        buf += struct.pack("<B", len(label_bytes))
        buf += label_bytes
        buf += serialize_node(child)

    return buf


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


def compress_zstd(data: bytes) -> bytes:
    """Compress data with zstd -19 via CLI."""
    zstd = shutil.which("zstd")
    if zstd is None:
        print("zstd not found — install zstd (brew install zstd / apt install zstd)", file=sys.stderr)
        sys.exit(1)
    result = subprocess.run(
        [zstd, "-19", "--no-progress", "-c"],
        input=data,
        capture_output=True,
    )
    if result.returncode != 0:
        print(f"zstd compression failed: {result.stderr.decode()}", file=sys.stderr)
        sys.exit(1)
    return result.stdout


def main() -> None:
    if not PSL_PATH.exists():
        print(f"PSL data not found: {PSL_PATH}", file=sys.stderr)
        sys.exit(1)

    trie = build_trie(PSL_PATH)

    n_rules = count_suffixes(trie)
    n_nodes = count_nodes(trie)
    print(f"Parsed {n_rules} PSL rules, {n_nodes} trie nodes")

    binary = serialize_node(trie)
    compressed = compress_zstd(bytes(binary))
    OUTPUT_PATH.write_bytes(compressed)

    raw_kb = len(binary) / 1024
    zst_kb = len(compressed) / 1024
    ratio = len(compressed) / len(binary) * 100
    print(f"Binary trie: {raw_kb:.0f} KB → zstd: {zst_kb:.0f} KB ({ratio:.0f}%) → {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
