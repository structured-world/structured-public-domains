# structured-public-domains

Compact Public Suffix List (PSL) for Rust.

[![CI](https://github.com/structured-world/structured-public-domains/actions/workflows/ci.yml/badge.svg)](https://github.com/structured-world/structured-public-domains/actions/workflows/ci.yml)
[![Crates.io](https://img.shields.io/crates/v/structured-public-domains.svg)](https://crates.io/crates/structured-public-domains)
[![docs.rs](https://docs.rs/structured-public-domains/badge.svg)](https://docs.rs/structured-public-domains)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

- **Zero** runtime dependencies
- **~108KB** embedded data (compact binary trie)
- **~2.4M lookups/sec** on a single core (~420 ns per lookup)
- **O(depth * log k)** trie traversal with per-node binary search (typically 2-3 steps)
- Wildcard (`*.jp`) and exception (`!metro.tokyo.jp`) rules
- Based on the official Public Suffix List (ICANN and private sections)
- Checked daily against [publicsuffix.org](https://publicsuffix.org/)

**Terminology:** A *public suffix* (e.g., `com`, `co.uk`) is the part of a domain under which users can register names. The *registrable domain* (eTLD+1) is one label above the suffix (e.g., `example.co.uk`).

## Usage

```rust
use structured_public_domains::{lookup, registrable_domain, is_known_suffix};

let info = lookup("www.example.co.uk").unwrap();
assert_eq!(info.suffix(), "co.uk");
assert_eq!(info.registrable_domain(), Some("example.co.uk"));
assert!(info.is_known());

// Helpers
assert_eq!(registrable_domain("sub.example.com"), Some("example.com".to_string()));
assert!(is_known_suffix("example.com"));
```

## Performance

Benchmarks on Apple M-series (criterion, `cargo bench`):

| Benchmark | Time | Throughput |
|-----------|------|-----------|
| Simple (`example.com`) | ~420 ns | ~2.4M/s |
| Nested (`www.example.co.uk`) | ~425 ns | ~2.4M/s |
| Deep subdomain (`a.b.c.d.example.com`) | ~500 ns | ~2.0M/s |
| Bare TLD (`com`) | ~195 ns | ~5.1M/s |
| Private domain (`mysite.github.io`) | ~450 ns | ~2.2M/s |
| Long chain (`very.deep...co.uk`) | ~500 ns | ~2.0M/s |

**Runtime memory:** The PSL trie is parsed lazily on first call (`OnceLock`), then cached for the lifetime of the process. Runtime footprint is ~530 KB (sorted `Vec` children with binary search lookup). The ~108KB binary blob is embedded in the binary at compile time.

## Why not `psl`?

| | `psl` | `structured-public-domains` |
|---|---|---|
| Embedded data | ~876KB (codegen match tree) | **108KB** (compact binary trie) |
| Source size | 2.4MB codegen | 300 lines + 108KB blob |
| Runtime deps | None | **None** |
| Runtime memory | N/A (static) | **~530KB** |
| Lookup | O(depth) match tree | O(depth * log k) trie walk |
| Auto-update | New crate version | Daily GitHub Actions check |

Both crates have comparable lookup speed and zero runtime dependencies. `structured-public-domains` has ~8x smaller embedded data and auto-updates daily via GitHub Actions with domain-level changelogs.

## Support the Project

<div align="center">

![USDT TRC-20 Donation QR Code](assets/usdt-qr.svg)

USDT (TRC-20): `TFDsezHa1cBkoeZT5q2T49Wp66K8t2DmdA`

</div>

## License

Apache License 2.0
