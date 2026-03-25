#!/usr/bin/env python3
"""Build a compressed JSON trie from the Public Suffix List.

Reads:  data/public_suffix_list.dat
Writes: src/psl.json.zst
"""

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PSL_PATH = REPO_ROOT / "data" / "public_suffix_list.dat"
OUTPUT_PATH = REPO_ROOT / "src" / "psl.json.zst"


def build_trie(psl_path: Path) -> dict:
    """Parse PSL rules into a trie with {s: bool, c: {label: node}}."""
    trie: dict = {"c": {}}

    with open(psl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            # Skip comments and blank lines
            if not line or line.startswith("//"):
                continue

            # Normalize: remove leading dots (shouldn't exist, but be safe)
            rule = line.lstrip(".")

            # Split into labels (reversed for trie insertion: TLD first)
            labels = rule.split(".")
            labels.reverse()

            node = trie
            for label in labels:
                label_lower = label.lower()
                if label_lower not in node["c"]:
                    node["c"][label_lower] = {"c": {}}
                node = node["c"][label_lower]

            # Mark the final node as a suffix boundary
            node["s"] = True

    return trie


def compress_trie(trie: dict, output_path: Path) -> None:
    """Serialize trie to JSON and compress with zstd."""
    json_bytes = json.dumps(trie, separators=(",", ":")).encode("utf-8")

    # Use zstd CLI for compression (available in CI and most dev environments)
    result = subprocess.run(
        ["zstd", "-19", "--force", "-o", str(output_path)],
        input=json_bytes,
        capture_output=True,
    )
    if result.returncode != 0:
        print(f"zstd compression failed: {result.stderr.decode()}", file=sys.stderr)
        sys.exit(1)

    json_kb = len(json_bytes) / 1024
    zst_kb = output_path.stat().st_size / 1024
    print(f"Built trie: {json_kb:.0f} KB JSON -> {zst_kb:.0f} KB zstd")


def main() -> None:
    if not PSL_PATH.exists():
        print(f"PSL data not found: {PSL_PATH}", file=sys.stderr)
        sys.exit(1)

    trie = build_trie(PSL_PATH)

    # Count rules for sanity check
    def count_suffixes(node: dict) -> int:
        total = 1 if node.get("s") else 0
        for child in node.get("c", {}).values():
            total += count_suffixes(child)
        return total

    n = count_suffixes(trie)
    print(f"Parsed {n} PSL rules")

    compress_trie(trie, OUTPUT_PATH)
    print(f"Written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
