// "tiny" entry: ships WITHOUT the embedded PSL blob. Instead it fetches the
// prebuilt binary trie at runtime and caches it locally, so consumers always
// get the current PSL without bumping the package version. After the first
// `await load()`, the lookup API is identical (and synchronous) to the main
// entry — it reuses the same parser, so results are byte-identical.
//
// Cache: Node persists the blob to a temp dir with a TTL (survives restarts);
// browsers use CacheStorage when available; otherwise the in-process singleton
// is the only cache. All of it is best-effort — a cache failure never breaks a
// lookup, it just falls back to a network fetch.

import { lookupTrie, parseTrie, type DomainInfo, type TrieNode } from "./trie.js";

// Injected at build time (tsup `define`) as this package's "major.minor" range;
// falls back to "0.0" when run from source (tests). Pinning the CDN URL to the
// range means the tiny entry fetches PSL-data patch releases (same trie format)
// but never a future format-breaking release the shipped parser cannot read.
declare const __PSL_PKG_RANGE__: string;
const PSL_RANGE = typeof __PSL_PKG_RANGE__ !== "undefined" ? __PSL_PKG_RANGE__ : "0.0";

/** Default data source: the prebuilt trie served from this package via jsDelivr's CDN. */
export const DEFAULT_PSL_URL = `https://cdn.jsdelivr.net/npm/@structured-world/structured-public-domains@${PSL_RANGE}/dist/psl.bin`;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Options for {@link load}. */
export interface LoadOptions {
  /** Where to fetch `psl.bin` from. Defaults to {@link DEFAULT_PSL_URL}. */
  url?: string;
  /** Custom fetch implementation (e.g. for proxies/tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Enable the persistent local cache (Node file / browser CacheStorage). Default `true`. */
  cache?: boolean;
  /** Cache freshness window in milliseconds. Default 24h. */
  cacheTtlMs?: number;
  /** Node only: directory for the cache file. Defaults to an OS temp subdir. */
  cacheDir?: string;
  /** Re-fetch even if already loaded / cached. Default `false`. */
  force?: boolean;
}

const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;

let cachedBytes: Uint8Array | undefined;
let cachedTrie: TrieNode | undefined;
let inFlight: Promise<void> | undefined;

/**
 * Fetch, cache, and parse the PSL trie. Idempotent: a second call is a no-op
 * unless `force` is set. Must be awaited before {@link lookup} and friends.
 *
 * @throws if the data cannot be fetched or is implausibly small / corrupt.
 *
 * @example
 * ```ts
 * import { load, registrableDomain } from '@structured-world/structured-public-domains/tiny';
 * await load();
 * registrableDomain('sub.example.co.uk'); // "example.co.uk"
 * ```
 */
