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
        #[allow(clippy::expect_used)]
        (|| {
            let mut cursor = 0;
            let node = parse_node(PSL_DATA, &mut cursor)?;
            if cursor != PSL_DATA.len() {
                return None;
            }
            Some(node)
        })()
        .expect("embedded PSL data is corrupt — rebuild required")
    })
}

/// Parse a single trie node from the binary format.
///
/// Format: `[flags:u8] [num_children:u16_le] [child₁ child₂ ...]`
/// Child:  `[label_len:u8] [label_bytes...] [child_node]`
fn parse_node(data: &[u8], cursor: &mut usize) -> Option<TrieNode> {
    let flags = *data.get(*cursor)?;
    *cursor += 1;
    // Reject reserved flag bits — only bit 0 (suffix boundary) is defined.
    if flags & !1 != 0 {
        return None;
    }

    let lo = *data.get(*cursor)? as u16;
    *cursor += 1;
    let hi = *data.get(*cursor)? as u16;
    *cursor += 1;
    let num_children = lo | (hi << 8);

    // Validate num_children against remaining bytes to prevent OOM on corrupt data.
    // Each child needs at least 5 bytes: 1 (label_len) + 1 (label byte, empty rejected) + 3 (flags + num_children).
    const MIN_CHILD_ENCODED_LEN: usize = 5;
    let remaining = data.len().checked_sub(*cursor)?;
    let num_children = num_children as usize;
    if num_children > remaining / MIN_CHILD_ENCODED_LEN {
        return None;
    }

    let mut children: Vec<(Box<str>, TrieNode)> = Vec::with_capacity(num_children);
    for _ in 0_usize..num_children {
        let label_len = *data.get(*cursor)? as usize;
        *cursor += 1;

        // PSL rules cannot produce empty labels.
        if label_len == 0 {
            return None;
        }

        let label_end = *cursor + label_len;
        if label_end > data.len() {
            return None;
        }
        let label_bytes = &data[*cursor..label_end];
        *cursor = label_end;

        // Labels are stored as UTF-8 in the binary format (already lowercased).
        let label = core::str::from_utf8(label_bytes).ok()?;

        // Verify sort order — binary search requires strictly ascending labels.
        if let Some((prev, _)) = children.last()
            && label <= prev.as_ref()
        {
            return None;
        }

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
    let trimmed = domain.trim();
    let domain = trimmed.strip_suffix('.').unwrap_or(trimmed);
    if domain.is_empty() {
        return None;
    }

    let labels: Vec<&str> = domain.rsplit('.').collect();
    // Reject domains with empty labels (leading dots, consecutive dots)
    // and PSL sentinel labels (* and !prefix) which are internal trie nodes.
    if labels.is_empty()
        || labels
            .iter()
            .any(|label| label.is_empty() || *label == "*" || label.starts_with('!'))
    {
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

        // Record wildcard match as fallback BEFORE trying exact match.
        // This ensures wildcards are not shadowed by non-boundary exact children
        // (e.g., *.futurecms.at must still match even though "ex" exists as a child).
        if node.has_child("*") {
            // Exception rules (`!label`) cancel the wildcard for this specific label.
            label_buf.insert(0, '!');
            if node.has_child(label_buf.as_str()) {
                suffix_depth = depth;
                known = true;
            } else {
                suffix_depth = depth + 1;
                known = true;
            }
            label_buf.remove(0); // restore label for exact match below
        }

        // Try exact match — descend deeper for potentially more specific rules.
        if let Some(child) = node.child(label_buf.as_str()) {
            if child.suffix_boundary {
                suffix_depth = depth + 1;
                known = true;
            }
            node = child;
            continue;
        }

        // No exact match — wildcard (if any) was already recorded above.
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

    // -- Binary parser direct tests --

    /// Encode a trie node into binary format (mirrors build-psl.py serialization).
    fn encode_node(flags: u8, children: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(flags);
        let count = children.len() as u16;
        out.extend_from_slice(&count.to_le_bytes());
        for (label, child) in children {
            let label_bytes = label.as_bytes();
            assert!(
                label_bytes.len() <= u8::MAX as usize,
                "label length exceeds binary format limit: {}",
                label_bytes.len()
            );
            out.push(label_bytes.len() as u8);
            out.extend_from_slice(label_bytes);
            out.extend_from_slice(child);
        }
        out
    }

    #[test]
    fn parse_node_tiny_trie_with_special_labels() {
        let wildcard = encode_node(1, &[]);
        let exception = encode_node(1, &[]);
        let utf8 = encode_node(1, &[]);

        // Children sorted by label (binary search invariant).
        let data = encode_node(
            0,
            &[
                ("!city", &exception),
                ("*", &wildcard),
                ("\u{4F8B}\u{5B50}", &utf8),
            ],
        );

        let mut cursor = 0;
        let root = parse_node(&data, &mut cursor).unwrap_or_else(|| panic!("parse failed"));

        assert_eq!(cursor, data.len());
        assert!(!root.suffix_boundary);
        assert!(root.has_child("!city"));
        assert!(root.has_child("*"));
        assert!(root.has_child("\u{4F8B}\u{5B50}"));
        assert!(
            root.child("*")
                .unwrap_or_else(|| panic!("no *"))
                .suffix_boundary
        );
        assert!(
            root.child("!city")
                .unwrap_or_else(|| panic!("no !city"))
                .suffix_boundary
        );
    }

    #[test]
    fn parse_node_rejects_truncated_data() {
        // Valid header but claims 1000 children with only 3 remaining bytes.
        let data: Vec<u8> = vec![0, 0xe8, 0x03, 0, 0, 0];
        let mut cursor = 0;
        assert!(parse_node(&data, &mut cursor).is_none());
    }

    #[test]
    fn parse_node_rejects_unsorted_or_duplicate_children() {
        let leaf = encode_node(0, &[]);

        // Unsorted: "b" before "a" violates binary search invariant.
        let unsorted = encode_node(0, &[("b", &leaf), ("a", &leaf)]);
        let mut cursor = 0;
        assert!(parse_node(&unsorted, &mut cursor).is_none());

        // Duplicate: two "a" children.
        let duplicate = encode_node(0, &[("a", &leaf), ("a", &leaf)]);
        cursor = 0;
        assert!(parse_node(&duplicate, &mut cursor).is_none());
    }

    #[test]
    fn parse_node_rejects_reserved_flag_bits() {
        let data = encode_node(0b10, &[]);
        let mut cursor = 0;
        assert!(parse_node(&data, &mut cursor).is_none());
    }

    #[test]
    fn parse_node_rejects_empty_labels() {
        let leaf = encode_node(0, &[]);
        let data = encode_node(0, &[("", &leaf)]);
        let mut cursor = 0;
        assert!(parse_node(&data, &mut cursor).is_none());
    }

    // -- Lookup tests --

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
    fn multiple_trailing_dots_rejected() {
        // Only one trailing dot (FQDN root) is valid; multiple are invalid.
        assert!(lookup("example.com..").is_none());
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

    // -- Wildcard not shadowed by exact child --

    #[test]
    fn wildcard_not_shadowed_by_exact_child() {
        // PSL has: *.futurecms.at, *.ex.futurecms.at, *.in.futurecms.at
        // "ex" exists as exact child (path to *.ex.futurecms.at) but is NOT a suffix boundary.
        // The wildcard *.futurecms.at must still match — ex.futurecms.at IS a public suffix.
        let info = lookup("ex.futurecms.at").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "ex.futurecms.at");
        assert_eq!(info.registrable_domain(), None);
        assert!(info.is_known());
    }

    #[test]
    fn deeper_wildcard_under_exact_child() {
        // *.ex.futurecms.at — test.ex.futurecms.at is a suffix
        let info = lookup("site.test.ex.futurecms.at").unwrap_or_else(|| panic!("lookup failed"));
        assert_eq!(info.suffix(), "test.ex.futurecms.at");
        assert_eq!(info.registrable_domain(), Some("site.test.ex.futurecms.at"));
        assert!(info.is_known());
    }

    // -- Edge cases: sentinel labels rejected --

    #[test]
    fn wildcard_label_in_input_rejected() {
        // "*.ck" and "foo.*.ck" must not walk internal wildcard trie nodes.
        assert!(lookup("*.ck").is_none());
        assert!(lookup("foo.*.ck").is_none());
    }

    #[test]
    fn exception_label_in_input_rejected() {
        // "!www.ck" must not walk internal exception trie nodes.
        assert!(lookup("!www.ck").is_none());
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
