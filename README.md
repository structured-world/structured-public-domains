# structured-public-domains

Compact Public Suffix List (PSL) for Rust.

[![CI](https://github.com/structured-world/structured-public-domains/actions/workflows/ci.yml/badge.svg)](https://github.com/structured-world/structured-public-domains/actions/workflows/ci.yml)
[![Crates.io](https://img.shields.io/crates/v/structured-public-domains.svg)](https://crates.io/crates/structured-public-domains)
[![npm](https://img.shields.io/npm/v/@structured-world/structured-public-domains.svg)](https://www.npmjs.com/package/@structured-world/structured-public-domains)
[![docs.rs](https://docs.rs/structured-public-domains/badge.svg)](https://docs.rs/structured-public-domains)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

- **`no_std` + `alloc`** — runs in a WASM sandbox or on bare metal
- **~108KB** embedded data (compact binary trie)
- **~2.4M lookups/sec** on a single core (~420 ns per lookup)
- **O(depth * log k)** trie traversal with per-node binary search (typically 2-3 steps)
- Wildcard (`*.jp`) and exception (`!metro.tokyo.jp`) rules
- Based on the official Public Suffix List (ICANN and private sections)
- Checked daily against [publicsuffix.org](https://publicsuffix.org/)

**Terminology:** A *public suffix* (e.g., `com`, `co.uk`) is the part of a domain under which users can register names. The *registrable domain* (eTLD+1) is one label above the suffix (e.g., `example.co.uk`).

## Usage (Rust)

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

### Without `std`

The lookup path needs an allocator for the strings it returns and nothing else:
no `std`, and no pointer-width atomic, so parts without a compare-and-swap are
in scope too. CI checks `thumbv7em-none-eabihf` and `thumbv6m-none-eabi`,
because a host check cannot fail on a constraint the host does not have.

```toml
structured-public-domains = { version = "0", default-features = false, features = ["alloc"] }
```

## Usage (JavaScript / TypeScript)

The same PSL trie ships as a native TypeScript npm package — no WebAssembly, no
runtime dependencies. The ~108KB binary trie is embedded and decoded lazily on
first call, so every function is **synchronous** with no `init()`: it drops
straight into Node, browsers, bundlers, and downstream libraries. Ships both
ESM and CommonJS with type declarations for each.

```sh
npm install @structured-world/structured-public-domains
```

```typescript
// ESM
import { lookup, registrableDomain, isKnownSuffix } from '@structured-world/structured-public-domains';

const info = lookup('www.example.co.uk');
// info.suffix            → "co.uk"
// info.registrableDomain → "example.co.uk"
// info.known             → true

registrableDomain('sub.example.com');  // "example.com"
isKnownSuffix('example.com');          // true
```

```javascript
// CommonJS (e.g. default NestJS)
const { lookup, registrableDomain, isKnownSuffix } = require('@structured-world/structured-public-domains');
```

### Raw trie data

The embedded binary trie is exposed for consumers that want to walk it
themselves (the format matches the Rust crate's `src/psl.bin`):

```typescript
import { pslData } from '@structured-world/structured-public-domains';

const bytes = pslData();   // Uint8Array — a defensive copy of the trie blob
```

The JS lookup is verified byte-for-byte against the Rust implementation over the
entire PSL on every CI run, so both languages return identical results.

### Tiny build (runtime-fetched, no embedded data)

For consumers who want always-fresh PSL **without bumping the package version**,
the `/tiny` entry ships *without* the embedded blob. It fetches the prebuilt
binary trie at runtime and caches it locally (Node: temp file with a TTL;
browser: CacheStorage). After the first `await load()`, the lookup API is
identical and synchronous.

```typescript
import { load, registrableDomain } from '@structured-world/structured-public-domains/tiny';

await load();                              // fetch + cache once (default: jsDelivr CDN)
registrableDomain('sub.example.co.uk');    // "example.co.uk"

// Options: custom source, TTL, cache dir, or force refresh.
await load({ url: 'https://psl.example.com/psl.bin', cacheTtlMs: 3_600_000, force: true });
```

The default source is the same `psl.bin` served from this package's jsDelivr CDN,
pinned to the installed `major.minor` range — so it always tracks the latest
PSL-data patch release (same trie format) but never a future format-breaking
version the bundled parser can't read. Results are identical to the embedded
build. Use the full `.` entry when you want zero network and instant startup; use
`/tiny` when install size and
always-current data matter more.

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

**Runtime memory: none.** The trie is searched in place, straight out of the embedded image, so there is nothing to parse, nothing to allocate, no lazy initialization and nothing to synchronize on the first call. `include_bytes!` puts the ~108KB image in read-only data, which the loader maps on a hosted target and the linker places in flash on a bare-metal one; a lookup walks it where it lies. Only the returned strings allocate.

## Why not `psl`?

| | `psl` | `structured-public-domains` |
|---|---|---|
| Embedded data | ~876KB (codegen match tree) | **108KB** (compact binary trie) |
| Source size | 2.4MB codegen | 300 lines + 108KB blob |
| Runtime deps | None | **None** |
| Runtime memory | N/A (static) | **None** (searched in place) |
| Lookup | O(depth) match tree | O(depth * log k) trie walk |
| Auto-update | New crate version | Daily GitHub Actions check |

Both crates have comparable lookup speed. `structured-public-domains` has ~8x smaller embedded data, allocates nothing at rest, builds without `std` or pointer-width atomics, and auto-updates daily via GitHub Actions with domain-level changelogs.

## Support the Project

<div align="center">

![USDT TRC-20 Donation QR Code](assets/usdt-qr.svg)

USDT (TRC-20): `TFDsezHa1cBkoeZT5q2T49Wp66K8t2DmdA`

</div>

## License

Apache License 2.0
