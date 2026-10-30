// Shortcuts and launch arguments (Phase 1 Task 11): the automated part of AC-19 and the shortcut part of AC-1 and
// F-8 through `--launch-game=<id>` (plan M13). The `wglauncher://` scheme and opening an `.inetloc` are checked by
// hand on the packaged app (Task 16 checklist).

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { uuidv7 } from "@wg-launcher/shared";
import {
  addGame,
  eventsNamed,
  expectState,
  gameState,
  logLines,
  openGame,
  windowCount,
} from "./games.js";
import { type Launched, launchApp, runSecondInstance, startProgressLab } from "./harness.js";

let launched: Launched | undefined;
const dirs: string[] = [];
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wg-e2e-"));
  dirs.push(dir);
  return dir;
}

/** The game window's minimized and visible flags, or null when the game has no window. */
function gameWindowState(app: Launched, gameId: string) {
  return app.app.evaluate(({ BrowserWindow, webContents }, id) => {
    const wcId = globalThis.__wgTest?.gameWebContentsId(id);
    const contents = wcId == null ? undefined : webContents.fromId(wcId);
    const window = contents ? BrowserWindow.fromWebContents(contents) : null;
    return window ? { minimized: window.isMinimized(), visible: window.isVisible() } : null;
  }, gameId);
}

const notices = async (app: Launched) =>
  (await app.hooks()).dialogsShown.filter((dialog) => dialog.kind === "notify");

test("--launch-game=<id> opens that game at start-up, and a second instance with it focuses the one window (AC-19, AC-1)", async () => {
  test.setTimeout(90_000);
  const userData = await tempDir();
  const lab = await startProgressLab();
  try {
    launched = await launchApp({ userData });
    const gameId = await addGame(launched, `${lab.local}/`, "Shortcut game");
    const first = launched;
    await first.close();
    // The log is written asynchronously, so the first start's own record may or may not have reached the file
    // before it closed; only the records after it count.
    const before = (await eventsNamed(first, "launch.input")).length;

    // First start with the argument, as the Windows shortcut does.
    launched = await launchApp({ userData, extraArgs: [`--launch-game=${gameId}`] });
    const app = launched;
    await expectState(app, gameId, "running");
    expect(await windowCount(app)).toBe(2);
    await expect
      .poll(async () => (await eventsNamed(app, "launch.input")).slice(before))
      .toEqual([expect.objectContaining({ source: "argv", result: "valid", gameId })]);

    // Under bare xvfb-run (Linux CI) minimize is never applied (see launcher.spec.ts): hide instead.
    const hide = process.platform === "linux";
    await app.app.evaluate(
      ({ BrowserWindow, webContents }, [id, hide]) => {
        const wcId = globalThis.__wgTest?.gameWebContentsId(id as string);
        const contents = wcId == null ? undefined : webContents.fromId(wcId);
        const window = contents ? BrowserWindow.fromWebContents(contents) : null;
        if (hide) window?.hide();
        else window?.minimize();
      },
      [gameId, hide] as const,
    );
    await expect
      .poll(async () => {
        const state = await gameWindowState(app, gameId);
        return hide ? state?.visible === false : state?.minimized;
      })
      .toBe(true);

    expect(await runSecondInstance(userData, [`--launch-game=${gameId}`])).toBe(0);
    await expect
      .poll(() => gameWindowState(app, gameId))
      .toEqual({ minimized: false, visible: true });
    expect(await windowCount(app)).toBe(2);
    expect((await app.hooks()).secondInstances).toBe(1);
    await expect
      .poll(async () => (await eventsNamed(app, "game.launch-while-active")).length)
      .toBe(1);
    expect(await notices(app)).toEqual([]);
  } finally {
    await launched?.close();
    launched = undefined;
    await lab.stop();
  }
});

