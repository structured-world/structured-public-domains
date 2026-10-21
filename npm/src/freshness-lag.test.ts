// Offline tests for the freshness probe's verdict and its independent decoder.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lag, overdue, sourceRules, trieRules } from "./freshness-lag.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

describe("trieRules", () => {
  it("decodes the checkout's image back to exactly the rules it was built from", () => {
    // The probe judges the served trie by this decoder, so it has to reproduce
    // build-psl.py's input rule for rule, wildcards and exceptions included.
    const built = trieRules(new Uint8Array(readFileSync(join(ROOT, "src", "psl.bin"))));
    const source = sourceRules(readFileSync(join(ROOT, "data", "public_suffix_list.dat"), "utf8"));
    expect(lag(source, built)).toEqual({ added: [], removed: [] });
    expect(built.has("*.ck")).toBe(true);
    expect(built.has("!www.ck")).toBe(true);
  });
});

describe("overdue", () => {
  // Live list now, the source as it stood at the cutoff, and a served trie
  // that stopped updating before the cutoff.
  const atCutoff = new Set(["com", "old-addition.example", "late-removal.example"]);
  const live = new Set(["com", "old-addition.example", "fresh-addition.example"]);
  const served = new Set(["com", "late-removal.example", "old-removal.example"]);

  it("flags a change the source already had at the cutoff, however recent the latest edit", () => {
    // `old-addition` was live before the cutoff and is still missing; a newer,
    // unrelated edit to the list must not hide it.
    const result = overdue(lag(live, served), atCutoff);
    expect(result.added).toEqual(["old-addition.example"]);
    // `old-removal` was already gone at the cutoff and is still served.
    expect(result.removed).toEqual(["old-removal.example"]);
  });

  it("allows changes the source made after the cutoff", () => {
    const result = overdue(lag(live, served), atCutoff);
    expect(result.added).not.toContain("fresh-addition.example");
    expect(result.removed).not.toContain("late-removal.example");
  });

  it("is empty when the served trie is current", () => {
    expect(overdue(lag(live, live), atCutoff)).toEqual({ added: [], removed: [] });
  });
});
