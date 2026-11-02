// Window state, fullscreen and playtime wired into the real windows (Phase 1 Task 10): the automated part of AC-18
// (bounds and fullscreen restored on the next launch, the toggle, a short Esc reaches the game, Esc held 1.5 s ends a
// fullscreen the launcher set) and of AC-14 (the card shows playtime and badges from recorded state only), the playtime
// rules of architecture.md section 10 at close and at start-up, and how Esc ends a fullscreen the page requested (plan
// open check 9). The manual AC-18 run with real input is in the Task 16 checklist.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { addGame, closeGame, eventsNamed, expectState, openGame } from "./games.js";
import { type Launched, launchApp, startProgressLab } from "./harness.js";
import { startTestPages, type TestPages } from "./test-pages.js";

let launched: Launched | undefined;
let pages: TestPages | undefined;
const dirs: string[] = [];
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await pages?.stop();
  pages = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface WindowInfo {
  normal: { x: number; y: number; width: number; height: number };
  fullscreen: boolean;
}

/** The game window's normal bounds and fullscreen flag, or null when it has no window. */
function windowInfo(app: Launched, gameId: string): Promise<WindowInfo | null> {
  return app.app.evaluate(({ BrowserWindow, webContents }, id) => {
    const wcId = globalThis.__wgTest?.gameWebContentsId(id);
    const contents = wcId == null ? undefined : webContents.fromId(wcId);
    const window = contents ? BrowserWindow.fromWebContents(contents) : null;
    return window ? { normal: window.getNormalBounds(), fullscreen: window.isFullScreen() } : null;
  }, gameId);
}

/** Runs one action on the game window in the main process. */
function onWindow(
  app: Launched,
  gameId: string,
  action:
    | { kind: "bounds"; x: number; y: number; width: number; height: number }
    | { kind: "fullscreen"; flag: boolean }
    | { kind: "key"; type: "keyDown" | "keyUp" },
): Promise<void> {
  return app.app.evaluate(
    ({ BrowserWindow, webContents }, [id, action]) => {
      const wcId = globalThis.__wgTest?.gameWebContentsId(id);
      const contents = wcId == null ? undefined : webContents.fromId(wcId);
      const window = contents ? BrowserWindow.fromWebContents(contents) : null;
      if (!contents || !window) throw new Error("no game window");
      if (action.kind === "bounds") {
        const { x, y, width, height } = action;
        window.setBounds({ x, y, width, height });
      } else if (action.kind === "fullscreen") {
        window.setFullScreen(action.flag);
      } else {
        // Input through the window's own input path, which reaches `before-input-event` (MEMORY.md).
        contents.focus();
        contents.sendInputEvent({ type: action.type, keyCode: "Escape" });
      }
    },
    [gameId, action] as const,
  );
}

const windowStateOf = (app: Launched, gameId: string) =>
  app.app.evaluate((_electron, id) => globalThis.__wgTest?.windowStateOf(id) ?? null, gameId);
const playtimeOf = (app: Launched, gameId: string) =>
  app.app.evaluate((_electron, id) => globalThis.__wgTest?.playtimeOf(id) ?? null, gameId);

const keysSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { keys: Array<{ type: string }> }).keys);

async function expectFullscreen(app: Launched, gameId: string, flag: boolean) {
  await expect
    .poll(async () => (await windowInfo(app, gameId))?.fullscreen, { timeout: 10_000 })
    .toBe(flag);
}

async function relaunch(app: Launched, gameId: string): Promise<Page> {
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
  return openGame(app, gameId);
}

