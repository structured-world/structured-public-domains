use super::*;
use alloc::string::ToString;

// -- Image walking --
//
// The reader never parses the image, so there is no decode step to reject a
// corrupt one. What replaces those checks is a stronger property: no image,
// however malformed, may make a lookup panic or read outside the slice. The
// tests below craft images to exercise both navigation paths and then hammer
// the real one with truncations and mutations.

/// Encode a node in the format `build-psl.py` writes.
///
/// `indexed` selects which navigation mechanism the node carries, mirroring the
/// generator's `INDEX_MIN` decision so both shapes can be tested directly
/// rather than only through whatever the real list happens to contain.
fn encode_node(boundary: bool, indexed: bool, children: &[(&str, &[u8])]) -> Vec<u8> {
    let mut header = Vec::new();
    let flags = (if boundary { 0x80 } else { 0 }) | (if indexed { 0x40 } else { 0 });
    let count = children.len();
    if count < COUNT_ESCAPE as usize {
        header.push(flags | count as u8);
    } else {
        header.push(flags | COUNT_ESCAPE);
        header.extend_from_slice(&(count as u16).to_le_bytes());
    }

    let mut entries: Vec<Vec<u8>> = Vec::new();
    for (label, child) in children {
        let label_bytes = label.as_bytes();
        assert!(
            label_bytes.len() <= u8::MAX as usize,
            "label length exceeds binary format limit: {}",
            label_bytes.len()
        );
        let mut entry = Vec::new();
        entry.push(label_bytes.len() as u8);
        entry.extend_from_slice(label_bytes);
        if !indexed {
            entry.extend_from_slice(&varint_bytes(child.len()));
        }
        entry.extend_from_slice(child);
        entries.push(entry);
    }

    let mut out = header;
    if indexed {
        let mut offset = out.len() + INDEX_ENTRY * count;
        let mut index = Vec::new();
        for entry in &entries {
            index.extend_from_slice(&(offset as u32).to_le_bytes()[..INDEX_ENTRY]);
            offset += entry.len();
        }
        out.extend_from_slice(&index);
    }
    for entry in entries {
        out.extend_from_slice(&entry);
    }
    out
}

