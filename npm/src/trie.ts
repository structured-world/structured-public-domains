// Pure, environment-agnostic PSL trie: search the compact binary image in
// place and run lookups. No I/O, no globals — the byte source is injected by
// the caller (see index.ts), so this module bundles identically for Node and
// the browser.
//
// The algorithm is a faithful port of the Rust crate's `src/trie.rs`; the two
// are kept byte-identical by the parity suite in `index.test.ts`.

/** Result of a PSL lookup. */
export interface DomainInfo {
  /** The public suffix (e.g. `"co.uk"`, `"com"`, `"github.io"`). */
  readonly suffix: string;
  /** The registrable domain (eTLD+1), or `undefined` if the input is itself a suffix. */
  readonly registrableDomain: string | undefined;
  /** Whether the suffix matched an explicit PSL rule (vs the `*` fallback). */
  readonly known: boolean;
}

/**
 * A node, addressed by where it starts in the image.
 *
 * Nothing is decoded up front: the image is the data structure. Carrying an
 * offset rather than a decoded object is what lets a lookup touch only the
 * handful of nodes on its path, instead of the ~11,000 the old parse built
 * before answering the first question.
 */
export interface TrieNode {
  readonly image: Uint8Array;
  /** Offset of this node's header byte within `image`. */
  readonly at: number;
}

/** A node's decoded header. See the format note on {@link parseTrie}. */
interface Header {
  readonly suffixBoundary: boolean;
  readonly indexed: boolean;
  /** Whether a `*` child exists, answered without searching for it. */
  readonly wildcard: boolean;
  readonly children: number;
  /** Offset of the first byte after the header. */
  readonly body: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Child count that no longer fits the header's 5-bit field. */
const COUNT_ESCAPE = 0x1f;

/** Width of an index entry: a u24 offset from the node's first byte. */
const INDEX_ENTRY = 3;

/**
 * Take the image as the trie root.
 *
 * Format, written by `scripts/build-psl.py`:
 *
 *     node   = [header][index?][entry ...]
 *     header = u8: bit 7 = suffix boundary
 *                  bit 6 = index present
 *                  bit 5 = a "*" wildcard child is present
 *                  bits 0-4 = child count, or 0x1F meaning a u16_le count follows
 *     index  = [entry_offset:u24_le] * count, relative to the node's first byte
 *     entry  = [label_len:u8][label][subtree_len:varint when unindexed][child]
 *
 * There is no decode step and so nothing to validate up front. A malformed
 * image yields no match rather than an exception: every read is bounds-checked
 * and returns `undefined` past the end.
 */
export function parseTrie(data: Uint8Array): TrieNode {
  return { image: data, at: 0 };
}

function headerOf(node: TrieNode): Header | undefined {
  const byte = node.image[node.at];
  if (byte === undefined) return undefined;
  const packed = byte & COUNT_ESCAPE;
  let children: number;
  let body: number;
  if (packed === COUNT_ESCAPE) {
    const lo = node.image[node.at + 1];
    const hi = node.image[node.at + 2];
    if (lo === undefined || hi === undefined) return undefined;
    children = lo | (hi << 8);
    body = node.at + 3;
  } else {
    children = packed;
    body = node.at + 1;
  }
  return {
    suffixBoundary: (byte & 0x80) !== 0,
    indexed: (byte & 0x40) !== 0,
    wildcard: (byte & 0x20) !== 0,
    children,
    body,
  };
}

/** Read a LEB128 length at `at`; returns the value and the offset after it. */
function varint(image: Uint8Array, at: number): readonly [number, number] | undefined {
  let value = 0;
  let shift = 0;
  for (let step = 0; step < 5; step++) {
    const byte = image[at + step];
    if (byte === undefined) return undefined;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, at + step + 1];
    shift += 7;
  }
  return undefined;
}

interface Entry {
  readonly label: string;
  readonly child: TrieNode;
  /** Offset of the next sibling entry; only meaningful when `skippable`. */
  readonly next: number;
}

/**
 * Read the entry at `at`.
 *
 * `skippable` asks for the subtree length that an unindexed node writes after
 * the label, which is what lets a scan step to the next sibling.
 */
