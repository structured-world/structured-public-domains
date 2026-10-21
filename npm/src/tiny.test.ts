// Tests for the runtime-fetched "tiny" entry. The PSL bytes are injected via a
// mock fetch reading the real src/psl.bin, so results must match the embedded
// build exactly. Module state is reset between tests via vitest module isolation.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PSL_BIN = readFileSync(join(fileURLToPath(import.meta.url), "..", "..", "..", "src", "psl.bin"));

/** A fetch stub that returns the real psl.bin and counts calls. */
function mockFetch() {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => PSL_BIN.buffer.slice(PSL_BIN.byteOffset, PSL_BIN.byteOffset + PSL_BIN.byteLength),
  })) as unknown as typeof fetch & { mock: { calls: unknown[] } };
  return fn;
}

// Each test imports a fresh module instance so the load() singleton is reset.
async function freshTiny() {
  vi.resetModules();
  return import("./tiny.js");
}

const uniqueCacheDir = () => join(tmpdir(), `spd-tiny-test-${Math.random().toString(36).slice(2)}`);

/**
 * Build a valid binary trie (DFS preorder, same format as build-psl.py) in which
 * "zzztest" is a public-suffix boundary. Padded past the 1KB fetch sanity check
 * with filler TLD leaves. Used to distinguish two concurrently-loaded datasets.
 */
function buildAltTrie(): Uint8Array {
  const enc = new TextEncoder();
  // A leaf: header only, no children, no index.
  const leaf = (boundary: boolean) => Uint8Array.from([boundary ? 0x80 : 0]);
  // Sorted, distinct labels: filler "f000".."f249" then "zzztest" (a known TLD).
  const children: [string, Uint8Array][] = [];
  for (let i = 0; i < 250; i++) children.push([`f${String(i).padStart(3, "0")}`, leaf(false)]);
  children.push(["zzztest", leaf(true)]);

  // 251 children is past the header's 5-bit field and past the index threshold,
  // so this root takes the u16 count and an offset index — the same shape the
  // real image gives its widest nodes, which is what makes it worth testing.
  const header = [0x40 | 0x1f, children.length & 0xff, (children.length >> 8) & 0xff];

  const entries = children.map(([label, child]) => {
    const lb = enc.encode(label);
    return [lb.length, ...lb, ...child];
  });

  const index: number[] = [];
  let offset = header.length + 3 * entries.length;
  for (const entry of entries) {
    index.push(offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff);
    offset += entry.length;
  }

  return Uint8Array.from([...header, ...index, ...entries.flat()]);
}