fn varint_bytes(mut value: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while value >= 0x80 {
        out.push((value & 0x7F) as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
    out
}

#[test]
fn walks_a_scanned_node() {
    // Below the index threshold: entries carry subtree lengths and are stepped
    // over one at a time.
    let leaf = encode_node(true, false, &[]);
    let image = encode_node(
        false,
        false,
        &[("ay", &leaf), ("bee", &leaf), ("cee", &leaf)],
    );
    let root = Node::root(&image);

    assert!(root.child("ay").is_some_and(|n| n.is_suffix_boundary()));
    assert!(root.child("bee").is_some_and(|n| n.is_suffix_boundary()));
    assert!(root.child("cee").is_some_and(|n| n.is_suffix_boundary()));
    assert!(root.child("dee").is_none(), "past the last label");
    assert!(root.child("a").is_none(), "before the first label");
    assert!(root.child("b").is_none(), "a prefix is not a label");
}

#[test]
fn walks_an_indexed_node() {
    // At or above the threshold the same children are reached by binary search
    // through the offset index, and must answer identically.
    let leaf = encode_node(true, false, &[]);
    let image = encode_node(
        false,
        true,
        &[("ay", &leaf), ("bee", &leaf), ("cee", &leaf)],
    );
    let root = Node::root(&image);

    assert!(root.child("ay").is_some_and(|n| n.is_suffix_boundary()));
    assert!(root.child("bee").is_some_and(|n| n.is_suffix_boundary()));
    assert!(root.child("cee").is_some_and(|n| n.is_suffix_boundary()));
    assert!(root.child("dee").is_none());
    assert!(root.child("a").is_none());
}

#[test]
fn the_two_navigation_paths_agree() {
    // The index is an optimization, not a different language: the same children
    // must resolve the same way whichever mechanism the node carries.
    let leaf = encode_node(true, false, &[]);
    let children: Vec<(&str, &[u8])> = ["ac", "co", "gov", "net", "org", "sch"]
        .iter()
        .map(|l| (*l, leaf.as_slice()))
        .collect();
    let scanned = encode_node(false, false, &children);
    let indexed = encode_node(false, true, &children);

    for probe in ["ac", "co", "gov", "net", "org", "sch", "zz", "a", "n", ""] {
        assert_eq!(
            Node::root(&scanned).child(probe).is_some(),
            Node::root(&indexed).child(probe).is_some(),
            "disagreement on {probe:?}"
        );
    }
}

#[test]
fn a_node_with_many_children_uses_the_escape_count() {
    // Past 62 children the count leaves the header byte for a u16, which is the
    // shape every indexed node in the real image has.
    let leaf = encode_node(true, false, &[]);
    let labels: Vec<String> = (0..70).map(|i| format!("l{i:03}")).collect();
    let children: Vec<(&str, &[u8])> = labels
        .iter()
        .map(|l| (l.as_str(), leaf.as_slice()))
        .collect();
    let image = encode_node(false, true, &children);

    let root = Node::root(&image);
    assert!(root.child("l000").is_some());
    assert!(root.child("l069").is_some());
    assert!(root.child("l070").is_none());
}

#[test]
fn a_truncated_image_never_panics() {
    // Every prefix of the real image is a corrupt image. None of them may read
    // outside the slice or panic; returning nothing is the only acceptable
    // failure.
    for cut in [0, 1, 2, 3, 7, 64, 1000, 50_000, PSL_DATA.len() - 1] {
        probe_every_depth(&PSL_DATA[..cut]);
    }
}

/// Walk several multi-label paths, not just the root's children.
///
/// `child` hands back a node without reading its header, so corruption one
/// level down is only reached by descending. A probe that stops at the root
/// would pass on an image whose second level is unreadable.
fn probe_every_depth(image: &[u8]) {
    let root = Node::root(image);
    let _ = root.is_suffix_boundary();
    let _ = root.has_wildcard_child();

    for path in [
        ["uk", "co", "example"],
        ["com", "example", "www"],
        ["jp", "tokyo", "metro"],
        ["zzzz", "nope", "gone"],
        ["*", "!city", "x"],
    ] {
        let mut node = root;
        for label in path {
            let _ = node.is_suffix_boundary();
            let _ = node.has_wildcard_child();
            match node.child(label) {
                Some(next) => node = next,
                None => break,
            }
        }
    }
}

#[test]
fn a_mutated_image_never_panics() {
    // Flipping bytes anywhere reachable from the root, including the header and
    // index of the widest node, must not turn a lookup into a crash.
    let mut image = PSL_DATA.to_vec();
    for step in 0..2048 {
        let at = (step * 53) % image.len();
        let original = image[at];
        image[at] = original.wrapping_add(0x9E);
        // `lookup` reads the embedded image, so it cannot be pointed at this
        // one; `probe_every_depth` covers the same reads a lookup performs —
        // the wildcard bit, the exception probe and the descent — against the
        // mutated bytes.
        probe_every_depth(&image);
        image[at] = original;
    }
}

#[test]
fn the_embedded_image_indexes_exactly_the_wide_nodes() {
    // The generator decides which nodes carry an index and the reader trusts a
    // header bit, so nothing in the code would notice if the two drifted apart.
    // This walks the real image and checks the rule holds on every node.
    fn visit(node: Node<'_>, seen: &mut usize) {
        let header = node.header().unwrap_or_else(|| panic!("unreadable node"));
        assert_eq!(
            header.indexed,
            header.children >= INDEX_MIN,
            "node at {} has {} children but indexed={}",
            node.at,
            header.children,
            header.indexed
        );
        // The wildcard bit is read instead of searching, so a generator that set
        // it wrong would silently change which rules apply — and only for the
        // domains under that one node.
        assert_eq!(
            header.wildcard,
            node.has_child("*"),
            "node at {} claims wildcard={} but the search disagrees",
            node.at,
            header.wildcard
        );
        *seen += 1;

        let mut at = header.body;
        for i in 0..header.children {
            let (_, child, next) = if header.indexed {
                let entry_at = node
                    .index_entry(&header, i)
                    .unwrap_or_else(|| panic!("bad index slot"));
                node.entry(entry_at, false)
                    .unwrap_or_else(|| panic!("bad indexed entry"))
            } else {
                node.entry(at, true)
                    .unwrap_or_else(|| panic!("bad scanned entry"))
            };
            at = next;
            visit(child, seen);
        }
    }

    let mut seen = 0;
    visit(Node::root(PSL_DATA), &mut seen);
    assert!(seen > 10_000, "walked only {seen} nodes");
}

#[test]
fn the_embedded_image_keeps_its_children_sorted() {
    // Both navigation paths assume ascending label order: the binary search
    // needs it to be correct, and the scan uses it to stop early.
    fn visit(node: Node<'_>) {
        let Some(header) = node.header() else { return };
        let mut previous: Option<Vec<u8>> = None;
        let mut at = header.body;
        for i in 0..header.children {
            let (label, child, next) = if header.indexed {
                let entry_at = node
                    .index_entry(&header, i)
                    .unwrap_or_else(|| panic!("bad index slot"));
                node.entry(entry_at, false)
                    .unwrap_or_else(|| panic!("bad indexed entry"))
            } else {
                node.entry(at, true)
                    .unwrap_or_else(|| panic!("bad scanned entry"))
            };
            if let Some(prev) = &previous {
                assert!(
                    prev.as_slice() < label,
                    "children out of order at node {}",
                    node.at
                );
            }
            previous = Some(label.to_vec());
            at = next;
            visit(child);
        }
    }

    visit(Node::root(PSL_DATA));
}

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
