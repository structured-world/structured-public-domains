import { defineConfig } from "tsup";

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