test("bounds and fullscreen are restored on the next launch; Esc reaches the game and held 1.5 s ends the launcher's fullscreen (AC-18)", async () => {
  test.setTimeout(120_000);
  pages = await startTestPages();
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${pages.origin}/keys.html`, "keys");

  // The toggle is the menu item with role togglefullscreen; nothing in the menu takes Esc.
  const menu = await app.app.evaluate(({ Menu }) => {
    const items: Array<{ role: string | null; accelerator: string | null }> = [];
    const walk = (menu: Electron.Menu | null) => {
      for (const item of menu?.items ?? []) {
        items.push({ role: item.role ?? null, accelerator: item.accelerator ?? null });
        walk(item.submenu ?? null);
      }
    };
    walk(Menu.getApplicationMenu());
    return items;
  });
  expect(menu.filter((item) => item.role?.toLowerCase() === "togglefullscreen")).toHaveLength(1);
  expect(menu.filter((item) => /esc/i.test(item.accelerator ?? ""))).toEqual([]);

  // Inside the primary display's work area with a margin: macOS moves a window that is shown partly below the work
  // area up until it fits (a frame 32 px below came back 32 px higher on the dev Mac, and 140 + 600 did not fit the
  // macOS runner's display), so bounds that do not fit would not come back as saved (MEMORY.md).
  const area = await app.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const bounds = {
    x: area.x + 40,
    y: area.y + 40,
    width: Math.min(900, area.width - 80),
    height: Math.min(600, area.height - 80),
  };
  let page = await openGame(app, gameId);

  await test.step("bounds are saved after a move and resize (debounced) and restored", async () => {
    await onWindow(app, gameId, { kind: "bounds", ...bounds });
    await expect
      .poll(async () => windowStateOf(app, gameId), { timeout: 5_000 })
      .toMatchObject({ ...bounds, maximized: false, fullscreen: false });
    page = await relaunch(app, gameId);
    expect(await windowInfo(app, gameId)).toEqual({ normal: bounds, fullscreen: false });
  });

  // The menu role's own click on macOS goes through AppKit (Task 16 checks it by hand); here the window method the
  // role calls is used, which is what the saved state and the Esc hold see.
  await test.step("a fullscreen the launcher set is saved with the normal bounds and restored", async () => {
    await onWindow(app, gameId, { kind: "fullscreen", flag: true });
    await expectFullscreen(app, gameId, true);
    page = await relaunch(app, gameId);
    expect(await windowStateOf(app, gameId)).toMatchObject({ ...bounds, fullscreen: true });
    await expectFullscreen(app, gameId, true);
    // The normal bounds settle when macOS has finished the fullscreen transition.
    await expect.poll(async () => (await windowInfo(app, gameId))?.normal).toEqual(bounds);
  });

  await test.step("a short Esc reaches the page and leaves the fullscreen alone", async () => {
    await onWindow(app, gameId, { kind: "key", type: "keyDown" });
    await onWindow(app, gameId, { kind: "key", type: "keyUp" });
    await expect
      .poll(() => keysSeen(page))
      .toEqual([
        { type: "keydown", repeat: false, prevented: false },
        { type: "keyup", repeat: false, prevented: false },
      ]);
    await page.waitForTimeout(2_000);
    expect((await windowInfo(app, gameId))?.fullscreen).toBe(true);
  });

  await test.step("Esc held for 1.5 s reaches the page too and ends the launcher's fullscreen", async () => {
    await onWindow(app, gameId, { kind: "key", type: "keyDown" });
    await page.waitForTimeout(1_700);
    await onWindow(app, gameId, { kind: "key", type: "keyUp" });
    await expectFullscreen(app, gameId, false);
    expect((await keysSeen(page)).map((key) => key.type)).toEqual([
      "keydown",
      "keyup",
      "keydown",
      "keyup",
    ]);
    await expect
      .poll(async () => (await eventsNamed(app, "game.fullscreen-esc-exit")).length)
      .toBe(1);
  });

  await test.step("the state at close is what the next launch gets", async () => {
    await relaunch(app, gameId);
    expect(await windowStateOf(app, gameId)).toMatchObject({ ...bounds, fullscreen: false });
    expect(await windowInfo(app, gameId)).toEqual({ normal: bounds, fullscreen: false });
  });
});

/**
 * A real (trusted) mouse click at the element's center (game-isolation.spec.ts has the same helper): a fullscreen
 * request needs a user gesture.
 */
async function trustedClick(page: Page, selector: string): Promise<void> {
  const center = await page.evaluate((sel) => {
    const box = document.querySelector(sel)?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  }, selector);
  if (!center) throw new Error(`${selector} is not on the page`);
  await page.mouse.click(center.x, center.y);
}

/**
 * Records the fullscreen events of the game's current window (`enter-html-full-screen` when the page asks,
 * `enter-full-screen` when the window's transition has finished, and their `leave-*` pairs). `read` returns the events
 * since the last `take`, sorted, and `take` drops them: the order inside a pair differs by platform (macOS sent the
 * `html` one first, Linux the window's one first; MEMORY.md), so each step compares its pair as a set.
 */
async function recordFullscreen(
  app: Launched,
  gameId: string,
): Promise<{ read(): Promise<string[]>; take(): Promise<void> }> {
  await app.app.evaluate(({ BrowserWindow, webContents }, id) => {
    const wcId = globalThis.__wgTest?.gameWebContentsId(id);
    const contents = wcId == null ? undefined : webContents.fromId(wcId);
    const window = contents ? BrowserWindow.fromWebContents(contents) : null;
    if (!window) throw new Error("no game window");
    const events: string[] = [];
    (globalThis as unknown as { fullscreenEvents: string[] }).fullscreenEvents = events;
    for (const name of [
      "enter-html-full-screen",
      "leave-html-full-screen",
      "enter-full-screen",
      "leave-full-screen",
    ] as const) {
      window.on(name as "enter-full-screen", () => events.push(name));
    }
  }, gameId);
  return {
    read: () =>
      app.app.evaluate(() =>
        [
          ...((globalThis as unknown as { fullscreenEvents?: string[] }).fullscreenEvents ?? []),
        ].sort(),
      ),
    take: () =>
      app.app.evaluate(() => {
        (globalThis as unknown as { fullscreenEvents?: string[] }).fullscreenEvents?.splice(0);
      }),
  };
}

test("Esc ends a fullscreen the page requested, as Chromium handles it (plan open check 9)", async () => {
  pages = await startTestPages();
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${pages.origin}/keys.html`, "keys");
  const page = await openGame(app, gameId);
  const pageFullscreen = () => page.evaluate(() => document.fullscreenElement !== null);
  const events = await recordFullscreen(app, gameId);
  const ENTER = ["enter-full-screen", "enter-html-full-screen"];
  const LEAVE = ["leave-full-screen", "leave-html-full-screen"];

  await trustedClick(page, "#fullscreen");
  // Each step waits for the window's own transition to finish (its `*-full-screen` event): macOS animates into and
  // out of fullscreen after `isFullScreen()` has already changed, and input sent during the animation can be lost.
  await expect.poll(events.read, { timeout: 10_000 }).toEqual(ENTER);
  await events.take();
  // The document's own fullscreen state follows the window's events: on the Linux runner `document.fullscreenElement`
  // was still null right after both enter events (MEMORY.md), so it is polled, as below.
  await expect.poll(pageFullscreen).toBe(true);
  await onWindow(app, gameId, { kind: "key", type: "keyDown" });
  await onWindow(app, gameId, { kind: "key", type: "keyUp" });
  await expect.poll(events.read, { timeout: 10_000 }).toEqual(LEAVE);
  await events.take();
  await expect.poll(pageFullscreen).toBe(false);
  await expectFullscreen(app, gameId, false);
  // Chromium consumes the Esc that ends a page's fullscreen, as browsers do: the page does not see it. The launcher
  // took nothing (it has no Esc hold for a page's fullscreen).
  expect(await keysSeen(page)).toEqual([]);
  expect(await eventsNamed(app, "game.fullscreen-esc-exit")).toEqual([]);

  // A game closed in its own fullscreen is saved as not fullscreen, so it does not come back as the launcher's.
  // macOS refuses a fullscreen request while the Space of the one just left is still animating away, with no event
  // (MEMORY.md); a request at once after `leave-full-screen` was refused in 3 of 6 runs on the dev Mac, so wait first.
  await page.waitForTimeout(1_000);
  await trustedClick(page, "#fullscreen");
  await expect.poll(events.read, { timeout: 10_000 }).toEqual(ENTER);
  await expect.poll(pageFullscreen).toBe(true);
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
  expect(await windowStateOf(app, gameId)).toMatchObject({ fullscreen: false });
});

