import { defineConfig } from "tsup";

import pkg from "./package.json";

// Pin the tiny entry's default CDN URL to this package's major.minor range, so
// it tracks PSL-data patch releases without a reinstall.
//
// Note what this does NOT buy while the package is pre-1.0: the range is
// minor-locked (jsDelivr resolves `@0.0` within 0.0.x, the way `@2.0` resolves
// to 2.0.x and not 2.7.x), but the trie format has changed inside 0.0.x. An
// already-installed tiny client therefore fetches a blob its bundled parser
// cannot read, and `load()` rejects within the cache TTL. That is accepted here
// deliberately: nothing depends on this package in production yet, and paying a
// minor bump — or carrying two serialisers — to protect hypothetical installs
// costs more than it saves. Revisit at 1.0, when the range genuinely has to
// mean a stable format.
const [major, minor] = pkg.version.split(".");
const pslRange = `${major}.${minor}`;

// Dual ESM + CJS build with type declarations for both. The base64 data module
// (./psl-data.cjs) is forced external so it is NOT inlined into each bundle —
// a single shared copy ships in dist and is loaded by both entries.
export default defineConfig({
  entry: ["src/index.ts", "src/tiny.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  target: "es2021",
  define: { __PSL_PKG_RANGE__: JSON.stringify(pslRange) },
  // "neutral" keeps output runtime-agnostic and preserves `node:` import
  // specifiers (so browser bundlers recognise them as builtins to ignore,
  // rather than esbuild rewriting them to bare `fs`/`os`/`path`).
  platform: "neutral",
  sourcemap: false,
  treeshake: true,
  // Keep Node builtins external: the tiny entry imports them dynamically and
  // only on Node, so they must not be bundled (and would break browser output).
  external: [/^node:/],
  esbuildPlugins: [
    {
      name: "external-psl-data",
      setup(build) {
        build.onResolve({ filter: /psl-data\.cjs$/ }, () => ({
          path: "./psl-data.cjs",
          external: true,
        }));
      },
    },
  ],
});