function entryAt(node: TrieNode, at: number, skippable: boolean): Entry | undefined {
  const len = node.image[at];
  if (len === undefined) return undefined;
  const labelEnd = at + 1 + len;
  if (labelEnd > node.image.length) return undefined;
  const label = decodeLabel(node.image, at + 1, labelEnd);

  if (!skippable) {
    return { label, child: { image: node.image, at: labelEnd }, next: labelEnd };
  }
  const read = varint(node.image, labelEnd);
  if (read === undefined) return undefined;
  const [subtreeLen, childAt] = read;
  const next = childAt + subtreeLen;
  if (next > node.image.length) return undefined;
  return { label, child: { image: node.image, at: childAt }, next };
}

/** Offset of the `i`-th entry, read from the node's index. */
function indexEntry(node: TrieNode, header: Header, i: number): number | undefined {
  const slot = header.body + i * INDEX_ENTRY;
  const b0 = node.image[slot];
  const b1 = node.image[slot + 1];
  const b2 = node.image[slot + 2];
  if (b0 === undefined || b1 === undefined || b2 === undefined) return undefined;
  const at = node.at + (b0 | (b1 << 8) | (b2 << 16));
  return at < node.image.length ? at : undefined;
}

/**
 * Decode a label's UTF-8 bytes to a string.
 *
 * PSL labels are ~96% ASCII (punycode / `a-z0-9-`), so an ASCII fast path via
 * `fromCharCode` skips TextDecoder's per-call overhead and roughly halves parse
 * time; the ~4% of Unicode U-label rules fall back to a real UTF-8 decode.
 */
function decodeLabel(data: Uint8Array, start: number, end: number): string {
  for (let i = start; i < end; i++) {
    if (data[i]! >= 0x80) return utf8.decode(data.subarray(start, end));
  }
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(data[i]!);
  return s;
}

/**
 * Find a child by label.
 *
 * Wide nodes are binary-searched through the offset index; the rest are
 * scanned, stepping over each subtree by its recorded length. Children are
 * written in ascending label order, so the scan stops as soon as it passes the
 * label it is looking for.
 *
 * Labels are sorted by Rust's `str` ordering (UTF-8 byte lexicographic). For
 * the BMP code points the PSL uses, JS string comparison matches that order,
 * so a plain `<`/`>` comparator is correct.
 */
function childOf(node: TrieNode, label: string): TrieNode | undefined {
  const header = headerOf(node);
  if (header === undefined) return undefined;

  if (header.indexed) {
    let lo = 0;
    let hi = header.children;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = indexEntry(node, header, mid);
      if (at === undefined) return undefined;
      const entry = entryAt(node, at, false);
      if (entry === undefined) return undefined;
      if (entry.label === label) return entry.child;
      if (entry.label < label) lo = mid + 1;
      else hi = mid;
    }
    return undefined;
  }

  let at = header.body;
  for (let i = 0; i < header.children; i++) {
    const entry = entryAt(node, at, true);
    if (entry === undefined) return undefined;
    if (entry.label === label) return entry.child;
    if (entry.label > label) return undefined;
    at = entry.next;
  }
  return undefined;
}

function hasChild(node: TrieNode, label: string): boolean {
  return childOf(node, label) !== undefined;
}

/** Whether a node has a `*` child, from the header bit rather than a search. */
function hasWildcardChild(node: TrieNode): boolean {
  return headerOf(node)?.wildcard ?? false;
}

function isSuffixBoundary(node: TrieNode): boolean {
  return headerOf(node)?.suffixBoundary ?? false;
}

/**
 * Walk the whole image, throwing if any part of it is unreadable.
 *
 * Lookups do not need this: they read what they touch and return no match on
 * anything malformed. It exists for the one caller that takes an image from
 * somewhere other than the bundle — {@link tiny}, which downloads and caches it
 * — where a corrupt blob should be discarded and refetched rather than silently
 * answering "no such suffix" for every domain.
 *
 * Checks each node accounts for its own bytes, that labels are non-empty and
 * strictly ascending, and that the image ends exactly where the root's subtree
 * does.
 */
export function validateTrie(data: Uint8Array): void {
  const end = validateNode({ image: data, at: 0 });
  if (end !== data.length) {
    throw new Error("PSL data: trailing bytes after root node");
  }
}

