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
        "src/**": { lines: 99, statements: 99, functions: 99, branches: 97 },
        "web/src/**": { lines: 100, statements: 99, functions: 98, branches: 97 },
        "desktop/**": { lines: 100, statements: 100, functions: 100, branches: 100 },
      },
    },
  },
});
