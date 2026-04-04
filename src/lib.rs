//! # structured-public-domains
//!
//! Compact Public Suffix List (PSL) for Rust.
//!
//! - **One** runtime dependency (`structured-zstd` — pure Rust, no FFI)
//! - **~37KB** embedded data (zstd-compressed binary trie)
//! - **O(depth * log k)** lookup via trie traversal with per-node binary search (typically 2-3 steps)
//! - Wildcard (`*.jp`) and exception (`!metro.tokyo.jp`) rules
//! - Includes ICANN and private domains from the Public Suffix List
//! - Checked daily against [publicsuffix.org](https://publicsuffix.org/)
//!
//! # Example
//!
//! ```
//! use structured_public_domains::lookup;
//!
//! let info = lookup("www.example.co.uk").unwrap();
//! assert_eq!(info.suffix(), "co.uk");
//! assert_eq!(info.registrable_domain(), Some("example.co.uk"));
//! assert!(info.is_known());
//! ```

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod trie;

pub use trie::{DomainInfo, is_known_suffix, lookup, registrable_domain};
