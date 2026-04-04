//! WebAssembly bindings via `wasm-bindgen`.
//!
//! Exposes [`lookup`], [`registrable_domain`][registrable_domain_fn], and
//! [`is_known_suffix`][is_known_suffix_fn] to JavaScript consumers.

use wasm_bindgen::prelude::*;

/// Result of a PSL lookup, returned as an opaque JS object.
///
/// JavaScript consumers receive property accessors; the JS wrapper layer
/// copies these into a plain object and calls [`free`](WasmDomainInfo::free)
/// so callers never deal with manual memory management.
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
