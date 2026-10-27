import { defineConfig } from "@playwright/test";

// The desktop e2e suite runs the test build (`pnpm test:e2e` builds it first). Every test launches its own app with
// a fresh temporary userData directory. One worker: each launch opens real windows on the machine.
export default defineConfig({
  testDir: "e2e",
  // *.test.ts files in e2e are Vitest unit tests of the harness itself.
  testMatch: "**/*.spec.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retries: a flaky launcher test must be fixed, not hidden.
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
});