export async function load(opts: LoadOptions = {}): Promise<void> {
  if (cachedTrie !== undefined && opts.force !== true) return;
  // Dedup overlapping startup calls: the first stores the pending promise,
  // later callers await it instead of starting a second fetch/parse.
  if (inFlight !== undefined && opts.force !== true) return inFlight;
  inFlight = doLoad(opts).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function doLoad(opts: LoadOptions): Promise<void> {
  const url = opts.url ?? DEFAULT_PSL_URL;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const useCache = opts.cache ?? true;
  const doFetch = opts.fetch ?? globalThis.fetch;

  let data: Uint8Array | undefined;
  let trie: TrieNode | undefined;

  // Try the cache, but parse it here: a fresh-but-corrupt blob must not break
  // load() permanently — discard it and fall through to the network instead.
  if (useCache && opts.force !== true) {
    data = await readCache(url, ttlMs, opts.cacheDir);
    if (data !== undefined) {
      try {
        trie = parseTrie(data);
      } catch {
        data = undefined;
        await deleteCache(url, opts.cacheDir).catch(() => undefined);
      }
    }
  }

  if (trie === undefined) {
    if (typeof doFetch !== "function") {
      throw new Error("no fetch implementation available; pass `fetch` in LoadOptions");
    }
    data = await fetchBytes(doFetch, url);
    // Parse before caching so a bad network body is never persisted.
    trie = parseTrie(data);
    if (useCache) await writeCache(url, data, opts.cacheDir).catch(() => undefined);
  }

  cachedBytes = data;
  cachedTrie = trie;
}

/** Whether {@link load} has completed and the lookup API is ready. */
export function isLoaded(): boolean {
  return cachedTrie !== undefined;
}

function requireTrie(): TrieNode {
  if (cachedTrie === undefined) {
    throw new Error("PSL data not loaded — call `await load()` before lookups");
  }
  return cachedTrie;
}

/** Look up a domain. Requires a prior `await load()`. See the main entry's `lookup`. */
export function lookup(domain: string): DomainInfo | undefined {
  return lookupTrie(requireTrie(), domain);
}

/** Extract the registrable domain (eTLD+1). Requires a prior `await load()`. */
export function registrableDomain(domain: string): string | undefined {
  return lookup(domain)?.registrableDomain;
}

/** Whether a domain's suffix is a known PSL entry. Requires a prior `await load()`. */
export function isKnownSuffix(domain: string): boolean {
  return lookup(domain)?.known ?? false;
}

/** The raw binary trie blob that was loaded (defensive copy). Requires a prior `await load()`. */
export function pslData(): Uint8Array {
  if (cachedBytes === undefined) {
    throw new Error("PSL data not loaded — call `await load()` before pslData()");
  }
  return cachedBytes.slice();
}

export type { DomainInfo };

// -- fetch + cache internals --------------------------------------------------

async function fetchBytes(doFetch: typeof fetch, url: string): Promise<Uint8Array> {
  const res = await doFetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch PSL data from ${url}: ${res.status} ${res.statusText}`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  // The real trie is ~108KB; anything tiny is an error page or truncated body.
  if (data.length < 1024) {
    throw new Error(`PSL data from ${url} is implausibly small (${data.length} bytes)`);
  }
  return data;
}

/** Stable, short, filesystem-safe cache key for a URL (FNV-1a, no deps). */
function cacheKey(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function readCache(url: string, ttlMs: number, cacheDir?: string): Promise<Uint8Array | undefined> {
  try {
    return isNode ? await readNodeCache(url, ttlMs, cacheDir) : await readBrowserCache(url, ttlMs);
  } catch {
    return undefined;
  }
}

async function writeCache(url: string, data: Uint8Array, cacheDir?: string): Promise<void> {
  if (isNode) await writeNodeCache(url, data, cacheDir);
  else await writeBrowserCache(url, data);
}

/** Remove a stale/corrupt cache entry so the next load() re-fetches cleanly. */
async function deleteCache(url: string, cacheDir?: string): Promise<void> {
  if (isNode) {
    const { fs, file } = await nodeCache(url, cacheDir);
    fs.rmSync(file, { force: true });
  } else if (typeof caches !== "undefined") {
    const cache = await caches.open("structured-public-domains");
    await cache.delete(url);
  }
}

// Import Node builtins through a variable specifier so bundlers cannot statically
// resolve them (this code path only runs under Node) and esbuild does not rewrite
// the `node:` prefix to a bare `fs`/`os`/`path` that browser bundlers choke on.
const nodeRequire = (m: string): Promise<unknown> => import(/* @vite-ignore */ m);

/** Resolve the Node cache directory + file (keyed by URL) and the fs module. */
async function nodeCache(url: string, cacheDir?: string) {
  const fs = (await nodeRequire("node:fs")) as typeof import("node:fs");
  const os = (await nodeRequire("node:os")) as typeof import("node:os");
  const path = (await nodeRequire("node:path")) as typeof import("node:path");
  const dir = cacheDir ?? path.join(os.tmpdir(), "structured-public-domains-cache");
  return { fs, dir, file: path.join(dir, `psl-${cacheKey(url)}.bin`) };
}

async function readNodeCache(url: string, ttlMs: number, cacheDir?: string): Promise<Uint8Array | undefined> {
  const { fs, file } = await nodeCache(url, cacheDir);
  const stat = fs.statSync(file);
  if (Date.now() - stat.mtimeMs >= ttlMs) return undefined;
  return new Uint8Array(fs.readFileSync(file));
}

async function writeNodeCache(url: string, data: Uint8Array, cacheDir?: string): Promise<void> {
  const { fs, dir, file } = await nodeCache(url, cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  // Write to a sibling temp file then rename, so a crash or concurrent writer
  // never leaves a truncated psl.bin that would fail parseTrie on the next read.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function readBrowserCache(url: string, ttlMs: number): Promise<Uint8Array | undefined> {
  if (typeof caches === "undefined") return undefined;
  const cache = await caches.open("structured-public-domains");
  const res = await cache.match(url);
  if (res == null) return undefined;
  const cachedAt = Number(res.headers.get("x-cached-at") ?? "0");
  if (!Number.isFinite(cachedAt) || Date.now() - cachedAt >= ttlMs) return undefined;
  return new Uint8Array(await res.arrayBuffer());
}

async function writeBrowserCache(url: string, data: Uint8Array): Promise<void> {
  if (typeof caches === "undefined") return;
  const cache = await caches.open("structured-public-domains");
  // Copy into a fresh ArrayBuffer so the Response owns its bytes.
  const body = data.slice();
  await cache.put(url, new Response(body, { headers: { "x-cached-at": String(Date.now()) } }));
}
