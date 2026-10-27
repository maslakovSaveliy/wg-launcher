// Game windows as an isolation boundary (security.md section 11: S-2, S-3, S-4, S-5; PRD AC-2 to AC-5; plan Review
// Focus 1). Each test launches the test build with a fresh userData; the games are progress-lab and the pages of
// e2e/pages served on 127.0.0.1 (a development origin, allowed as an entry in the test flavor only).

import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import {
  addGame,
  closeGame,
  eventsNamed,
  expectState,
  launchGame,
  openGame,
  progressLab,
  queueConfirm,
  windowCount,
} from "./games.js";
import { type Launched, launchApp } from "./harness.js";
import { startTestPages, type TestPages } from "./test-pages.js";

/**
 * A real (trusted) mouse click at the element's center through Playwright's mouse, which does not wait for a
 * navigation: a navigation the app prevented never finishes, and `page.click` would keep waiting for it.
 */
async function trustedClick(page: Page, selector: string): Promise<void> {
  // Not a locator: locators also wait for that navigation.
  const center = await page.evaluate((sel) => {
    const box = document.querySelector(sel)?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  }, selector);
  if (!center) throw new Error(`${selector} is not on the page`);
  await page.mouse.click(center.x, center.y);
}

/** True while the macOS session's screen is locked (`ioreg`); always false elsewhere. */
function screenLocked(): boolean {
  if (process.platform !== "darwin") return false;
  const out = execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" });
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out);
}

let launched: Launched | undefined;
let pages: TestPages | undefined;
test.beforeEach(async () => {
  pages = await startTestPages();
});
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await pages?.stop();
  pages = undefined;
});

const hooks = async () => {
  if (!launched) throw new Error("not launched");
  return launched.hooks();
};

test("two entries with the same URL share nothing, and the launcher shares nothing with them (AC-2, AC-3)", async () => {
  launched = await launchApp();
  const { app, progressLab: lab } = launched;
  const url = `${lab.local}/`;
  const first = await addGame(launched, url, "first");
  const second = await addGame(launched, url, "second");
  expect(first).not.toBe(second);

  const pageA = await openGame(launched, first);
  const gameA = progressLab(pageA);
  const emptyHash = await gameA.ready();
  await gameA.play(3);
  const hashA = await gameA.ready();
  expect(hashA).not.toBe(emptyHash);
  await pageA.evaluate(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: the cookie marker of S-3 is set the way a game sets one.
    document.cookie = "wg-marker=first; max-age=3600; path=/";
  });

  // S-2: no Node, no preload bridge, no Electron IPC in the game's main world.
  expect(
    await pageA.evaluate(() => {
      const scope = globalThis as Record<string, unknown>;
      return {
        require: typeof scope.require,
        process: typeof scope.process,
        module: typeof scope.module,
        bridge: typeof scope.wgLauncher,
        electron: typeof scope.electron,
        ipcRenderer: typeof scope.ipcRenderer,
      };
    }),
  ).toEqual({
    require: "undefined",
    process: "undefined",
    module: "undefined",
    bridge: "undefined",
    electron: "undefined",
    ipcRenderer: "undefined",
  });

  expect(await closeGame(launched, first)).toBe(true);
  await expectState(launched, first, "exited");

  const pageB = await openGame(launched, second);
  const gameB = progressLab(pageB);
  expect(await gameB.ready()).toBe(emptyHash);
  await expect(gameB.coins).toHaveText("0");
  expect(
    await pageB.evaluate(async () => ({
      cookie: document.cookie,
      localStorage: Object.keys(localStorage).filter((key) => key.startsWith("progress-lab:")),
      databases: (await indexedDB.databases()).map((db) => db.name),
    })),
  ).toEqual({ cookie: "", localStorage: [], databases: [] });

  // Main-process view: three different sessions; only the first game's has the cookie.
  const sessions = await app.evaluate(
    async ({ session }, ids) => {
      const sessionOf = async (partition: string) => {
        const ses = session.fromPartition(partition);
        return {
          persistent: ses.storagePath !== null,
          storagePath: ses.storagePath,
          cookies: (await ses.cookies.get({})).map((cookie) => cookie.name),
        };
      };
      return {
        first: await sessionOf(`persist:game:${ids[0]}`),
        second: await sessionOf(`persist:game:${ids[1]}`),
        launcher: await sessionOf("launcher"),
      };
    },
    [first, second],
  );
  expect(sessions.first).toMatchObject({ persistent: true, cookies: ["wg-marker"] });
  expect(sessions.second).toMatchObject({ persistent: true, cookies: [] });
  expect(sessions.launcher).toEqual({ persistent: false, storagePath: null, cookies: [] });
  expect(sessions.first.storagePath).not.toBe(sessions.second.storagePath);

  // The launcher page itself sees none of the game data either.
  expect(
    await launched.launcher.evaluate(() => ({
      cookie: document.cookie,
      localStorage: localStorage.length,
    })),
  ).toEqual({ cookie: "", localStorage: 0 });

  // Persistent: the first game comes back with its progress. Both frames were recorded as storage targets.
  expect(await closeGame(launched, second)).toBe(true);
  await expectState(launched, second, "exited");
  const again = await openGame(launched, first);
  expect(await progressLab(again).ready()).toBe(hashA);
  const targets = await app.evaluate(
    (_electron, id) => globalThis.__wgTest?.storageTargets(id) ?? [],
    first,
  );
  expect(targets).toEqual([`${lab.local} ${lab.local}`]);
});

