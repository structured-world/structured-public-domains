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
// on a difference the source already had STALE_AFTER_HOURS ago, read from the
// list's own history (publicsuffix/list on GitHub). Needs network; run with
// `npm run test:e2e`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeLag, lag, overdue, sourceRules, trieRules } from "./freshness-lag.js";
import { DEFAULT_PSL_URL, load, pslData } from "./tiny.js";

const PKG = "@structured-world/structured-public-domains";
const SOURCE_URL = "https://publicsuffix.org/list/public_suffix_list.dat";
const HISTORY_REPO = "publicsuffix/list";
const HISTORY_PATH = "public_suffix_list.dat";

// Daily update at 06:00 UTC, then release, npm publish and the CDN range cache.
// A source change older than two days that is still missing is a broken chain.
// PSL_STALE_AFTER_HOURS=0 turns any difference into a failure.
// Unset or empty keeps the default: Number("") is 0, which would silently
// turn the window off instead of reporting the mistake.
const rawStale = process.env.PSL_STALE_AFTER_HOURS?.trim();
const STALE_AFTER_HOURS = rawStale ? Number(rawStale) : 48;
if (!Number.isFinite(STALE_AFTER_HOURS) || STALE_AFTER_HOURS < 0) {
  throw new Error(`PSL_STALE_AFTER_HOURS must be a non-negative number of hours, got "${rawStale}"`);
}

// Per request, so one hung endpoint fails in its own line of the report
// instead of running out the whole test's timeout and losing the verdict.
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res;
}

/** The list as it stood at `cutoff`: the last commit to it at or before then. */
async function sourceAt(cutoff: Date): Promise<{ sha: string; rules: Set<string> }> {
  // Anonymous API calls share a small per-IP budget; CI passes its token.
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const commits = (await (
    await fetchOk(
      `https://api.github.com/repos/${HISTORY_REPO}/commits?path=${HISTORY_PATH}&until=${cutoff.toISOString()}&per_page=1`,
      { headers },
    )
  ).json()) as { sha: string }[];
  const sha = commits[0]?.sha;
  if (sha === undefined) throw new Error(`no ${HISTORY_REPO} commit at or before ${cutoff.toISOString()}`);
  const text = await (await fetchOk(`https://raw.githubusercontent.com/${HISTORY_REPO}/${sha}/${HISTORY_PATH}`)).text();
  return { sha, rules: sourceRules(text) };
}

/** A report line computed best-effort: its failure becomes the line itself. */
async function diagnose(line: () => Promise<string>): Promise<string> {
  try {
    return await line();
  } catch (err) {
    return `unavailable (${err instanceof Error ? err.message : String(err)})`;
  }
}

describe("PSL freshness (network)", () => {
  it("serves a trie with no source change older than the update window missing", async () => {
    const sourceText = await (await fetchOk(SOURCE_URL)).text();
    const live = sourceRules(sourceText);
    const version = /^\/\/ VERSION: (\S+)/m.exec(sourceText)?.[1] ?? "unknown";
    const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 3_600_000);
    const atCutoff = await sourceAt(cutoff);

    // What consumers get: the real default URL through the public API.
    // PSL_SERVED_URL points the same check at a mirror or a pinned version.
    const servedUrl = process.env.PSL_SERVED_URL ?? DEFAULT_PSL_URL;
    await load({ url: servedUrl, cache: false, force: true });
    const served = lag(live, trieRules(pslData()));
    const late = overdue(served, atCutoff.rules);

    // Where a lag sits, for the report only. These lines must never decide the
    // verdict or hide it, so a failure here is reported in place, not thrown.
    const npmLine = await diagnose(async () => {
      const latest = (await (await fetchOk(`https://registry.npmjs.org/${PKG}/latest`)).json()) as { version: string };
      const exactUrl = `https://cdn.jsdelivr.net/npm/${PKG}@${latest.version}/dist/psl.bin`;
      const image = new Uint8Array(await (await fetchOk(exactUrl)).arrayBuffer());
      return `${PKG}@${latest.version}: ${describeLag(lag(live, trieRules(image)))}`;
    });
    const repoLine = await diagnose(async () => {
      const repoBin = readFileSync(join(fileURLToPath(import.meta.url), "..", "..", "..", "src", "psl.bin"));
      return `src/psl.bin: ${describeLag(lag(live, trieRules(new Uint8Array(repoBin))))}`;
    });

    const report = [
      `source   ${SOURCE_URL}: ${live.size} rules, VERSION ${version}`,
      `cutoff   ${cutoff.toISOString()} (${STALE_AFTER_HOURS}h): ${HISTORY_REPO}@${atCutoff.sha.slice(0, 12)}`,
      `served   ${servedUrl}: ${describeLag(served)}`,
      `overdue  ${describeLag(late)}`,
      `npm      ${npmLine}`,
      `checkout ${repoLine}`,
    ].join("\n");
    console.log(report);

    // Counted rather than compared as lists: the report above already names them.
    expect(
      late.added.length + late.removed.length,
      `served trie misses source changes older than ${STALE_AFTER_HOURS}h\n${report}`,
    ).toBe(0);
  }, 60_000);
});