describe("tiny load + lookup", () => {
  it("fetches, parses, and resolves lookups matching the embedded build", async () => {
    const tiny = await freshTiny();
    const fetch = mockFetch();
    expect(tiny.isLoaded()).toBe(false);

    await tiny.load({ fetch, cache: false });

    expect(tiny.isLoaded()).toBe(true);
    expect(tiny.lookup("www.example.co.uk")).toEqual({
      suffix: "co.uk",
      registrableDomain: "example.co.uk",
      known: true,
    });
    expect(tiny.registrableDomain("sub.example.com")).toBe("example.com");
    expect(tiny.isKnownSuffix("example.com")).toBe(true);
    expect(tiny.pslData().length).toBe(PSL_BIN.byteLength);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second load does not re-fetch", async () => {
    const tiny = await freshTiny();
    const fetch = mockFetch();
    await tiny.load({ fetch, cache: false });
    await tiny.load({ fetch, cache: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws when a lookup is attempted before load()", async () => {
    const tiny = await freshTiny();
    expect(() => tiny.lookup("example.com")).toThrow(/not loaded/);
    expect(() => tiny.pslData()).toThrow(/not loaded/);
  });
});

describe("tiny cache (Node file)", () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueCacheDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes on first load and reads from cache on the next (no second fetch)", async () => {
    const first = await freshTiny();
    const fetch1 = mockFetch();
    await first.load({ fetch: fetch1, cacheDir: dir });
    expect(fetch1).toHaveBeenCalledTimes(1);

    // Fresh module instance (cleared in-memory singleton) must hit the file cache.
    const second = await freshTiny();
    const fetch2 = mockFetch();
    await second.load({ fetch: fetch2, cacheDir: dir });
    expect(fetch2).toHaveBeenCalledTimes(0);
    expect(second.lookup("example.com")?.suffix).toBe("com");
  });

  it("re-fetches when the cached entry is older than the TTL", async () => {
    const first = await freshTiny();
    const fetch1 = mockFetch();
    await first.load({ fetch: fetch1, cacheDir: dir });

    const second = await freshTiny();
    const fetch2 = mockFetch();
    // ttl 0 → any cached entry is already stale.
    await second.load({ fetch: fetch2, cacheDir: dir, cacheTtlMs: 0 });
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it("force re-fetches even with a fresh cache", async () => {
    const first = await freshTiny();
    const fetch1 = mockFetch();
    await first.load({ fetch: fetch1, cacheDir: dir });

    const second = await freshTiny();
    const fetch2 = mockFetch();
    await second.load({ fetch: fetch2, cacheDir: dir, force: true });
    expect(fetch2).toHaveBeenCalledTimes(1);
  });
});

/** Put a raw value under `url` in the tiny cache's IndexedDB store. */
function idbSeed(idb: IDBFactory, url: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = idb.open("structured-public-domains", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("psl");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("psl", "readwrite");
      tx.objectStore("psl").put(value, url);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** Read the raw value stored under `url`, or undefined when absent. */
function idbPeek(idb: IDBFactory, url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = idb.open("structured-public-domains", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("psl");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction("psl", "readonly").objectStore("psl").get(url);
      req.onsuccess = () => {
        db.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    };
  });
}

// IndexedDB is the browser cache, and it is what the tiny entry picks whenever
// the global exists. A fresh fake factory per test keeps the stores apart; the
// Node file cache must stay untouched while IndexedDB is in charge.
describe("tiny cache (IndexedDB)", () => {
  const SRC = "https://psl.test/psl.bin";
  let idb: IDBFactory;
  let dir: string;
  beforeEach(() => {
    idb = new IDBFactory();
    vi.stubGlobal("indexedDB", idb);
    dir = uniqueCacheDir();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves a fresh module instance from IndexedDB without fetching", async () => {
    const first = await freshTiny();
    const fetch1 = mockFetch();
    await first.load({ url: SRC, fetch: fetch1, cacheDir: dir });
    expect(fetch1).toHaveBeenCalledTimes(1);
    expect(existsSync(dir)).toBe(false);

    const second = await freshTiny();
    const fetch2 = mockFetch();
    await second.load({ url: SRC, fetch: fetch2, cacheDir: dir });
    expect(fetch2).toHaveBeenCalledTimes(0);
    expect(second.lookup("www.example.co.uk")?.registrableDomain).toBe("example.co.uk");
    expect(second.pslData()).toEqual(new Uint8Array(PSL_BIN));
  });

  it("keys entries by URL", async () => {
    const first = await freshTiny();
    await first.load({ url: SRC, fetch: mockFetch() });

    const second = await freshTiny();
    const fetch2 = mockFetch();
    await second.load({ url: `${SRC}?mirror`, fetch: fetch2 });
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when the entry is older than the TTL", async () => {
    const first = await freshTiny();
    await first.load({ url: SRC, fetch: mockFetch() });

    const second = await freshTiny();
    const fetch2 = mockFetch();
    await second.load({ url: SRC, fetch: fetch2, cacheTtlMs: 0 });
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it("force re-fetches even with a fresh entry", async () => {
    const first = await freshTiny();
    await first.load({ url: SRC, fetch: mockFetch() });

    const second = await freshTiny();
    const fetch2 = mockFetch();
    await second.load({ url: SRC, fetch: fetch2, force: true });
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it("does not persist anything when the cache is disabled", async () => {
    const tiny = await freshTiny();
    await tiny.load({ url: SRC, fetch: mockFetch(), cache: false });
    expect(await idbPeek(idb, SRC)).toBeUndefined();
  });

  it("replaces a fresh but corrupt entry with the fetched trie", async () => {
    // Fresh timestamp, so only validation can reject it.
    await idbSeed(idb, SRC, { bytes: new TextEncoder().encode("not a trie"), cachedAt: Date.now() });

    const tiny = await freshTiny();
    const fetch = mockFetch();
    await expect(tiny.load({ url: SRC, fetch })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tiny.lookup("example.com")?.suffix).toBe("com");
    const stored = (await idbPeek(idb, SRC)) as { bytes: Uint8Array };
    expect(stored.bytes).toEqual(new Uint8Array(PSL_BIN));
  });

  it("treats a value of another shape as a miss and overwrites it", async () => {
    await idbSeed(idb, SRC, "left by something else");

    const tiny = await freshTiny();
    const fetch = mockFetch();
    await tiny.load({ url: SRC, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const stored = (await idbPeek(idb, SRC)) as { bytes: Uint8Array; cachedAt: number };
    expect(stored.bytes).toEqual(new Uint8Array(PSL_BIN));
    expect(typeof stored.cachedAt).toBe("number");
  });

  it("does not wait on an open queued behind a blocked database deletion", async () => {
    // Another connection keeps the database open and ignores `versionchange`,
    // so a deletion requested meanwhile is blocked, and any open after it is
    // queued behind the deletion with no deadline of its own.
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = idb.open("structured-public-domains", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("psl");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const deletion = idb.deleteDatabase("structured-public-domains");
    try {
      const tiny = await freshTiny();
      const fetch = mockFetch();
      const outcome = await Promise.race([
        tiny.load({ url: SRC, fetch }).then(() => "loaded"),
        new Promise((r) => setTimeout(() => r("stalled"), 4000)),
      ]);
      expect(outcome).toBe("loaded");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(tiny.isKnownSuffix("example.com")).toBe(true);
    } finally {
      holder.close();
      await new Promise((resolve) => {
        deletion.onsuccess = resolve;
        deletion.onerror = resolve;
      });
    }
  }, 10_000);

  it("still loads from the network when IndexedDB cannot be opened", async () => {
    // Shape of a context where the API exists but refuses access (e.g. storage
    // blocked by the user): open() throws synchronously.
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new DOMException("access denied", "SecurityError");
      },
    });
    const tiny = await freshTiny();
    const fetch = mockFetch();
    await expect(tiny.load({ url: SRC, fetch })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tiny.isKnownSuffix("example.com")).toBe(true);
  });
});

describe("tiny load robustness", () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueCacheDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deduplicates concurrent load() calls into a single fetch", async () => {
    const tiny = await freshTiny();
    let calls = 0;
    const slowFetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () =>
          PSL_BIN.buffer.slice(PSL_BIN.byteOffset, PSL_BIN.byteOffset + PSL_BIN.byteLength),
      };
    }) as unknown as typeof fetch;

    // Two overlapping startup calls must share one fetch, not race.
    await Promise.all([tiny.load({ fetch: slowFetch, cache: false }), tiny.load({ fetch: slowFetch, cache: false })]);
    expect(calls).toBe(1);
    expect(tiny.lookup("example.com")?.suffix).toBe("com");
  });

  it("does not let an older in-flight load overwrite a forced refresh", async () => {
    const tiny = await freshTiny();
    // `alt` is a valid trie where "zzztest" is a known suffix; the real PSL has
    // no such rule. Whichever dataset wins is observable via isKnownSuffix.
    const alt = buildAltTrie();
    const delayed = (bytes: Uint8Array, ms: number) =>
      (async () => {
        await new Promise((r) => setTimeout(r, ms));
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }) as unknown as typeof fetch;

    // A slow non-forced load is already pending when a fast forced refresh runs.
    // The forced refresh (real PSL) must win even though the older load settles last.
    await Promise.all([
      tiny.load({ fetch: delayed(alt, 40), cache: false }),
      tiny.load({ fetch: delayed(PSL_BIN, 5), cache: false, force: true }),
    ]);
    expect(tiny.isKnownSuffix("zzztest")).toBe(false);
  });

  it("does not resolve a superseded load until data is actually loaded", async () => {
    const tiny = await freshTiny();
    const delayed = (bytes: Uint8Array, ms: number) =>
      (async () => {
        await new Promise((r) => setTimeout(r, ms));
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }) as unknown as typeof fetch;

    // The non-forced load finishes first but is superseded by the forced load.
    // Awaiting it must not resolve as ready while the singleton is still unloaded.
    const loadA = tiny.load({ fetch: delayed(PSL_BIN, 5), cache: false });
    const loadB = tiny.load({ fetch: delayed(PSL_BIN, 40), cache: false, force: true });
    await loadA;
    expect(tiny.isLoaded()).toBe(true);
    expect(tiny.lookup("example.com")?.suffix).toBe("com");
    await loadB;
  });

  it("rejects a superseded load when the winning forced load fails", async () => {
    const tiny = await freshTiny();
    const slowOk = (async () => {
      await new Promise((r) => setTimeout(r, 40));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => PSL_BIN.buffer.slice(PSL_BIN.byteOffset, PSL_BIN.byteOffset + PSL_BIN.byteLength),
      };
    }) as unknown as typeof fetch;
    const failFast = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: false, status: 500, statusText: "Server Error" };
    }) as unknown as typeof fetch;

    // The forced load fails fast and clears the in-flight state; the older load
    // (superseded) must not then resolve as ready while nothing is loaded.
    const loadA = tiny.load({ fetch: slowOk, cache: false });
    const loadB = tiny.load({ fetch: failFast, cache: false, force: true });
    await expect(loadB).rejects.toThrow();
    await expect(loadA).rejects.toThrow();
    expect(tiny.isLoaded()).toBe(false);
  });

  it("rejects a forced refresh superseded by a failing forced refresh, keeping the old data", async () => {
    const tiny = await freshTiny();
    const instant = (bytes: Uint8Array) =>
      (async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      })) as unknown as typeof fetch;
    const slowFresh = (async () => {
      await new Promise((r) => setTimeout(r, 40));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => PSL_BIN.buffer.slice(PSL_BIN.byteOffset, PSL_BIN.byteOffset + PSL_BIN.byteLength),
      };
    }) as unknown as typeof fetch;
    const failFast = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: false, status: 500, statusText: "Server Error" };
    }) as unknown as typeof fetch;

    // Singleton is already loaded with OLD data (alt trie: "zzztest" is known).
    await tiny.load({ fetch: instant(buildAltTrie()), cache: false });
    expect(tiny.isKnownSuffix("zzztest")).toBe(true);

    // A slow forced refresh is superseded by a faster forced refresh that fails.
    // The slow refresh must NOT report success while the module still serves the
    // pre-refresh data — it mirrors the failing winner and rejects.
    const loadX = tiny.load({ fetch: slowFresh, cache: false, force: true });
    const loadY = tiny.load({ fetch: failFast, cache: false, force: true });
    await expect(loadY).rejects.toThrow();
    await expect(loadX).rejects.toThrow();
    expect(tiny.isKnownSuffix("zzztest")).toBe(true);
  });

  it("recovers via a forced refresh when the initial load hangs", async () => {
    const tiny = await freshTiny();
    // A non-forced load whose fetch never settles (stuck CDN request).
    const hang = (() => new Promise<never>(() => {})) as unknown as typeof fetch;
    void tiny.load({ fetch: hang, cache: false });

    // A forced refresh against a healthy mirror must not wait on the stuck load.
    const healthy = mockFetch();
    const result = await Promise.race([
      tiny.load({ fetch: healthy, cache: false, force: true }).then(() => "DONE"),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 300)),
    ]);
    expect(result).toBe("DONE");
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(tiny.lookup("example.com")?.suffix).toBe("com");
  });

  it("falls back to the network when the cached blob is corrupt", async () => {
    // Seed a fresh-but-corrupt cache file.
    const seed = await freshTiny();
    const seedFetch = mockFetch();
    await seed.load({ fetch: seedFetch, cacheDir: dir });
    for (const f of readdirSync(dir)) writeFileSync(join(dir, f), Buffer.from("not a trie"));

    // A new instance reading the corrupt cache must recover via fetch, not throw.
    const tiny = await freshTiny();
    const recoverFetch = mockFetch();
    await expect(tiny.load({ fetch: recoverFetch, cacheDir: dir })).resolves.toBeUndefined();
    expect(recoverFetch).toHaveBeenCalledTimes(1);
    expect(tiny.lookup("example.com")?.suffix).toBe("com");
  });
});

describe("tiny error handling", () => {
  it("throws on a non-ok response", async () => {
    const tiny = await freshTiny();
    const badFetch = vi.fn(async () => ({ ok: false, status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
    await expect(tiny.load({ fetch: badFetch, cache: false })).rejects.toThrow(/503/);
  });

  it("throws on an implausibly small body", async () => {
    const tiny = await freshTiny();
    const smallFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new Uint8Array(10).buffer,
    })) as unknown as typeof fetch;
    await expect(tiny.load({ fetch: smallFetch, cache: false })).rejects.toThrow(/implausibly small/);
  });
});