test("the card shows playtime and badges from recorded state only; short sessions are dropped at close and at start-up (AC-14, AC-15 wiring)", async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), "wg-e2e-"));
  dirs.push(userData);
  // A server of its own, so the game's URL survives the restart.
  const lab = await startProgressLab();
  try {
    launched = await launchApp({ userData });
    let app = launched;
    const gameId = await addGame(app, `${lab.local}/`, "Timed game");
    const card = () => app.launcher.locator(`li.card[data-game-id="${gameId}"]`);
    const reloadLibrary = async () => {
      await app.launcher.getByRole("button", { name: "Settings" }).click();
      await app.launcher.getByRole("button", { name: "Library" }).click();
    };
    await reloadLibrary();
    await expect(card().getByRole("list", { name: "Badges" }).locator("li")).toHaveText([
      "By link",
      "Needs internet",
      "Compatibility not verified",
    ]);
    await expect(card()).not.toContainText("Playtime");
    await expect(card()).not.toContainText("Last launched");

    // A launch records last_launched_at; a session closed with under 10 s of active time is deleted.
    await openGame(app, gameId);
    await closeGame(app, gameId);
    await expectState(app, gameId, "exited");
    await expect
      .poll(async () => playtimeOf(app, gameId), { timeout: 5_000 })
      .toEqual({ sessions: [], lastLaunchedAt: expect.any(Number) });
    await expect(card()).toContainText("Last launched");
    await expect(card()).not.toContainText("Playtime");
    await expect
      .poll(() => eventsNamed(app, "game.playtime"))
      .toEqual([expect.objectContaining({ gameId, kept: false })]);

    // Recorded state, and only that, changes the card.
    await app.app.evaluate((_electron, id) => {
      globalThis.__wgTest?.seedPlaySession(id, 125_000, true);
      globalThis.__wgTest?.saveStorageCheck(id, true);
    }, gameId);
    await reloadLibrary();
    await expect(card()).toContainText("Playtime 2 min");
    await expect(card().getByRole("list", { name: "Badges" }).locator("li")).toHaveText([
      "By link",
      "Needs internet",
      /^Local data \(checked .+\)$/,
      "Compatibility not verified",
    ]);
    await app.app.evaluate((_electron, id) => {
      globalThis.__wgTest?.saveStorageCheck(id, false);
      // Two sessions a crash left unfinished: one under 10 s, one over.
      globalThis.__wgTest?.seedPlaySession(id, 5_000, false);
      globalThis.__wgTest?.seedPlaySession(id, 20_000, false);
    }, gameId);
    await reloadLibrary();
    await expect(card()).not.toContainText("Local data");
    await launched.close();
    launched = undefined;

    // At start-up the short unfinished session is deleted and the long one ended.
    launched = await launchApp({ userData });
    app = launched;
    const sessions = (await playtimeOf(app, gameId))?.sessions ?? [];
    expect(sessions.map((s) => s.activeMs)).toEqual([125_000, 20_000]);
    expect(sessions.every((s) => s.endedAt !== null)).toBe(true);
    await expect(card()).toContainText("Playtime 2 min");
    await expect
      .poll(() => eventsNamed(app, "playtime.settled"))
      .toEqual([expect.objectContaining({ deleted: 1, ended: 1 })]);
  } finally {
    await launched?.close();
    launched = undefined;
    await lab.stop();
  }
});
