# structured-public-domains

Compact Public Suffix List (PSL) for Rust.

[![CI](https://github.com/structured-world/structured-public-domains/actions/workflows/ci.yml/badge.svg)](https://github.com/structured-world/structured-public-domains/actions/workflows/ci.yml)
[![Crates.io](https://img.shields.io/crates/v/structured-public-domains.svg)](https://crates.io/crates/structured-public-domains)
[![docs.rs](https://docs.rs/structured-public-domains/badge.svg)](https://docs.rs/structured-public-domains)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

- **35KB** embedded data (JSON trie compressed with zstd) — 25x smaller than `psl` crate
- **O(depth)** trie walk lookup (typically 2-3 steps)
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

## Why not `psl`?

| | `psl` | `structured-public-domains` |
|---|---|---|
| Binary overhead | ~876KB | **~35KB** |
| Source size | 2.4MB codegen | 35KB compressed blob |
| Lookup | O(depth) match tree | O(depth) trie walk |
| Auto-update | New crate version | Monthly GitHub Actions PR |

## License

MIT