/** Validate one node; returns the offset just past its subtree. */
function validateNode(node: TrieNode): number {
  const header = headerOf(node);
  if (header === undefined) {
    throw new Error("PSL data: unexpected end of data");
  }

  let at = header.body;
  if (header.indexed) at += header.children * INDEX_ENTRY;

  let previous: string | undefined;
  let sawWildcard = false;
  for (let i = 0; i < header.children; i++) {
    const len = node.image[at];
    if (len === undefined) throw new Error("PSL data: unexpected end of data");
    if (len === 0) throw new Error("PSL data: empty label");

    const labelEnd = at + 1 + len;
    if (labelEnd > node.image.length) {
      throw new Error("PSL data: label runs past end of data");
    }
    const label = decodeLabel(node.image, at + 1, labelEnd);
    if (previous !== undefined && !(label > previous)) {
      throw new Error("PSL data: children not strictly sorted");
    }
    previous = label;
    if (label === "*") sawWildcard = true;

    // An indexed node writes no subtree length: the next entry's offset comes
    // from the index, and the child begins right after the label.
    let childAt = labelEnd;
    if (!header.indexed) {
      const read = varint(node.image, labelEnd);
      if (read === undefined) throw new Error("PSL data: malformed subtree length");
      childAt = read[1];
    }

    const childEnd = validateNode({ image: node.image, at: childAt });
    if (!header.indexed) {
      const read = varint(node.image, labelEnd)!;
      if (childEnd !== read[1] + read[0]) {
        throw new Error("PSL data: subtree length disagrees with its contents");
      }
    }
    at = childEnd;
  }

  // The wildcard bit is read instead of searched, so an image whose bit
  // disagrees with its children would answer with the wrong rules.
  if (header.wildcard !== sawWildcard) {
    throw new Error("PSL data: wildcard flag disagrees with the children");
  }
  return at;
}
/**
 * Look up `domain` against the parsed PSL trie.
 *
 * Returns `undefined` for empty input or labels that are empty / the PSL
 * sentinels (`*`, `!prefix`); otherwise always returns a result (unknown TLDs
 * fall back to the implicit `*` rule with `known: false`).
 */
export function lookupTrie(root: TrieNode, domain: string): DomainInfo | undefined {
  const trimmed = domain.trim();
  // Strip a single FQDN-root trailing dot (multiple dots are left to fail below).
  const stripped = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (stripped === "") return undefined;

  // Labels TLD-first, mirroring Rust's `rsplit('.')`.
  const labels = stripped.split(".").reverse();

  // Reject empty labels (leading/consecutive dots) and sentinel labels that
  // name internal trie nodes (`*`, `!…`) so callers cannot walk them directly.
  for (const label of labels) {
    if (label === "" || label === "*" || label.startsWith("!")) return undefined;
  }

  let node = root;
  let suffixDepth = 0;
  let known = false;

  for (let depth = 0; depth < labels.length; depth++) {
    const label = labels[depth]!.toLowerCase();

    // Record a wildcard match as a fallback BEFORE the exact match, so the
    // wildcard is not shadowed by a non-boundary exact child on the same path.
    if (hasWildcardChild(node)) {
      // An exception rule (`!label`) cancels the wildcard for this label only.
      if (hasChild(node, "!" + label)) {
        suffixDepth = depth;
      } else {
        suffixDepth = depth + 1;
      }
      known = true;
    }

    // Exact match — descend for potentially more specific rules.
    const child = childOf(node, label);
    if (child !== undefined) {
      if (isSuffixBoundary(child)) {
        suffixDepth = depth + 1;
        known = true;
      }
      node = child;
      continue;
    }

    // No exact match — any wildcard was already recorded above.
    break;
  }

  if (suffixDepth === 0) {
    // No rule matched — prevailing `*` rule: the TLD is the suffix.
    suffixDepth = 1;
    known = false;
  }

  const suffix = labels
    .slice(0, suffixDepth)
    .reverse()
    .map((l) => l.toLowerCase())
    .join(".");

  const registrableDomain =
    labels.length > suffixDepth ? `${labels[suffixDepth]!.toLowerCase()}.${suffix}` : undefined;

  return { suffix, registrableDomain, known };
}
