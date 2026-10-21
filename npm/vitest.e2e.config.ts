// Network-dependent end-to-end checks, kept out of `npm test`: their verdict
// depends on live third-party data, not only on this checkout.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
  },
});
