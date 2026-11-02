import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { type Launched, launchApp, runSecondInstance } from "./harness.js";

let launched: Launched | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Console messages Chromium writes for a CSP or Trusted Types violation. */
const VIOLATION = /Content Security Policy|Trusted ?Type|TrustedHTML|TrustedScript/i;

test("serves the launcher from app://launcher with the CSP and security headers, without a CSP violation", async () => {
  launched = await launchApp();
  const { app, launcher, userData } = launched;

  expect(launcher.url()).toBe("app://launcher/");
  await expect(launcher.locator("h1")).toHaveText("WGLauncher");
  // The sandboxed CommonJS preload ran and exposed only the typed bridge: one function per channel, the game:state
  // subscription and the version; no ipcRenderer, no generic invoke or send.
  await expect(
    launcher.getByText("The library is empty. Add a game by its address."),
  ).toBeVisible();
  expect(
    await launcher.evaluate(() => {
      const wg = (window as { wg?: Record<string, unknown> }).wg ?? {};
      return {
        require: typeof (globalThis as { require?: unknown }).require,
        process: typeof (globalThis as { process?: unknown }).process,
        ipcRenderer: typeof (globalThis as { ipcRenderer?: unknown }).ipcRenderer,
        bridgeKeys: Object.keys(wg).sort(),
        version: wg.bridgeVersion,
        frozen: Object.isFrozen(wg),
      };
    }),
  ).toEqual({
    require: "undefined",
    process: "undefined",
    ipcRenderer: "undefined",
    bridgeKeys: [
      "addGame",
      "bridgeVersion",
      "clearCache",
      "createShortcut",
      "deleteOrphanData",
      "deleteSaves",
      "exportSnapshot",
      "focusGame",
      "getSettings",
      "importSnapshot",
      "launchGame",
      "listFrames",
      "listLibrary",
      "listOrphans",
      "listSnapshots",
      "onGameState",
      "onTaskProgress",
      "removeGame",
      "retryRecovery",
      "saveSnapshotAs",
      "setSettings",
      "updateGame",
      "verifySnapshot",
    ],
    version: 6,
    frozen: true,
  });

  // Headers as the launcher's session serves them: the page, a traversal attempt and a bad cover name.
  const responses = await app.evaluate(async ({ session }) => {
    const ses = session.fromPartition("launcher");
    const read = async (url: string) => {
      const response = await ses.fetch(url);
      return { status: response.status, headers: Object.fromEntries(response.headers) };
    };
    return {
      page: await read("app://launcher/"),
      traversal: await read("app://launcher/%2e%2e%2fpackage.json"),
      cover: await read("app://launcher/covers/not-a-cover.png"),
    };
  });
  const security = {
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
      "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
      "frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  };
  expect(responses.page.status).toBe(200);
  expect(responses.page.headers).toMatchObject({
    ...security,
    "content-type": "text/html; charset=utf-8",
  });
  for (const refused of [responses.traversal, responses.cover]) {
    expect(refused.status).toBe(404);
    expect(refused.headers).toMatchObject(security);
  }

  // The start-up record reached logs/main.log in userData, through redact (no home path).
  const logFile = join(userData, "logs", "main.log");
  await expect
    .poll(() => readFile(logFile, "utf8").catch(() => ""))
    .toContain('"event":"app.start"');
  const startRecord = JSON.parse(
    (await readFile(logFile, "utf8")).split("\n").find((line) => line.includes("app.start")) ??
      "{}",
  );
  expect(startRecord).toMatchObject({ level: "info", flavor: "test", partitioningRestored: true });
  expect(await readFile(logFile, "utf8")).not.toContain(homedir());

  // Start-up produced no CSP or Trusted Types violation (security.md S-15 part; open check 6 of the plan).
  const startUp = (await launched.hooks()).launcherConsole;
  expect(startUp.filter((record) => VIOLATION.test(record.message))).toEqual([]);
  expect(startUp.filter((record) => record.level === "error")).toEqual([]);

  // Control: the policy is enforced and a violation does reach the record, so the empty list above means something.
  const assignment = await launcher.evaluate(() => {
    try {
      document.createElement("div").innerHTML = "<b>x</b>";
      return "assigned";
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(assignment).toBe("TypeError");
  await expect
    .poll(async () =>
      (await launched?.hooks())?.launcherConsole.some((record) => VIOLATION.test(record.message)),
    )
    .toBe(true);
});

test("a second instance exits and hands over to the first, which shows its window again", async () => {
  launched = await launchApp();
  const { app, launcher, userData } = launched;
  await expect(launcher.locator("h1")).toHaveText("WGLauncher");

  // Under bare `xvfb-run` (Linux CI) no window manager runs, so minimize (iconify) is never applied (Assumed, standard
  // X11 behavior): there the precondition is a hidden window, which the handover must show again. macOS and Windows
  // keep minimize, which their window managers apply.
  const hide = process.platform === "linux";
  await app.evaluate(({ BrowserWindow }, hide) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (hide) window?.hide();
    else window?.minimize();
  }, hide);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }, hide) => {
        const window = BrowserWindow.getAllWindows()[0];
        return hide ? window?.isVisible() === false : window?.isMinimized();
      }, hide),
    )
    .toBe(true);

  expect(await runSecondInstance(userData)).toBe(0);

  await expect.poll(async () => (await launched?.hooks())?.secondInstances).toBe(1);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          minimized: window.isMinimized(),
          visible: window.isVisible(),
        })),
      ),
    )
    .toEqual([{ minimized: false, visible: true }]);
});

