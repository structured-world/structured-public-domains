export { DomainInfo, lookup, registrableDomain, isKnownSuffix } from "./index.js";

/**
 * Initialise the wasm module.  Must be awaited before calling any other
 * function from this package.
 *
 * Without arguments the `.wasm` binary is fetched from a sibling URL
 * (works with most bundlers).  You may also pass a `URL`, `Response`,
 * `BufferSource`, or `WebAssembly.Module`.
 */
export function init(
  input?: BufferSource | WebAssembly.Module | URL | Response | Promise<Response>,
): Promise<void>;
