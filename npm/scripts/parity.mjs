// JS twin of examples/parity.rs: read domains from stdin, print one
// `suffix|registrable|known` (or `NONE`) line each, using the built bundle.
// Its output must be byte-identical to the Rust harness — see the `parity`
// CI job. Run: node scripts/parity.mjs < domains.txt
import { createInterface } from "node:readline";

import { lookup } from "../dist/index.js";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = [];
for await (const domain of rl) {
  const info = lookup(domain);
  lines.push(info === undefined ? "NONE" : `${info.suffix}|${info.registrableDomain ?? ""}|${info.known}`);
}
process.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""));
