// Node.js entry — synchronous wasm load via fs.readFileSync, then re-export.
import { readFileSync } from "node:fs";
import init, {
  lookup as _lookup,
  registrableDomain,
  isKnownSuffix,
} from "./structured_public_domains.js";

const wasmPath = new URL("./structured_public_domains_bg.wasm", import.meta.url);
await init(readFileSync(wasmPath));

/**
 * Look up a domain in the Public Suffix List.
 *
 * Returns a plain object with `suffix`, `registrableDomain`, and `known`
 * properties, or `undefined` for invalid input.
 *
 * @param {string} domain
 * @returns {{ suffix: string, registrableDomain: string | undefined, known: boolean } | undefined}
 */
export function lookup(domain) {
  const info = _lookup(domain);
  if (info == null) return undefined;
  const result = {
    suffix: info.suffix,
    registrableDomain: info.registrableDomain,
    known: info.known,
  };
  info.free();
  return result;
}

export { registrableDomain, isKnownSuffix };
