import { defineConfig, devices } from "@playwright/test";

// `localhost` and `127.0.0.1` are different sites, so the server binds both and the tests use one
// as the top-level page and the other as the cross-site iframe.
const port = Number(process.env.PROGRESS_LAB_PORT ?? 4317);

export default defineConfig({
  fullyParallel: true,
  testDir: "tests",
  forbidOnly: !!process.env.CI,
  // No retries: a flaky storage test must be fixed, not hidden.
  retries: 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${port}`,
    // Playwright starts Chromium with --disable-features=...,ThirdPartyStoragePartitioning
    // (https://github.com/microsoft/playwright/issues/32230), which switches iframe storage
    // partitioning off, unlike a stock Chrome or Electron. Chromium uses the last
    // --disable-features switch, so this one replaces Playwright's list and leaves partitioning on.
    launchOptions: { args: ["--disable-features=Translate"] },
    trace: "retain-on-failure",
  },
  projects: [
    // Bundled Chromium: the only project CI runs (`--project=chromium`).
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Installed Google Chrome: local only, to compare with the bundled build.
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
  ],
  webServer: {
    command: `node server.mjs --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
