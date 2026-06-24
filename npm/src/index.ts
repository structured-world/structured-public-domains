// Public API for @structured-world/structured-public-domains.
//
// The compact binary PSL trie is embedded as base64 in ./psl-data.cjs (a single
// shared file imported by both the ESM and CJS builds). It is decoded and
// parsed lazily on first use, then cached for the process lifetime — the JS
// mirror of the Rust crate's `OnceLock`. Everything here is synchronous: no
// init(), no fetch, no fs, so the package drops straight into Node, browsers,
// and bundlers, and composes cleanly into downstream libraries.

import { PSL_BASE64 } from "./psl-data.cjs";
import { lookupTrie, parseTrie, type DomainInfo, type TrieNode } from "./trie.js";

let cachedBytes: Uint8Array | undefined;
let cachedTrie: TrieNode | undefined;

/** Decode base64 to bytes using the runtime's native decoder (Node or browser). */
function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    // Copy out of Node's pooled Buffer into a standalone, exactly-sized array.
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytes(): Uint8Array {
  return (cachedBytes ??= decodeBase64(PSL_BASE64));
}

function trie(): TrieNode {
  return (cachedTrie ??= parseTrie(bytes()));
}

/**
 * Look up a domain in the Public Suffix List.
 *
 * Returns `undefined` for empty or invalid input (empty labels, or the PSL
 * sentinel labels `*` / `!prefix`).
 *
 * @example
 * ```ts
 * const info = lookup("www.example.co.uk");
 * // info.suffix            → "co.uk"
 * // info.registrableDomain → "example.co.uk"
 * // info.known             → true
 * ```
 */
export function lookup(domain: string): DomainInfo | undefined {
  return lookupTrie(trie(), domain);
}

/**
 * Extract the registrable domain (eTLD+1).
 *
 * Returns `undefined` if the domain is itself a public suffix, or the input is
 * invalid.
 */
export function registrableDomain(domain: string): string | undefined {
  return lookup(domain)?.registrableDomain;
}

/** Check whether a domain's suffix is a known (explicit) entry in the PSL. */
export function isKnownSuffix(domain: string): boolean {
  return lookup(domain)?.known ?? false;
}

/**
 * The raw compact binary PSL trie (DFS preorder) embedded in this package.
 *
 * Returns a defensive copy so callers can hand the blob to their own parser
 * without risking the cached singleton. The format matches the Rust crate's
 * `src/psl.bin`; see `scripts/build-psl.py` for the layout.
 */
export function pslData(): Uint8Array {
  return bytes().slice();
}

export type { DomainInfo };
