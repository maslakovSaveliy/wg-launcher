import { defineConfig, devices } from "@playwright/test";

// Browser tests of the exporter in Playwright's bundled Chromium, against progress-lab served on a free port by each
// worker (browser/harness.ts). The exporter runs in an isolated world of a stub page at the game's origin, created over
// CDP; the quiescent window that does this in the launcher is Task 13. Headless.
export default defineConfig({
  testDir: "browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a flaky storage test must be fixed, not hidden.
  retries: 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    // Playwright disables ThirdPartyStoragePartitioning (issue 32230); Chromium uses the last --disable-features
    // switch, so this one replaces Playwright's list and leaves partitioning on, as in the fixture's config.
    launchOptions: { args: ["--disable-features=Translate"] },
    // progress-lab registers a service worker; the stub navigation must reach page.route, not the worker.
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
});
