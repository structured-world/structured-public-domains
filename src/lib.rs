//! # structured-public-domains
//!
//! Compact Public Suffix List (PSL) for Rust.
//!
//! - **~108KB** embedded data (compact binary trie)
//! - **`no_std` + `alloc`**: runs in a WASM sandbox or on bare metal; disable
//!   the `std` feature and enable `alloc`
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
#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

mod trie;

pub use trie::{DomainInfo, is_known_suffix, lookup, registrable_domain};
