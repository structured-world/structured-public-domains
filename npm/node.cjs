// CommonJS entry — the nodejs-target glue loads the wasm synchronously at
// require() time, so every function is usable immediately with no init() call.
const {
  lookup: _lookup,
  registrableDomain,
  isKnownSuffix,
} = require("./structured_public_domains_node.cjs");

/**
 * Look up a domain in the Public Suffix List.
 *
 * Returns a plain object with `suffix`, `registrableDomain`, and `known`
 * properties, or `undefined` for invalid input.
 *
 * @param {string} domain
 * @returns {{ suffix: string, registrableDomain: string | undefined, known: boolean } | undefined}
 */
function lookup(domain) {
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

module.exports = { lookup, registrableDomain, isKnownSuffix };
