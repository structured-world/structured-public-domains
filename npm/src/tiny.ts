// "tiny" entry: ships WITHOUT the embedded PSL blob. Instead it fetches the
// prebuilt binary trie at runtime and caches it locally, so consumers always
// get the current PSL without bumping the package version. After the first
// `await load()`, the lookup API is identical (and synchronous) to the main
// entry — it reuses the same parser, so results are byte-identical.
//
// Cache: wherever IndexedDB exists (browser windows and workers, in secure and
// plain-http contexts alike) the blob is stored there with a TTL; Node persists
// it to a temp dir instead; otherwise the in-process singleton is the only
// cache. All of it is best-effort — a cache failure never breaks a lookup, it
// just falls back to a network fetch.

import {
  lookupTrie,
  parseTrie,
  validateTrie,
  type DomainInfo,
  type TrieNode,
} from "./trie.js";

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
  /** Enable the persistent local cache (IndexedDB where available, else a Node file). Default `true`. */
  cache?: boolean;
  /** Cache freshness window in milliseconds. Default 24h. */
  cacheTtlMs?: number;
  /** Node file cache only: directory for the cache file. Defaults to an OS temp subdir. */
  cacheDir?: string;
  /** Re-fetch even if already loaded / cached. Default `false`. */
  force?: boolean;
}

const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;

let cachedBytes: Uint8Array | undefined;
let cachedTrie: TrieNode | undefined;
let inFlight: Promise<void> | undefined;
// Monotonic load generation + the promise of the most recently STARTED load.
// Only the latest generation commits; any superseded load mirrors the latest
// load's outcome (resolves iff it committed, rejects on its failure) instead of
// committing stale data, hanging behind it, or reporting a false success.
let latestGen = 0;
let latestSettled: Promise<void> | undefined;

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
export function load(opts: LoadOptions = {}): Promise<void> {
  if (cachedTrie !== undefined && opts.force !== true) return Promise.resolve();
  // Non-forced callers dedup onto the in-flight load (one fetch for concurrent
  // startups). A forced refresh starts its own load instead of waiting, so a
  // stuck initial request can't block recovery via a healthy mirror.
  if (inFlight !== undefined && opts.force !== true) return inFlight;

  const gen = ++latestGen;
  const pending = doLoad(opts, gen);
  latestSettled = pending;
  inFlight = pending;
  // Clear the in-flight slot once this load settles. The `.catch` keeps this
  // bookkeeping copy from surfacing as an unhandled rejection — the real
  // rejection is still delivered to the `pending` returned to the caller.
  pending
    .finally(() => {
      if (inFlight === pending) inFlight = undefined;
    })
    .catch(() => undefined);
  return pending;
}

// Await the authoritative (latest) load's outcome — used by a superseded load to
// mirror it. Never called for the latest load itself, so it can't await itself.
function mirrorLatest(): Promise<void> {
  return latestSettled ?? Promise.resolve();
}

async function doLoad(opts: LoadOptions, gen: number): Promise<void> {
  let data: Uint8Array;
  let trie: TrieNode;
  try {
    [data, trie] = await fetchAndParse(opts);
  } catch (err) {
    // Authoritative failure propagates; a superseded load mirrors the latest.
    if (gen !== latestGen) return mirrorLatest();
    throw err;
  }
  // A newer load superseded this one: don't commit stale data — mirror the
  // latest load's outcome (it may still be loading, have committed, or failed).
  if (gen !== latestGen) return mirrorLatest();
  cachedBytes = data;
  cachedTrie = trie;
}

