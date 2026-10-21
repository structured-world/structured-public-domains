import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Listed explicitly so a module no test imports still counts, as zero.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.e2e.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
