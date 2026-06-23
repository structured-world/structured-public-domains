// The ".js" specifier is the ESM convention for type re-exports: under
// node16/nodenext resolution it resolves to the sibling index.d.ts. Writing
// "./index.d.ts" here would be a TypeScript error (TS2846 / TS5097 — importing
// a declaration-file extension is not allowed without allowImportingTsExtensions).
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
