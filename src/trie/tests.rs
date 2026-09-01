use super::*;
use alloc::string::ToString;
use alloc::vec;

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
fn parse_trie_accepts_an_image_it_consumes_entirely() {
    let data = encode_node(1, &[]);
    assert!(parse_trie(&data).is_some());
}

#[test]
fn parse_trie_rejects_trailing_bytes() {
    // The root parses on its own, so only the whole-image check can catch this.
    // Trailing bytes mean the image is not what the encoder produced, and
    // ignoring the remainder would silently accept a truncated or spliced file.
    let mut data = encode_node(1, &[]);
    data.push(0);
    assert!(parse_node(&data, &mut 0).is_some(), "the root still parses");
    assert!(parse_trie(&data).is_none(), "the image as a whole must not");
}

#[test]
fn parse_trie_rejects_an_image_whose_root_is_malformed() {
    // Reserved flag bits are undefined, so the root fails before the
    // whole-image check is reached.
    assert!(parse_trie(&[0xff, 0, 0]).is_none());
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
