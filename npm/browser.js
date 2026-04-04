// Browser entry — async init() must be called before other functions.
import _init, {
  lookup as _lookup,
  registrableDomain,
  isKnownSuffix,
} from "./structured_public_domains.js";

/**
 * Initialise the wasm module.  Must be called (and awaited) before
 * `lookup`, `registrableDomain`, or `isKnownSuffix`.
 *
 * Without arguments the wasm binary is fetched from a sibling URL
 * (works with most bundlers).  You may also pass a `URL`, `Response`,
 * `BufferSource`, or `WebAssembly.Module`.
 */
export async function init(input) {
  await _init(input);
}

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
