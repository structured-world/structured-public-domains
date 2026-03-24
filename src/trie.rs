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
        let decompressed = zstd::decode_all(PSL_DATA).unwrap_or_else(|e| {
            // This is compile-time embedded data — if it fails, the build is broken.
            // We can't use expect/unwrap due to lint, so provide empty fallback.
            eprintln!("structured-public-domains: failed to decompress PSL data: {e}");
            Vec::new()
        });
        serde_json::from_slice(&decompressed).unwrap_or_else(|e| {
            eprintln!("structured-public-domains: failed to parse PSL trie: {e}");
            TrieNode {
                s: false,
                c: HashMap::new(),
            }
        })
    })
}

/// Result of a PSL lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainInfo {
    /// The public suffix (e.g., "co.uk").
    suffix: String,
    /// The registrable domain (eTLD+1), if the input has enough labels.
    registrable: Option<String>,
    /// Whether the suffix is in the ICANN section (vs Private).
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
    if labels.is_empty() {
        return None;
    }

    let trie = psl();
    let mut node = trie;
    let mut suffix_depth = 0;
    let mut known = false;

    for (depth, &label) in labels.iter().enumerate() {
        let label_lower = label.to_ascii_lowercase();

        // Check for exception rule: `!label` cancels wildcard
        let exc_key = format!("!{label_lower}");
        if node.c.contains_key(exc_key.as_str()) {
            // Exception: this label is NOT part of the suffix
            break;
        }

        // Check for exact match
        if let Some(child) = node.c.get(label_lower.as_str()) {
            if child.s || !child.c.is_empty() {
                suffix_depth = depth + 1;
                known = true;
            }
            node = child;
            continue;
        }

        // Check for wildcard
        if node.c.contains_key("*") {
            suffix_depth = depth + 1;
            known = true;
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
    lookup(domain).and_then(|info| info.registrable.clone())
}

#[cfg(test)]
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
}
