# structured-public-domains

Compact Public Suffix List (PSL) for Rust.

[![CI](https://github.com/structured-world/structured-public-domains/actions/workflows/ci.yml/badge.svg)](https://github.com/structured-world/structured-public-domains/actions/workflows/ci.yml)
[![Crates.io](https://img.shields.io/crates/v/structured-public-domains.svg)](https://crates.io/crates/structured-public-domains)
[![docs.rs](https://docs.rs/structured-public-domains/badge.svg)](https://docs.rs/structured-public-domains)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

- **35KB** embedded data (JSON trie compressed with zstd)
- **~3M lookups/sec** on a single core (~325 ns per lookup)
- **O(depth)** trie walk (typically 2-3 steps)
- Wildcard (`*.jp`) and exception (`!metro.tokyo.jp`) rules
- Based on the official Public Suffix List (ICANN and private sections)
- Auto-updated monthly from [publicsuffix.org](https://publicsuffix.org/)

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
| Simple (`example.com`) | 325 ns | 3.1M/s |
| Nested (`www.example.co.uk`) | 387 ns | 2.6M/s |
| Deep subdomain (`a.b.c.d.example.com`) | 393 ns | 2.5M/s |
| Bare TLD (`com`) | 141 ns | 7.1M/s |
| Private domain (`mysite.github.io`) | 376 ns | 2.7M/s |
| Long chain (`very.deep...co.uk`) | 460 ns | 2.2M/s |

**Runtime memory:** The PSL trie is decompressed and parsed lazily on first call (`OnceLock`), then cached for the lifetime of the process. Runtime footprint is ~1.1 MB (10,835-node trie with ~9,000 suffix rules). The 35KB compressed blob is embedded in the binary at compile time.

## Why not `psl`?

| | `psl` | `structured-public-domains` |
|---|---|---|
| Embedded data | ~876KB (codegen match tree) | **35KB** (zstd-compressed trie) |
| Source size | 2.4MB codegen | 300 lines + 35KB blob |
| Runtime deps | None | `serde_json`, `zstd` |
| Lookup | O(depth) match tree | O(depth) trie walk |
| Auto-update | New crate version | Monthly GitHub Actions PR |

Both crates have comparable lookup speed. `psl` trades a larger binary for zero runtime dependencies. `structured-public-domains` trades a smaller binary and auto-updates for a `zstd` dependency (C FFI; pure Rust via `structured-zstd` is planned — see [#9](https://github.com/structured-world/structured-public-domains/issues/9)).

## Support the Project

<div align="center">

![USDT TRC-20 Donation QR Code](assets/usdt-qr.svg)

USDT (TRC-20): `TFDsezHa1cBkoeZT5q2T49Wp66K8t2DmdA`

</div>

## License

Apache License 2.0
