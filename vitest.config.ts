import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "desktop/**/*.ts", "web/src/**/*.ts"],
      exclude: ["src/types/**", "src/cli/smoke.ts", "src/cli/preflight.ts"], // live-only CLIs: they exist to call real services
      reporter: ["text", "html", "json-summary"],
      // Per-folder floors (docs/testing.md § Coverage policy). They only go up: raise them to the new floor after each
      // round of tests, never lower them to get a green run.
      thresholds: {
        "src/**": { lines: 86, statements: 83, functions: 83, branches: 72 },
        "web/src/**": { lines: 1, statements: 0, functions: 0, branches: 1 },
        "desktop/**": { lines: 0, statements: 0, functions: 0, branches: 0 },
      },
    },
  },
});
