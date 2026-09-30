import { defineConfig } from "@playwright/test";

// End-to-end tests (docs/testing.md). One worker: each spec starts its own engine, and the Electron
// app holds a single-instance lock.
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "web", testDir: "e2e/web", use: { browserName: "chromium" } },
    { name: "electron", testDir: "e2e/electron" },
  ],
});
