import { defineConfig } from "tsup";

// Dual ESM + CJS build with type declarations for both. The base64 data module
// (./psl-data.cjs) is forced external so it is NOT inlined into each bundle —
// a single shared copy ships in dist and is loaded by both entries.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  target: "es2021",
  sourcemap: false,
  treeshake: true,
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
