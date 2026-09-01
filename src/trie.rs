//! PSL trie: search the embedded binary image in place.

use alloc::string::String;
use alloc::vec::Vec;

/// Compact binary PSL trie (DFS preorder, uncompressed).
///
/// `include_bytes!` puts this in the binary's read-only data, which the loader
/// maps on a hosted target and the linker places in flash on a bare-metal one.
/// Either way it is already addressable memory, so lookups read it where it
/// lies rather than decoding it into a heap structure first: no allocation, no
/// initialization, and nothing to synchronize on the first call.
const PSL_DATA: &[u8] = include_bytes!("psl.bin");

/// Child count at which the generator gives a node an offset index instead of
/// per-entry subtree lengths.
///
/// The reader does not consult this: it takes each node as it finds it, from
/// the header bit. The constant exists so a test can hold the embedded image to
/// the rule and catch a drift between here and `INDEX_MIN` in
/// `scripts/build-psl.py`, which nothing else would notice.
#[cfg(test)]
const INDEX_MIN: usize = 64;

/// Child count that no longer fits the header's 5-bit field.
const COUNT_ESCAPE: u8 = 0x1F;

/// Width of an index entry: a `u24` offset from the node's first byte.
const INDEX_ENTRY: usize = 3;

/// A node, addressed by where it starts in the image.
///
/// Copying one costs two words and no allocation, so descending the trie is a
/// pointer bump rather than a dereference chain.
#[derive(Debug, Clone, Copy)]
struct Node<'a> {
    image: &'a [u8],
    /// Offset of this node's header byte within `image`.
    at: usize,
}

/// A node's decoded header: what the first one to three bytes say.
struct Header {
    suffix_boundary: bool,
    indexed: bool,
    /// Whether a `*` child exists, answered without searching for it.
    ///
    /// A lookup must ask this of every node it passes, because a wildcard rule
    /// outranks a non-boundary exact match, and the answer is almost always no.
    /// Reading it from the header rather than searching removes one search per
    /// level, which was half of all the searching a lookup did.
    wildcard: bool,
    children: usize,
    /// Offset of the first byte after the header, relative to the image.
    body: usize,
}

impl<'a> Node<'a> {
    fn root(image: &'a [u8]) -> Self {
        Self { image, at: 0 }
    }

    fn header(&self) -> Option<Header> {
        let byte = *self.image.get(self.at)?;
        let packed = byte & COUNT_ESCAPE;
        let (children, body) = if packed == COUNT_ESCAPE {
            let lo = *self.image.get(self.at + 1)? as usize;
            let hi = *self.image.get(self.at + 2)? as usize;
            (lo | (hi << 8), self.at + 3)
        } else {
            (packed as usize, self.at + 1)
        };
        Some(Header {
            suffix_boundary: byte & 0x80 != 0,
            indexed: byte & 0x40 != 0,
            wildcard: byte & 0x20 != 0,
            children,
            body,
        })
    }

    fn is_suffix_boundary(&self) -> bool {
        self.header().is_some_and(|h| h.suffix_boundary)
    }

    /// Read the entry at `at`: its label and the node that follows it.
    ///
    /// `skippable` asks for the subtree length that an unindexed node writes
    /// after the label, and returns where the next sibling entry begins.
    fn entry(&self, at: usize, skippable: bool) -> Option<(&'a [u8], Node<'a>, usize)> {
        let len = *self.image.get(at)? as usize;
        let label_end = at.checked_add(1)?.checked_add(len)?;
        let label = self.image.get(at + 1..label_end)?;
        if !skippable {
            return Some((
                label,
                Node {
                    image: self.image,
                    at: label_end,
                },
                label_end,
            ));
        }
        let (subtree_len, child_at) = varint(self.image, label_end)?;
        let next = child_at.checked_add(subtree_len)?;
        if next > self.image.len() {
            return None;
        }
        Some((
            label,
            Node {
                image: self.image,
                at: child_at,
            },
            next,
        ))
    }

    /// Find a child by label.
    ///
    /// Wide nodes are binary-searched through the offset index; the rest are
    /// scanned, stepping over each subtree by its recorded length. Children are
    /// written in ascending label order, so the scan stops as soon as it passes
    /// the label it is looking for.
    fn child(&self, label: &str) -> Option<Node<'a>> {
        let header = self.header()?;
        let needle = label.as_bytes();

        if header.indexed {
            let (mut lo, mut hi) = (0, header.children);
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                let entry_at = self.index_entry(&header, mid)?;
                let (found, child, _) = self.entry(entry_at, false)?;
                match found.cmp(needle) {
                    core::cmp::Ordering::Less => lo = mid + 1,
                    core::cmp::Ordering::Greater => hi = mid,
                    core::cmp::Ordering::Equal => return Some(child),
                }
            }
            return None;
        }

        let mut at = header.body;
        for _ in 0..header.children {
            let (found, child, next) = self.entry(at, true)?;
            match found.cmp(needle) {
                core::cmp::Ordering::Less => at = next,
                core::cmp::Ordering::Greater => return None,
                core::cmp::Ordering::Equal => return Some(child),
            }
        }
        None
    }

    /// Offset of the `i`-th entry, read from the node's index.
    fn index_entry(&self, header: &Header, i: usize) -> Option<usize> {
        let slot = header.body.checked_add(i.checked_mul(INDEX_ENTRY)?)?;
        let bytes = self.image.get(slot..slot + INDEX_ENTRY)?;
        let relative = bytes[0] as usize | ((bytes[1] as usize) << 8) | ((bytes[2] as usize) << 16);
        let at = self.at.checked_add(relative)?;
        (at < self.image.len()).then_some(at)
    }

    fn has_child(&self, label: &str) -> bool {
        self.child(label).is_some()
    }

    /// Whether this node has a `*` child, from the header bit rather than a
    /// search.
    fn has_wildcard_child(&self) -> bool {
        self.header().is_some_and(|h| h.wildcard)
    }
}

/// Read a LEB128 length starting at `at`, returning it and the offset after it.
///
/// Bounded at five bytes: the image cannot exceed `u32`, so a longer sequence
/// is corrupt rather than merely large.
fn varint(image: &[u8], at: usize) -> Option<(usize, usize)> {
    let mut value: usize = 0;
    let mut shift = 0;
    for step in 0..5 {
        let byte = *image.get(at + step)?;
        value |= ((byte & 0x7F) as usize) << shift;
        if byte & 0x80 == 0 {
            return Some((value, at + step + 1));
        }
        shift += 7;
    }
    None
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

    let mut node = Node::root(PSL_DATA);
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
        if node.has_wildcard_child() {
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
            if child.is_suffix_boundary() {
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

    // Built directly rather than collected into a `Vec<String>` and joined: the
    // vector and every string in it existed only to be concatenated, so on a
    // three-label suffix that was four allocations to produce one.
    let mut suffix = String::new();
    for label in labels[..suffix_depth].iter().rev() {
        if !suffix.is_empty() {
            suffix.push('.');
        }
        suffix.extend(label.chars().flat_map(char::to_lowercase));
    }

    let registrable = if labels.len() > suffix_depth {
        // eTLD+1: the registrable label, then the suffix already built above.
        let mut reg = String::with_capacity(labels[suffix_depth].len() + 1 + suffix.len());
        reg.extend(labels[suffix_depth].chars().flat_map(char::to_lowercase));
        reg.push('.');
        reg.push_str(&suffix);
        Some(reg)
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
mod tests;