test("cross-site iframe storage stays partitioned under Playwright", async () => {
  launched = await launchApp();
  const { app, progressLab } = launched;

  // Playwright's loader disabled partitioning, and start-up turned it back on.
  const { partitioning } = await launched.hooks();
  expect(partitioning?.before.split(",")).toContain("ThirdPartyStoragePartitioning");
  expect(partitioning?.after.split(",")).not.toContain("ThirdPartyStoragePartitioning");
  expect(
    (await app.evaluate(({ app }) => app.commandLine.getSwitchValue("disable-features"))).split(
      ",",
    ),
  ).not.toContain("ThirdPartyStoragePartitioning");

  // A plain test window (test hook; game windows proper come with the window factory).
  const [page] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(
      (_electron, url) => globalThis.__wgTest?.openTestWindow(url),
      `${progressLab.loopback}/`,
    ),
  ]);
  const embed = (host: string) =>
    `${host}/iframe-host.html?src=${encodeURIComponent(`${progressLab.loopback}/`)}`;

  const top = game(page);
  const emptyHash = await top.ready();
  await top.play(3);
  const topHash = await top.ready();
  expect(topHash).not.toBe(emptyHash);

  // Control: embedded by a same-site host, the origin shares its top-level storage.
  await page.goto(embed(progressLab.loopback));
  const framed = game(page.frameLocator("#game-frame"));
  expect(await framed.ready()).toBe(topHash);

  // Embedded cross-site (host on localhost), it gets its own, empty partition.
  await page.goto(embed(progressLab.local));
  expect(await framed.ready()).toBe(emptyHash);
  await expect(framed.coins).toHaveText("0");
});

/** Drives progress-lab (its README is the contract) in a page or a frame. */
function game(scope: { locator(selector: string): Locator }) {
  const hash = scope.locator("#progress-hash");
  const coins = scope.locator("#coins");
  const ready = async (): Promise<string> => {
    await expect(hash).toHaveAttribute("data-ready", "true");
    await expect(hash).toHaveText(/^[0-9a-f]{64}$/);
    return (await hash.textContent()) ?? "";
  };
  return {
    coins,
    ready,
    async play(steps: number): Promise<void> {
      await ready();
      const start = Number(await coins.textContent());
      for (let step = 1; step <= steps; step++) {
        await scope.locator("#play-step").click();
        await expect(coins).toHaveText(String(start + step * 10));
      }
      await ready();
    },
  };
}
