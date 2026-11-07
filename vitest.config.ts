import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: p("./test/stubs/server-only.ts") },
      { find: /^@\//, replacement: p("./apps/web/src/") },
      { find: /^@ae\/core\//, replacement: p("./packages/core/src/") },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/core/src/**/*.test.ts", "apps/web/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "e2e/**"],
    setupFiles: [p("./test/setup.ts")],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: ["packages/core/src/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      // Reported, not enforced yet. Target: 80%.
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    },
  },
});
