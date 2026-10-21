// Rule-level comparison behind the freshness probe (`freshness.e2e.ts`). Kept
// free of I/O so the verdict can be tested without the network.

/** Canonical rule set of a PSL text, exactly as `scripts/build-psl.py` reads it. */
export function sourceRules(text: string): Set<string> {
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
export function trieRules(image: Uint8Array): Set<string> {
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

/** How a rule set differs from the live list. */
export interface Lag {
  /** Rules the live list has and `ours` lacks. */
  added: string[];
  /** Rules `ours` still has and the live list dropped. */
  removed: string[];
}

export function lag(live: Set<string>, ours: Set<string>): Lag {
  return {
    added: [...live].filter((r) => !ours.has(r)).sort(),
    removed: [...ours].filter((r) => !live.has(r)).sort(),
  };
}

export const describeLag = ({ added, removed }: Lag): string =>
  added.length + removed.length === 0
    ? "in sync"
    : `missing ${added.length} [${added.slice(0, 5).join(", ")}${added.length > 5 ? ", ..." : ""}], ` +
      `stale ${removed.length} [${removed.slice(0, 5).join(", ")}${removed.length > 5 ? ", ..." : ""}]`;

/**
 * The part of a lag that is overdue: differences the source already had at the
 * cutoff, given `cutoff` as the source's rule set at that moment.
 *
 * Judged per rule rather than by when the list last changed, so a stream of new
 * edits cannot keep resetting the grace period for an old missing change: a
 * rule still missing is overdue if it was live at the cutoff, a rule still
 * served is overdue if it was already gone then.
 */
export function overdue({ added, removed }: Lag, cutoff: Set<string>): Lag {
  return {
    added: added.filter((r) => cutoff.has(r)),
    removed: removed.filter((r) => !cutoff.has(r)),
  };
}