const FIVE_DENIED = [
  "display-capture",
  "geolocation",
  "media",
  "notifications",
  "window-management",
];

test("permissions: five denied and logged, three allowed after their own click (AC-4, S-4)", async () => {
  launched = await launchApp();
  if (!pages) throw new Error("no pages");
  const id = await addGame(launched, `${pages.origin}/permissions.html`, "permissions");
  const page = await openGame(launched, id);
  await launched.app.evaluate(
    ({ app, BrowserWindow, webContents }, contentsId) => {
      app.focus({ steal: true });
      const contents = contentsId === null ? null : webContents.fromId(contentsId);
      if (contents) BrowserWindow.fromWebContents(contents)?.focus();
    },
    await launched.app.evaluate(
      (_e, gameId) => globalThis.__wgTest?.gameWebContentsId(gameId) ?? null,
      id,
    ),
  );
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);

  const denied = await page.evaluate(() =>
    (window as unknown as { runDenied(): Promise<Record<string, unknown>> }).runDenied(),
  );
  const results = () =>
    page
      .locator("#results")
      .textContent()
      .then((text) => JSON.parse(text ?? "{}"));
  expect(denied).toMatchObject({
    // No stream either way: NotAllowedError when the request reaches the handler, NotFoundError when Chromium
    // finds no camera it may use (the check handler denies `media`, so devices stay hidden).
    camera: { ok: false, error: expect.stringMatching(/^(NotAllowedError|NotFoundError)/) },
    // The microphone only through the check handler: no getUserMedia for audio (security.md section 5, H12).
    microphoneQuery: { ok: true, value: "denied" },
    geolocation: { ok: false, error: expect.stringMatching(/^GeolocationPositionError\(1\)/) },
    notifications: { ok: true, value: "denied" },
    windowManagement: { ok: false, error: expect.stringMatching(/^NotAllowedError/) },
  });

  await page.click("#display-capture");
  await expect
    .poll(async () => (await results()).displayCapture)
    .toMatchObject({ ok: false, error: expect.stringMatching(/^NotAllowedError/) });

  // Allowed ones, each alone after its own injected click, pointer lock first, with the window focused. While the
  // macOS screen is locked, pointer lock fails with WrongDocumentError whatever the handlers say (MEMORY.md, H13):
  // then the test can only check that, and says so in its annotations.
  const locked = screenLocked();
  await page.click("#pointer-lock");
  await expect
    .poll(async () => (await results()).pointerLock)
    .toEqual(
      locked
        ? { ok: false, error: expect.stringMatching(/^WrongDocumentError/) }
        : { ok: true, value: "locked" },
    );
  if (locked) {
    test.info().annotations.push({
      type: "pointer lock not verified",
      description: "the macOS screen was locked during the run",
    });
  }
  expect((await results()).focusBeforePointerLock).toBe(true);
  await page.click("#fullscreen");
  await expect
    .poll(async () => (await results()).fullscreen)
    .toEqual({ ok: true, value: "fullscreen" });
  await page.click("#keyboard-lock");
  await expect
    .poll(async () => (await results()).keyboardLock)
    .toEqual({ ok: true, value: "locked" });

  const deniedNames = async () =>
    new Set(
      (await eventsNamed(launched as Launched, "game.permission-denied")).map((l) => l.permission),
    );
  await expect
    .poll(async () =>
      [...(await deniedNames())].filter((name) => FIVE_DENIED.includes(String(name))).sort(),
    )
    .toEqual(FIVE_DENIED);
  // Chromium also checks `automatic-fullscreen` on requestFullscreen; it is denied like every other name. The three
  // allowed names are never logged as denied.
  const names = await deniedNames();
  expect(["fullscreen", "pointerLock", "keyboardLock"].filter((name) => names.has(name))).toEqual(
    [],
  );
  test.info().annotations.push({ type: "denied names", description: [...names].sort().join(", ") });
  const denials = await eventsNamed(launched, "game.permission-denied");
  expect(denials.every((line) => line.gameId === id && line.origin === pages?.origin)).toBe(true);
  // A permission that is checked repeatedly is logged once a minute at most.
  expect(denials.filter((line) => line.permission === "media")).toHaveLength(1);
});

