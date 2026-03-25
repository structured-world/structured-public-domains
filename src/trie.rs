//! PSL trie: decompress, parse, and lookup.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Compressed PSL trie data (zstd-compressed JSON).
const PSL_DATA: &[u8] = include_bytes!("psl.json.zst");

/// A node in the PSL trie.
#[derive(Debug, Deserialize)]
struct TrieNode {
    /// Whether this node marks a public suffix boundary.
    #[serde(default)]
    s: bool,
    /// Child nodes keyed by label.
    #[serde(default)]
    c: HashMap<Box<str>, TrieNode>,
}

/// Lazily initialized PSL trie.
static PSL: OnceLock<TrieNode> = OnceLock::new();

fn psl() -> &'static TrieNode {
    PSL.get_or_init(|| {
        #[allow(clippy::expect_used)]
        let decompressed =
            zstd::decode_all(PSL_DATA).expect("embedded PSL data is corrupt — rebuild required");
        #[allow(clippy::expect_used)]
        let trie: TrieNode = serde_json::from_slice(&decompressed)
            .expect("embedded PSL JSON is corrupt — rebuild required");
        trie
    })
}

/// Result of a PSL lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainInfo {
    /// The public suffix (e.g., "co.uk").
    suffix: String,
    /// The registrable domain (eTLD+1), if the input has enough labels.
    registrable: Option<String>,
    /// Whether the suffix matched an explicit PSL rule (vs the implicit `*` fallback rule).
    known: bool,
}

impl DomainInfo {
    /// The public suffix (e.g., `"co.uk"`, `"com"`, `"github.io"`).
    pub fn suffix(&self) -> &str {
        &self.suffix
    }

    /// The registrable domain (eTLD+1), e.g., `"example.co.uk"`.
    ///
    /// Returns `None` if the input is the suffix itself (e.g., `"co.uk"`).
    pub fn registrable_domain(&self) -> Option<&str> {
        self.registrable.as_deref()
    }

    /// Whether this suffix is a known entry in the PSL.
    ///
    /// Returns `false` for domains that match only via the `*` default rule.
    pub fn is_known(&self) -> bool {
        self.known
    }
}

/// Look up a domain in the Public Suffix List.
///
/// Returns `None` if the input is empty or has no valid suffix.
///
/// # Example
///
/// ```
/// use structured_public_domains::lookup;
///
/// let info = lookup("www.example.co.uk").unwrap();
/// assert_eq!(info.suffix(), "co.uk");
/// assert_eq!(info.registrable_domain(), Some("example.co.uk"));
/// ```
pub fn lookup(domain: &str) -> Option<DomainInfo> {
    let domain = domain.trim().trim_end_matches('.');
    if domain.is_empty() {
        return None;
    }

    let labels: Vec<&str> = domain.rsplit('.').collect();
    // Reject domains with empty labels (leading dots, consecutive dots).
    if labels.is_empty() || labels.iter().any(|label| label.is_empty()) {
        return None;
    }

    let trie = psl();
    let mut node = trie;
    let mut suffix_depth = 0;
    let mut known = false;

    // Reusable buffer for lowercase labels (avoids allocation per iteration).
    let mut label_buf = String::new();

    for (depth, &label) in labels.iter().enumerate() {
        label_buf.clear();
        for ch in label.chars() {
            label_buf.extend(ch.to_lowercase());
        }

        // Check for exact match first (most common path).
        if let Some(child) = node.c.get(label_buf.as_str()) {
            if child.s {
                suffix_depth = depth + 1;
                known = true;
            }
            node = child;
            continue;
        }

        // Check for wildcard (with exception handling).
        if node.c.contains_key("*") {
            // Exception rules (`!label`) cancel the wildcard for this specific label.
            // Only 8 exceptions in the entire PSL, so this allocation is rare.
            label_buf.insert(0, '!');
            if node.c.contains_key(label_buf.as_str()) {
                suffix_depth = depth;
                known = true;
            } else {
                suffix_depth = depth + 1;
                known = true;
            }
            break;
        }

        break;
    }

    if suffix_depth == 0 {
        // No match — fall back to TLD as suffix (prevailing rule: `*`)
        suffix_depth = 1;
        known = false;
    }

    let suffix_labels: Vec<String> = labels[..suffix_depth]
        .iter()
        .rev()
        .map(|l| l.to_ascii_lowercase())
        .collect();
    let suffix = suffix_labels.join(".");

    let registrable = if labels.len() > suffix_depth {
        // eTLD+1: registrable label + suffix (all lowercased)
        let reg_label = labels[suffix_depth].to_ascii_lowercase();
        Some(format!("{reg_label}.{suffix}"))
    } else {
        None
    };

    Some(DomainInfo {
        suffix,
        registrable,
        known,
    })
}

/// Check if a domain's suffix is a known entry in the PSL.
pub fn is_known_suffix(domain: &str) -> bool {
    lookup(domain).is_some_and(|info| info.is_known())
}

/// Extract the registrable domain (eTLD+1) from a domain.
///
/// Returns `None` if the domain is itself a public suffix.
pub fn registrable_domain(domain: &str) -> Option<String> {
    lookup(domain).and_then(|info| info.registrable)
}

#[cfg(test)]
#[allow(clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn simple_com() {
        let info = lookup("example.com").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "com");
        assert_eq!(info.registrable_domain(), Some("example.com"));
        assert!(info.is_known());
    }

    #[test]
    fn nested_co_uk() {
        let info = lookup("www.example.co.uk").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "co.uk");
        assert_eq!(info.registrable_domain(), Some("example.co.uk"));
    }

    #[test]
    fn subdomain_stripped() {
        let info = lookup("deep.sub.example.com").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "com");
        assert_eq!(info.registrable_domain(), Some("example.com"));
    }

    #[test]
    fn bare_tld() {
        let info = lookup("com").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "com");
        assert_eq!(info.registrable_domain(), None);
    }

    #[test]
    fn empty_input() {
        assert!(lookup("").is_none());
    }

    #[test]
    fn trailing_dot() {
        let info = lookup("example.com.").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "com");
    }

    #[test]
    fn case_insensitive() {
        let info = lookup("Example.COM").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "com");
    }

    #[test]
    fn is_known_check() {
        assert!(is_known_suffix("example.com"));
    }

    #[test]
    fn registrable_helper() {
        assert_eq!(
            registrable_domain("www.example.co.uk"),
            Some("example.co.uk".to_string())
        );
    }

    // ── Wildcard rules ──

    #[test]
    fn wildcard_ck() {
        // *.ck is a wildcard rule — any second-level under .ck is a suffix.
        // "foo.ck" → suffix is "foo.ck" (wildcard match).
        let info = lookup("example.foo.ck").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "foo.ck");
        assert_eq!(info.registrable_domain(), Some("example.foo.ck"));
        assert!(info.is_known());
    }

    // ── Exception rules ──

    #[test]
    fn exception_www_ck() {
        // !www.ck is an exception to *.ck — www.ck is NOT a suffix,
        // so the suffix falls back to "ck" and www.ck is registrable.
        let info = lookup("www.ck").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "ck");
        assert_eq!(info.registrable_domain(), Some("www.ck"));
    }

    // ── Edge cases: empty labels ──

    #[test]
    fn leading_dot() {
        assert!(lookup(".example.com").is_none());
    }

    #[test]
    fn consecutive_dots() {
        assert!(lookup("example..com").is_none());
    }
}
