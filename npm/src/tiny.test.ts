// Tests for the runtime-fetched "tiny" entry. The PSL bytes are injected via a
// mock fetch reading the real src/psl.bin, so results must match the embedded
// build exactly. Module state is reset between tests via vitest module isolation.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const leaf = (boundary: boolean) => Uint8Array.from([boundary ? 1 : 0, 0, 0]);
  // Sorted, distinct labels: filler "f000".."f249" then "zzztest" (a known TLD).
  const children: [string, Uint8Array][] = [];
  for (let i = 0; i < 250; i++) children.push([`f${String(i).padStart(3, "0")}`, leaf(false)]);
  children.push(["zzztest", leaf(true)]);

  const parts: number[] = [0, children.length & 0xff, (children.length >> 8) & 0xff];
  for (const [label, child] of children) {
    const lb = enc.encode(label);
    parts.push(lb.length, ...lb, ...child);
  }
  return Uint8Array.from(parts);
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