async function fetchAndParse(opts: LoadOptions): Promise<[Uint8Array, TrieNode]> {
  const url = opts.url ?? DEFAULT_PSL_URL;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const useCache = opts.cache ?? true;
  const doFetch = opts.fetch ?? globalThis.fetch;

  // Try the cache, but parse it here: a fresh-but-corrupt blob must not break
  // load() permanently — discard it and fall through to the network instead.
  if (useCache && opts.force !== true) {
    const cached = await readCache(url, ttlMs, opts.cacheDir);
    if (cached !== undefined) {
      try {
        validateTrie(cached);
        return [cached, parseTrie(cached)];
      } catch {
        await deleteCache(url, opts.cacheDir).catch(() => undefined);
      }
    }
  }

  if (typeof doFetch !== "function") {
    throw new Error("no fetch implementation available; pass `fetch` in LoadOptions");
  }
  const data = await fetchBytes(doFetch, url);
  // Validate before caching so a bad network body is never persisted.
  validateTrie(data);
  const trie = parseTrie(data);
  if (useCache) await writeCache(url, data, opts.cacheDir).catch(() => undefined);
  return [data, trie];
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

// IndexedDB is looked up per call rather than captured at import, so a runtime
// that installs it late (or a test that stubs it) is honoured.
function idbFactory(): IDBFactory | undefined {
  return typeof indexedDB !== "undefined" ? indexedDB : undefined;
}

/**
 * The IndexedDB key for `url`: the resource it names, not how it is spelled.
 * fetch() resolves a relative URL against the document or worker, so two pages
 * loading "psl.bin" from different directories fetch different files; keyed by
 * the raw string they would share one entry and one page would get the other's
 * rules. Outside a page there is no base and the URL is used as given.
 */
function idbKey(url: string): string {
  if (typeof location === "undefined") return url;
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

async function readCache(url: string, ttlMs: number, cacheDir?: string): Promise<Uint8Array | undefined> {
  try {
    const idb = idbFactory();
    if (idb !== undefined) return await readIdbCache(idb, idbKey(url), ttlMs);
    return isNode ? await readNodeCache(url, ttlMs, cacheDir) : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(url: string, data: Uint8Array, cacheDir?: string): Promise<void> {
  const idb = idbFactory();
  if (idb !== undefined) await writeIdbCache(idb, idbKey(url), data);
  else if (isNode) await writeNodeCache(url, data, cacheDir);
}

/** Remove a stale/corrupt cache entry so the next load() re-fetches cleanly. */
async function deleteCache(url: string, cacheDir?: string): Promise<void> {
  const idb = idbFactory();
  if (idb !== undefined) {
    const key = idbKey(url);
    await idbRun(idb, "readwrite", (store) => store.delete(key));
  } else if (isNode) {
    const { fs, file } = await nodeCache(url, cacheDir);
    fs.rmSync(file, { force: true });
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
  // An mtime can sit ahead of Date.now(): it keeps the sub-millisecond part the
  // clock drops, and a filesystem clock can run ahead. Age never goes below 0,
  // so a zero TTL means expired rather than "written in the future".
  if (Math.max(0, Date.now() - stat.mtimeMs) >= ttlMs) return undefined;
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

const IDB_NAME = "structured-public-domains";
const IDB_STORE = "psl";

/** One cached blob, keyed by its source URL in {@link IDB_STORE}. */
interface IdbEntry {
  bytes: Uint8Array;
  cachedAt: number;
}

function idbOpen(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

/**
 * How long load() waits on one cache operation. An open has no deadline of its
 * own: it queues behind any blocked upgrade or deletion of the database, and
 * some engines never answer at all, so without this a cache could hold load()
 * off the network indefinitely. Past it the operation counts as a miss.
 */
const IDB_DEADLINE_MS = 1000;

/**
 * Run one request in its own transaction and resolve with its result once the
 * transaction commits, so a write is durable before load() reports success.
 * The connection is closed afterwards to never hold up another tab's upgrade.
 * An operation that outlives the deadline still runs to completion and closes
 * its connection; only load() stops waiting for it.
 */
function idbRun<T>(
  idb: IDBFactory,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const work = idbOpen(idb).then(async (db) => {
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode);
        const req = op(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error ?? new Error("IndexedDB request failed"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      });
    } finally {
      db.close();
    }
  });
  return withDeadline(work, IDB_DEADLINE_MS);
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`IndexedDB did not answer within ${ms}ms`)), ms);
  });
  // Once the deadline wins nobody awaits `work`; its late failure is not news.
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function readIdbCache(idb: IDBFactory, url: string, ttlMs: number): Promise<Uint8Array | undefined> {
  const entry: unknown = await idbRun(idb, "readonly", (store) => store.get(url));
  // Storage is origin-scoped and outlives this code, so a value of any other
  // shape is a miss that the refetch overwrites, not something to trust.
  if (typeof entry !== "object" || entry === null) return undefined;
  const { bytes, cachedAt } = entry as Partial<IdbEntry>;
  if (!(bytes instanceof Uint8Array) || typeof cachedAt !== "number") return undefined;
  if (!Number.isFinite(cachedAt) || Date.now() - cachedAt >= ttlMs) return undefined;
  return bytes;
}

async function writeIdbCache(idb: IDBFactory, url: string, data: Uint8Array): Promise<void> {
  const entry: IdbEntry = { bytes: data, cachedAt: Date.now() };
  await idbRun(idb, "readwrite", (store) => store.put(entry, url));
}