test("navigation, new windows and downloads are refused or routed to the browser (AC-5, S-5)", async () => {
  launched = await launchApp();
  if (!pages) throw new Error("no pages");
  const { progressLab: lab } = launched;
  const entry = `${pages.origin}/navigation.html`;
  const id = await addGame(launched, entry, "navigation");
  const page = await openGame(launched, id);
  const shown = async () => (await hooks()).dialogsShown.length;

  // window.open without a user gesture still reaches the handler and is offered (observed 2026-10-28): Electron 45's
  // window-open details carry no activation flag, so only the cooldown after a Cancel limits a game (R26).
  await queueConfirm(launched, true);
  await page.evaluate(() => {
    window.open("https://gestureless.example/");
  });
  await expect
    .poll(async () => (await hooks()).externalOpened)
    .toEqual(["https://gestureless.example/"]);

  // Off-site link: prevented, asked through the queued dialog, opened only through the stub, once.
  await queueConfirm(launched, true);
  await page.evaluate(
    (href) => (window as unknown as { setLink(h: string): void }).setLink(href),
    `${lab.local}/`,
  );
  await trustedClick(page, "#link");
  await expect
    .poll(async () => (await hooks()).externalOpened)
    .toEqual(["https://gestureless.example/", `${lab.local}/`]);
  expect(page.url()).toBe(entry);

  // window.open: always denied; an http(s) target is offered, here declined.
  const before = await shown();
  await queueConfirm(launched, false);
  await page.evaluate(() => {
    (window as unknown as { popupTarget: string }).popupTarget = "https://example.org/?q=1";
  });
  await trustedClick(page, "#popup");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { popupResult?: string }).popupResult))
    .toBe("null");
  await expect.poll(shown).toBe(before + 1);
  expect((await hooks()).dialogsShown.at(-1)?.title).toBe("Open in browser?");
  expect(await windowCount(launched)).toBe(2);

  // window.open of another scheme: no dialog, nothing opened.
  await page.evaluate(() => {
    (window as unknown as { popupTarget: string; popupResult?: string }).popupTarget =
      "file:///etc/hosts";
    (window as unknown as { popupResult?: string | undefined }).popupResult = undefined;
  });
  await trustedClick(page, "#popup");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { popupResult?: string }).popupResult))
    .toBe("null");
  expect(await shown()).toBe(before + 1);
  expect((await hooks()).externalOpened).toEqual(["https://gestureless.example/", `${lab.local}/`]);
  expect(await windowCount(launched)).toBe(2);

  // Within 10 s of that Cancel the window is not asked again (R26): dropped and logged.
  await page.evaluate(() => {
    (window as unknown as { popupTarget: string; popupResult?: string }).popupTarget =
      "https://again.example/";
    (window as unknown as { popupResult?: string | undefined }).popupResult = undefined;
  });
  await trustedClick(page, "#popup");
  await expect
    .poll(async () => (await eventsNamed(launched as Launched, "game.external-cooldown")).length)
    .toBe(1);
  expect(await shown()).toBe(before + 1);
  expect((await hooks()).externalOpened).toEqual(["https://gestureless.example/", `${lab.local}/`]);

  // A download is cancelled and logged; the page stays.
  await trustedClick(page, "#download");
  await expect
    .poll(async () => (await eventsNamed(launched as Launched, "game.download-refused")).length)
    .toBe(1);
  expect(page.url()).toBe(entry);

  // Task 7a carry, ruling R25: Chromium hands will-navigate a canonical URL that escapes spaces (%20) but keeps a
  // backslash raw in the query and fragment (`?q=a\b%20c#x\y%20z`, observed 2026-10-28). Raw shapes are now refused
  // in the scheme and authority only, so both same-site navigations load.
  await page.evaluate(
    (href) => (window as unknown as { setLink(h: string): void }).setLink(href),
    "/navigation.html?q=a b#x y",
  );
  await trustedClick(page, "#link");
  await expect.poll(() => page.url()).toBe(`${pages.origin}/navigation.html?q=a%20b#x%20y`);
  await page.evaluate(
    (href) => (window as unknown as { setLink(h: string): void }).setLink(href),
    "/navigation.html?q=a\\b c#x\\y z",
  );
  await trustedClick(page, "#link");
  await expect.poll(() => page.url()).toBe(`${pages.origin}/navigation.html?q=a\\b%20c#x\\y%20z`);

  // An ordinary same-site navigation is allowed.
  await page.evaluate(
    (href) => (window as unknown as { setLink(h: string): void }).setLink(href),
    "/permissions.html?from=navigation",
  );
  await trustedClick(page, "#link");
  await page.waitForURL(`${pages.origin}/permissions.html?from=navigation`);

  const refused = await eventsNamed(launched, "game.navigation-refused");
  expect(refused.map((line) => [line.kind, line.decision, line.target])).toEqual([
    ["navigate", "ask-external", lab.local],
  ]);
});

test("redirects at start: same-site loads, cross-site is offered to the browser (Review Focus 1)", async () => {
  launched = await launchApp();
  if (!pages) throw new Error("no pages");
  const { progressLab: lab } = launched;

  const sameSite = await addGame(launched, `${pages.origin}/redirect?to=/permissions.html`, "same");
  const page = await openGame(launched, sameSite);
  expect(page.url()).toBe(`${pages.origin}/permissions.html`);

  const crossSite = await addGame(
    launched,
    `${pages.origin}/redirect?to=${encodeURIComponent(`${lab.local}/`)}`,
    "cross",
  );
  await queueConfirm(launched, true);
  expect(await launchGame(launched, crossSite)).toEqual({ ok: true, data: { window: "opened" } });
  await expect.poll(async () => (await hooks()).externalOpened).toEqual([`${lab.local}/`]);
  // Nothing was followed in the game window; the aborted load ended the launch.
  await expectState(launched, crossSite, "exited");
  expect(await windowCount(launched)).toBe(2);
  const refused = await eventsNamed(launched, "game.navigation-refused");
  expect(refused.map((line) => [line.gameId, line.kind, line.decision])).toEqual([
    [crossSite, "redirect", "ask-external"],
  ]);
});
