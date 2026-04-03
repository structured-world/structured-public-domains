//! PSL trie: parse compact binary format and lookup.

use std::sync::OnceLock;

/// Compact binary PSL trie (DFS preorder, uncompressed).
const PSL_DATA: &[u8] = include_bytes!("psl.bin");

/// A node in the PSL trie.
///
/// Children are sorted by label, enabling binary search during lookup.
#[derive(Debug)]
struct TrieNode {
    /// Whether this node marks a public suffix boundary.
    suffix_boundary: bool,
    /// Child nodes sorted by label.
    children: Vec<(Box<str>, TrieNode)>,
}

/// Lazily initialized PSL trie.
static PSL: OnceLock<TrieNode> = OnceLock::new();

fn psl() -> &'static TrieNode {
    PSL.get_or_init(|| {
        let mut cursor = 0;
        #[allow(clippy::expect_used)]
        let node = parse_node(PSL_DATA, &mut cursor)
            .expect("embedded PSL data is corrupt — rebuild required");
        node
    })
}

/// Parse a single trie node from the binary format.
///
/// Format: `[flags:u8] [num_children:u16_le] [child₁ child₂ ...]`
/// Child:  `[label_len:u8] [label_bytes...] [child_node]`
fn parse_node(data: &[u8], cursor: &mut usize) -> Option<TrieNode> {
    let flags = *data.get(*cursor)?;
    *cursor += 1;

    let lo = *data.get(*cursor)? as u16;
    *cursor += 1;
    let hi = *data.get(*cursor)? as u16;
    *cursor += 1;
    let num_children = lo | (hi << 8);

    let mut children = Vec::with_capacity(num_children as usize);
    for _ in 0..num_children {
        let label_len = *data.get(*cursor)? as usize;
        *cursor += 1;

        let label_end = *cursor + label_len;
        if label_end > data.len() {
            return None;
        }
        let label_bytes = &data[*cursor..label_end];
        *cursor = label_end;

        // Labels are stored as UTF-8 in the binary format (already lowercased).
        let label = core::str::from_utf8(label_bytes).ok()?;
        let child = parse_node(data, cursor)?;
        children.push((Box::from(label), child));
    }

    Some(TrieNode {
        suffix_boundary: flags & 1 != 0,
        children,
    })
}

impl TrieNode {
    /// Find a child node by label using binary search.
    fn child(&self, label: &str) -> Option<&TrieNode> {
        self.children
            .binary_search_by(|(k, _)| k.as_ref().cmp(label))
            .ok()
            .map(|i| &self.children[i].1)
    }

    /// Check if a child with the given label exists.
    fn has_child(&self, label: &str) -> bool {
        self.children
            .binary_search_by(|(k, _)| k.as_ref().cmp(label))
            .is_ok()
    }
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
/// Returns `None` if the input is empty or contains invalid labels (empty/consecutive dots).
/// Always returns `Some` for valid domain strings (unknown TLDs fall back to the implicit `*` rule).
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
        if let Some(child) = node.child(label_buf.as_str()) {
            if child.suffix_boundary {
                suffix_depth = depth + 1;
                known = true;
            }
            node = child;
            continue;
        }

        // Check for wildcard (with exception handling).
        if node.has_child("*") {
            // Exception rules (`!label`) cancel the wildcard for this specific label.
            // Only 8 exceptions in the entire PSL, so this allocation is rare.
            label_buf.insert(0, '!');
            if node.has_child(label_buf.as_str()) {
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
        .map(|l| l.to_lowercase())
        .collect();
    let suffix = suffix_labels.join(".");

    let registrable = if labels.len() > suffix_depth {
        // eTLD+1: registrable label + suffix (all lowercased)
        let reg_label = labels[suffix_depth].to_lowercase();
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

    // -- Wildcard rules --

    #[test]
    fn wildcard_ck() {
        // *.ck is a wildcard rule — any second-level under .ck is a suffix.
        // "foo.ck" → suffix is "foo.ck" (wildcard match).
        let info = lookup("example.foo.ck").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "foo.ck");
        assert_eq!(info.registrable_domain(), Some("example.foo.ck"));
        assert!(info.is_known());
    }

    // -- Exception rules --

    #[test]
    fn exception_www_ck() {
        // !www.ck is an exception to *.ck — www.ck is NOT a suffix,
        // so the suffix falls back to "ck" and www.ck is registrable.
        let info = lookup("www.ck").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "ck");
        assert_eq!(info.registrable_domain(), Some("www.ck"));
    }

    // -- Edge cases: empty labels --

    #[test]
    fn leading_dot() {
        assert!(lookup(".example.com").is_none());
    }

    #[test]
    fn consecutive_dots() {
        assert!(lookup("example..com").is_none());
    }
}
