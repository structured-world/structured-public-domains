#!/usr/bin/env python3
"""Generate a broad domain corpus from the PSL for Rust<->TS parity testing.

Emits one domain per line to stdout: for every rule a handful of constructed
inputs (sub-labels, case variants, trailing dot) plus synthetic edge cases.
The corpus is fed to both the Rust harness (examples/parity.rs) and the JS twin
(npm/scripts/parity.mjs); their outputs must be byte-identical.
"""
import sys
from pathlib import Path

PSL = Path(__file__).resolve().parent.parent / "data" / "public_suffix_list.dat"

out: list[str] = []

with open(PSL, encoding="utf-8") as f:
    for raw in f:
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        rule = line.lstrip(".")
        labels = rule.split(".")
        if labels[0] == "*":
            base = ".".join(labels[1:])
            out += [f"shop.{base}", f"www.shop.{base}", f"deep.sub.shop.{base}", f"SHOP.{base}".upper()]
        elif rule.startswith("!"):
            r = rule[1:]
            out += [r, f"sub.{r}", f"a.b.sub.{r}"]
        else:
            out += [rule, f"www.{rule}", f"a.b.c.{rule}", f"www.{rule}.", f"WWW.{rule}".upper()]

# Synthetic edge cases (None / fallback handling must agree).
out += [
    "", " ", ".", "..", "a..b", ".leading.com", "trailing..com..", "example.com..",
    "example.invalidtldxyz", "a.b.example.unknowntld", "com", "co.uk", "*.ck",
    "!www.ck", "foo.*.ck", "localhost", "xn--p1ai", "example.xn--p1ai",
    "Example.COM", "  spaced.com  ",
]

sys.stdout.write("\n".join(out) + "\n")
sys.stderr.write(f"generated {len(out)} domains\n")
