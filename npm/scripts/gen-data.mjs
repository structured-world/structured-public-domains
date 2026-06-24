// Embed the binary PSL trie (repo src/psl.bin) as a base64 string in a single
// CommonJS module shared by the ESM and CJS builds. Generated — never edit
// src/psl-data.cjs by hand; run `npm run gen:data`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // npm/scripts
const binPath = join(here, "..", "..", "src", "psl.bin"); // repo/src/psl.bin
const outPath = join(here, "..", "src", "psl-data.cjs"); // npm/src/psl-data.cjs

const base64 = readFileSync(binPath).toString("base64");
const body =
  '"use strict";\n' +
  "// Generated from src/psl.bin by scripts/gen-data.mjs — do not edit.\n" +
  `exports.PSL_BASE64 = ${JSON.stringify(base64)};\n`;

writeFileSync(outPath, body);
console.log(`psl-data.cjs: ${base64.length} base64 chars (${readFileSync(binPath).length} raw bytes)`);