test("a second instance with a malformed or unknown id shows the library with a notice and opens nothing (AC-19, S-11)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const before = app.launcher.url();
  const unknown = uuidv7();
  const hostile = "--launch-game=https://evil.example/?token=SECRET-TOKEN";

  for (const args of [
    [hostile],
    [`wglauncher://launch/${unknown.toUpperCase()}`],
    [`--launch-game=${unknown}`, `--launch-game=${unknown}`],
  ]) {
    expect(await runSecondInstance(app.userData, args)).toBe(0);
  }
  await expect
    .poll(async () => (await notices(app)).map((notice) => notice.title))
    .toEqual([
      "The launch link is not valid",
      "The launch link is not valid",
      "The launch link is not valid",
    ]);

  expect(await runSecondInstance(app.userData, [`--launch-game=${unknown}`])).toBe(0);
  await expect
    .poll(async () => (await notices(app)).at(-1)?.title)
    .toBe("The game is not in the library");

  // Nothing opened and nothing navigated: one window, the launcher page as before.
  expect(await windowCount(app)).toBe(1);
  expect(app.launcher.url()).toBe(before);
  expect(await eventsNamed(app, "game.launching")).toEqual([]);
  const inputs = await eventsNamed(app, "launch.input");
  expect(inputs).toEqual([
    expect.objectContaining({ result: "none", source: "argv" }),
    expect.objectContaining({ result: "invalid", length: hostile.length }),
    expect.objectContaining({ result: "invalid" }),
    expect.objectContaining({ result: "invalid" }),
    expect.objectContaining({ result: "valid", gameId: unknown }),
  ]);
  // The input itself is never logged (security.md section 9).
  const log = JSON.stringify(await logLines(app));
  expect(log).not.toContain("SECRET-TOKEN");
  expect(log).not.toContain("evil.example");
});

test("a launch request after the launcher was closed while a game runs opens the launcher again with the notice", async () => {
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "Running game");
  await openGame(app, gameId);
  const launcherWindows = () =>
    app.app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter(
          (window) =>
            !window.isDestroyed() && window.webContents.getURL().startsWith("app://launcher"),
        ).length,
    );
  await app.app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL().startsWith("app://launcher")) window.close();
    }
  });
  await expect.poll(launcherWindows).toBe(0);
  expect(await gameState(app, gameId)).toBe("running");

  expect(await runSecondInstance(app.userData, [`--launch-game=${uuidv7()}`])).toBe(0);
  await expect.poll(launcherWindows).toBe(1);
  await expect
    .poll(async () => (await notices(app)).map((notice) => notice.title))
    .toEqual(["The game is not in the library"]);
  expect(await windowCount(app)).toBe(2);
});

test("Create shortcut writes an .inetloc with the deep link and nothing else; no per-game bundle exists (F-8)", async () => {
  launched = await launchApp();
  const app = launched;
  const lab = app.progressLab;
  const gameId = await addGame(app, `${lab.local}/`, "Shortcut game");
  const target = await tempDir();
  await app.app.evaluate(
    (_electron, path) => globalThis.__wgTest?.queueDialogAnswer({ kind: "saveFile", value: path }),
    join(target, "Shortcut game"),
  );
  await app.launcher.getByRole("button", { name: "Settings" }).click();
  await app.launcher.getByRole("button", { name: "Library" }).click();
  const card = app.launcher.locator(`li.card[data-game-id="${gameId}"]`);
  await expect(card.getByRole("button", { name: "Play" })).toBeVisible();
  if (process.platform !== "darwin" && process.platform !== "win32") {
    // Linux is not a target yet: no control is offered that could only fail.
    await expect(card.getByRole("button", { name: "Create shortcut" })).toHaveCount(0);
    return;
  }
  await card.getByRole("button", { name: "Create shortcut" }).click();
  await expect.poll(() => readdir(target)).toEqual(["Shortcut game.inetloc"]);
  expect(await readFile(join(target, "Shortcut game.inetloc"), "utf8")).toBe(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "\t<key>URL</key>",
      `\t<string>wglauncher://launch/${gameId}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  await expect(card.getByRole("alert")).toHaveCount(0);
  // The shortcut is the only new file: no app bundle or script was made for the game.
  const made = await readdir(app.userData, { recursive: true });
  expect(made.filter((name) => /\.(app|command|sh|webloc|inetloc|lnk)$/.test(name))).toEqual([]);
});
