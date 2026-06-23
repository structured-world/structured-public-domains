//! WebAssembly bindings via `wasm-bindgen`.
//!
//! Exposes [`lookup`], [`registrable_domain`], and
//! [`is_known_suffix`] to JavaScript consumers.

use wasm_bindgen::prelude::*;

/// Result of a PSL lookup, returned as an opaque JS object.
///
/// JavaScript consumers receive property accessors; the JS wrapper layer
/// copies these into a plain object and calls the generated JS `.free()`
/// method so callers never deal with manual memory management.
#[wasm_bindgen(js_name = "DomainInfo")]
pub struct WasmDomainInfo {
    suffix: String,
    registrable: Option<String>,
    known: bool,
}

#[wasm_bindgen(js_class = "DomainInfo")]
impl WasmDomainInfo {
    /// The public suffix (e.g. `"co.uk"`).
    #[wasm_bindgen(getter)]
    pub fn suffix(&self) -> String {
        self.suffix.clone()
    }

    /// The registrable domain (eTLD+1), or `undefined` if the input is a
    /// bare suffix.
    #[wasm_bindgen(getter, js_name = "registrableDomain")]
    pub fn registrable_domain(&self) -> Option<String> {
        self.registrable.clone()
    }

    /// Whether the suffix matched an explicit PSL rule (vs the `*` fallback).
    #[wasm_bindgen(getter)]
    pub fn known(&self) -> bool {
        self.known
    }
}

/// Look up a domain in the Public Suffix List.
///
/// Returns `undefined` for empty or invalid input.
#[wasm_bindgen]
pub fn lookup(domain: &str) -> Option<WasmDomainInfo> {
    crate::lookup(domain).map(|info| WasmDomainInfo {
        suffix: info.suffix().to_owned(),
        registrable: info.registrable_domain().map(str::to_owned),
        known: info.is_known(),
    })
}

/// Extract the registrable domain (eTLD+1).
///
/// Returns `undefined` if the domain is itself a public suffix.
#[wasm_bindgen(js_name = "registrableDomain")]
pub fn registrable_domain(domain: &str) -> Option<String> {
    crate::registrable_domain(domain)
}

/// Check if a domain's suffix is a known entry in the PSL.
#[wasm_bindgen(js_name = "isKnownSuffix")]
pub fn is_known_suffix(domain: &str) -> bool {
    crate::is_known_suffix(domain)
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    // The bindings are thin wrappers over the crate API; wasm-bindgen leaves
    // the underlying Rust functions callable on native targets, so these run
    // (and are measured for coverage) under `cargo test --all-features`.

    #[test]
    fn lookup_populates_all_fields() {
        let info = lookup("www.example.co.uk").expect("known suffix resolves");
        assert_eq!(info.suffix(), "co.uk");
        assert_eq!(info.registrable_domain(), Some("example.co.uk".to_owned()));
        assert!(info.known());
    }

    #[test]
    fn lookup_bare_suffix_has_no_registrable_domain() {
        let info = lookup("co.uk").expect("bare suffix resolves");
        assert_eq!(info.suffix(), "co.uk");
        assert_eq!(info.registrable_domain(), None);
        assert!(info.known());
    }

    #[test]
    fn lookup_unknown_suffix_is_not_known() {
        let info = lookup("example.invalidtld").expect("wildcard fallback resolves");
        assert!(!info.known());
    }

    #[test]
    fn lookup_invalid_input_returns_none() {
        assert!(lookup("").is_none());
    }

    #[test]
    fn registrable_domain_strips_subdomain() {
        assert_eq!(
            registrable_domain("sub.example.com"),
            Some("example.com".to_owned())
        );
        assert_eq!(registrable_domain("com"), None);
    }

    #[test]
    fn is_known_suffix_matches_crate_api() {
        assert!(is_known_suffix("example.com"));
        assert!(!is_known_suffix(""));
    }
}
