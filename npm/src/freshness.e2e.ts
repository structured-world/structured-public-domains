// End-to-end freshness probe: is the trie that `/tiny` actually downloads older
// than the live Public Suffix List?
//
// It loads through the real default URL (jsDelivr, this package's `major.minor`
// range), decodes the served image back into PSL rules and compares them with
// publicsuffix.org. Two more images are decoded only to say where a lag sits:
// the exact latest npm version on the same CDN (publishing vs CDN range cache)
// and this checkout's `src/psl.bin` (the data update itself).
//
// The live list moves on its own clock, so a difference alone is not a failure:
// the daily update, the release and the CDN all take time. The probe fails only
// when the source has been unchanged for at least STALE_AFTER_HOURS and the
// served trie still does not match it. Needs network; run with `npm run test:e2e`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_PSL_URL, load, pslData } from "./tiny.js";

const PKG = "@structured-world/structured-public-domains";
const SOURCE_URL = "https://publicsuffix.org/list/public_suffix_list.dat";

// Daily update at 06:00 UTC, then release, npm publish and the CDN range cache.
// A source change older than two days that is still missing is a broken chain.
// PSL_STALE_AFTER_HOURS=0 turns any difference into a failure.
const STALE_AFTER_HOURS = Number(process.env.PSL_STALE_AFTER_HOURS ?? 48);

/** Canonical rule set of a PSL text, exactly as `scripts/build-psl.py` reads it. */
function sourceRules(text: string): Set<string> {
  const rules = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    rules.add(line.replace(/^\.+/, "").toLowerCase());
  }
  return rules;
}

/**
 * Decode a trie image back into its rules: every suffix-boundary node is one
 * rule, spelled by its label path read leaf-to-root.
 *
 * Written against the format note in `scripts/build-psl.py` rather than through
 * the lookup code, so the probe does not trust the reader it is checking.
 */
function trieRules(image: Uint8Array): Set<string> {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const rules = new Set<string>();

  const varint = (at: number): [number, number] => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = image[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return [value, at];
    }
  };

  // Returns the offset just past the node's subtree.
  const walk = (at: number, path: string[]): number => {
    const header = image[at]!;
    let count = header & 0x1f;
    let body = at + 1;
    if (count === 0x1f) {
      count = image[at + 1]! | (image[at + 2]! << 8);
      body = at + 3;
    }
    const indexed = (header & 0x40) !== 0;
    if ((header & 0x80) !== 0 && path.length > 0) rules.add([...path].reverse().join("."));

    let cursor = indexed ? body + 3 * count : body;
    for (let i = 0; i < count; i++) {
      const len = image[cursor]!;
      const label = utf8.decode(image.subarray(cursor + 1, cursor + 1 + len));
      let child = cursor + 1 + len;
      if (!indexed) child = varint(child)[1];
      cursor = walk(child, [...path, label]);
    }
    return cursor;
  };

  const end = walk(0, []);
  if (end !== image.length) throw new Error(`trie decode stopped at ${end} of ${image.length} bytes`);
  return rules;
}

interface Lag {
  added: string[];
  removed: string[];
}

function lag(live: Set<string>, ours: Set<string>): Lag {
  return {
    added: [...live].filter((r) => !ours.has(r)).sort(),
    removed: [...ours].filter((r) => !live.has(r)).sort(),
  };
}

const describeLag = ({ added, removed }: Lag): string =>
  added.length + removed.length === 0
    ? "in sync"
    : `missing ${added.length} [${added.slice(0, 5).join(", ")}${added.length > 5 ? ", ..." : ""}], ` +
      `stale ${removed.length} [${removed.slice(0, 5).join(", ")}${removed.length > 5 ? ", ..." : ""}]`;

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res;
}

describe("PSL freshness (network)", () => {
  it("serves a trie that is not older than the live list beyond the update window", async () => {
    const source = await fetchOk(SOURCE_URL);
    const sourceText = await source.text();
    const live = sourceRules(sourceText);
    const version = /^\/\/ VERSION: (\S+)/m.exec(sourceText)?.[1] ?? "unknown";
    const modified = Date.parse(source.headers.get("last-modified") ?? "");
    expect(Number.isFinite(modified), "publicsuffix.org sent no usable Last-Modified").toBe(true);
    const sourceAgeMs = Date.now() - modified;

    // What consumers get: the real default URL through the public API.
    // PSL_SERVED_URL points the same check at a mirror or a pinned version.
    const servedUrl = process.env.PSL_SERVED_URL ?? DEFAULT_PSL_URL;
    await load({ url: servedUrl, cache: false, force: true });
    const served = lag(live, trieRules(pslData()));

    // Where a lag sits, for the report only.
    const latest = (await (await fetchOk(`https://registry.npmjs.org/${PKG}/latest`)).json()) as { version: string };
    const exactUrl = `https://cdn.jsdelivr.net/npm/${PKG}@${latest.version}/dist/psl.bin`;
    const exact = lag(live, trieRules(new Uint8Array(await (await fetchOk(exactUrl)).arrayBuffer())));
    const repoBin = readFileSync(join(fileURLToPath(import.meta.url), "..", "..", "..", "src", "psl.bin"));
    const repo = lag(live, trieRules(new Uint8Array(repoBin)));

    const report = [
      `source   ${SOURCE_URL}: ${live.size} rules, VERSION ${version}, changed ${(sourceAgeMs / 3_600_000).toFixed(1)}h ago`,
      `served   ${servedUrl}: ${describeLag(served)}`,
      `npm      ${PKG}@${latest.version}: ${describeLag(exact)}`,
      `checkout src/psl.bin: ${describeLag(repo)}`,
    ].join("\n");
    console.log(report);

    const behind = served.added.length + served.removed.length > 0;
    expect(
      behind && sourceAgeMs >= STALE_AFTER_HOURS * 3_600_000,
      `served trie is behind a source unchanged for ${STALE_AFTER_HOURS}h or more\n${report}`,
    ).toBe(false);
  }, 60_000);
});
