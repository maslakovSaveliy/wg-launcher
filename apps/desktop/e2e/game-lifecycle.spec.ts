// The game session lifecycle (architecture.md section 4): one window per game (Review Focus 3), the close procedure
// against a beforeunload trap, a hang and a crash (S-7), and no process of a game left 5 s after its window closes or
// the app quits (AC-13, S-9), with progress-lab's service worker running.

import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import {
  addGame,
  closeGame,
  eventsNamed,
  expectState,
  gameState,
  launchGame,
  openGame,
  queueConfirm,
  windowCount,
} from "./games.js";
import { type Launched, launchApp } from "./harness.js";
import { startTestPages, type TestPages } from "./test-pages.js";

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

const dialogTitles = async () =>
  (await (launched as Launched).hooks()).dialogsShown.map((d) => d.title);

const contentsIdOf = (gameId: string) =>
  (launched as Launched).app.evaluate(
    (_electron, id) => globalThis.__wgTest?.gameWebContentsId(id) ?? null,
    gameId,
  );

test("Play twice, or a launch while the game is launching, opens exactly one window (Review Focus 3)", async () => {
  launched = await launchApp();
  if (!pages) throw new Error("no pages");
  const id = await addGame(launched, `${pages.origin}/slow?ms=2500`, "slow");

  // Two launches in the same main-process turn, as a double click would send them.
  const results = await launched.app.evaluate(
    (_electron, gameId) =>
      Promise.all([
        globalThis.__wgTest?.launchGame(gameId),
        globalThis.__wgTest?.launchGame(gameId),
      ]),
    id,
  );
  expect(results).toEqual([
    { ok: true, data: { window: "opened" } },
    { ok: true, data: { window: "focused" } },
  ]);
  expect(await gameState(launched, id)).toBe("launching");
  // A deep link or shortcut arriving while the game is still launching goes through the same launch.
  expect(await launchGame(launched, id)).toEqual({ ok: true, data: { window: "focused" } });
  expect(await windowCount(launched)).toBe(2);

  await expectState(launched, id, "running");
  expect(await launchGame(launched, id)).toEqual({ ok: true, data: { window: "focused" } });
  expect(await windowCount(launched)).toBe(2);
  const launches = await eventsNamed(launched, "game.launching");
  expect(launches).toHaveLength(1);
});

test("a game whose page never answers is shown after the launching timeout and can be closed", async () => {
  test.setTimeout(60_000);
  launched = await launchApp();
  if (!pages) throw new Error("no pages");
  const id = await addGame(launched, `${pages.origin}/never`, "never");
  const launchedAt = Date.now();
  expect(await launchGame(launched, id)).toEqual({ ok: true, data: { window: "opened" } });
  const visible = async () => {
    const cid = await contentsIdOf(id);
    return (launched as Launched).app.evaluate(({ BrowserWindow, webContents }, cid) => {
      const contents = cid === null ? null : webContents.fromId(cid);
      return contents ? (BrowserWindow.fromWebContents(contents)?.isVisible() ?? null) : null;
    }, cid);
  };
  expect(await gameState(launched, id)).toBe("launching");
  expect(await visible()).toBe(false);
  // Before the timeout, a second Play shows nothing and opens nothing.
  expect(await launchGame(launched, id)).toEqual({ ok: true, data: { window: "focused" } });
  expect(await visible()).toBe(false);

  // LAUNCH_SHOW_TIMEOUT_MS is 15 s.
  await expect.poll(() => gameState(launched as Launched, id), { timeout: 25_000 }).toBe("running");
  expect(Date.now() - launchedAt).toBeGreaterThanOrEqual(14_000);
  expect(await visible()).toBe(true);
  expect((await eventsNamed(launched, "game.show-timeout")).map((line) => line.gameId)).toEqual([
    id,
  ]);

  expect(await closeGame(launched, id)).toBe(true);
  await expectState(launched, id, "exited");
  expect(await windowCount(launched)).toBe(1);
});

test("a beforeunload trap asks through the dialog and cannot keep the window (S-7)", async () => {
  launched = await launchApp();
  if (!pages) throw new Error("no pages");
  const id = await addGame(launched, `${pages.origin}/trap.html`, "trap");
  const page = await openGame(launched, id);
  // Chromium runs a beforeunload prompt only for a page that had a user gesture.
  await page.click("#arm");
  await expect(page).toHaveTitle("armed");

  await queueConfirm(launched, false);
  expect(await closeGame(launched, id)).toBe(true);
  await expect.poll(dialogTitles).toEqual(["Leave the game?"]);
  await expectState(launched, id, "running");
  const contentsId = await contentsIdOf(id);
  expect(
    await launched.app.evaluate(({ BrowserWindow, webContents }, cid) => {
      const contents = cid === null ? null : webContents.fromId(cid);
      const window = contents ? BrowserWindow.fromWebContents(contents) : null;
      return { visible: window?.isVisible() ?? null, url: contents?.getURL() ?? null };
    }, contentsId),
  ).toEqual({ visible: true, url: `${pages.origin}/trap.html` });

  await queueConfirm(launched, true);
  expect(await closeGame(launched, id)).toBe(true);
  await expect.poll(dialogTitles).toEqual(["Leave the game?", "Leave the game?"]);
  await expectState(launched, id, "exited");
  expect(await windowCount(launched)).toBe(1);
});

test("a hung game is offered Force close, and a crash ends the session as crashed (S-7)", async () => {
  launched = await launchApp();
  if (!pages) throw new Error("no pages");

  // Crash: render-process-gone → crashed, the window goes, the lock is free for the next launch.
  const crashing = await addGame(launched, `${pages.origin}/navigation.html`, "crash");
  await openGame(launched, crashing);
  await launched.app.evaluate(
    ({ webContents }, cid) => {
      if (cid !== null) webContents.fromId(cid)?.forcefullyCrashRenderer();
    },
    await contentsIdOf(crashing),
  );
  await expectState(launched, crashing, "crashed");
  expect(await windowCount(launched)).toBe(1);
  // The logger writes asynchronously: the record may follow the state change, so poll for it.
  await expect
    .poll(async () =>
      (await eventsNamed(launched as Launched, "game.crashed")).map((line) => line.gameId),
    )
    .toEqual([crashing]);

  // Hang: an endless loop in the page. Chromium never reports a renderer as unresponsive while a debugger is
  // attached (Playwright is attached to every page; observed: no event within 90 s of input to the hung page), so the
  // test emits the window's `unresponsive` event itself, against a renderer that really is hung, and checks the rest:
  // the dialog, "Force close" through forcefullyCrashRenderer, and the crashed state.
  const hanging = await addGame(launched, `${pages.origin}/trap.html`, "hang");
  const page = await openGame(launched, hanging);
  await queueConfirm(launched, true);
  await page.evaluate(() => {
    setTimeout(() => {
      for (;;) {}
    }, 50);
  });
  await sleep(300);
  const contentsId = await contentsIdOf(hanging);
  // The page no longer answers: an evaluate does not come back.
  const answered = await Promise.race([
    page
      .evaluate(() => 1)
      .then(
        () => "answered",
        () => "rejected",
      ),
    sleep(1500).then(() => "hung"),
  ]);
  expect(answered).toBe("hung");
  await launched.app.evaluate(({ BrowserWindow, webContents }, cid) => {
    const contents = cid === null ? null : webContents.fromId(cid);
    if (contents) BrowserWindow.fromWebContents(contents)?.emit("unresponsive");
  }, contentsId);
  await expect.poll(dialogTitles).toContain("The game is not responding");
  await expectState(launched, hanging, "crashed");
  expect(await windowCount(launched)).toBe(1);
  await expect
    .poll(async () =>
      (await eventsNamed(launched as Launched, "game.force-close")).map((line) => line.gameId),
    )
    .toEqual([hanging]);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface ProcessInfo {
  pid: number;
  type: string;
}

const metrics = () =>
  (launched as Launched).app.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type })),
  );

const runningWorkers = (gameId: string) =>
  (launched as Launched).app.evaluate(
    ({ session }, id) =>
      Object.keys(session.fromPartition(`persist:game:${id}`).serviceWorkers.getAllRunning())
        .length,
    gameId,
  );

test("no process of a game remains 5 s after its window closes or the app quits (AC-13, S-9)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const id = await addGame(launched, `${launched.progressLab.local}/`, "progress-lab");
  const record: Record<string, unknown> = {};

  const before: ProcessInfo[] = await metrics();
  record.before = before;
  await openGame(launched, id);
  await expect.poll(() => runningWorkers(id), { timeout: 15_000 }).toBeGreaterThan(0);
  const open: ProcessInfo[] = await metrics();
  const rendererPid = await launched.app.evaluate(
    ({ webContents }, cid) => {
      return cid === null ? null : (webContents.fromId(cid)?.getOSProcessId() ?? null);
    },
    await contentsIdOf(id),
  );
  const gamePids = open.filter((p) => !before.some((b) => b.pid === p.pid)).map((p) => p.pid);
  record.open = open;
  record.rendererPid = rendererPid;
  record.gamePids = gamePids;
  expect(rendererPid).not.toBeNull();
  expect(gamePids).toContain(rendererPid);

  const closedAt = Date.now();
  expect(await closeGame(launched, id)).toBe(true);
  let workersStoppedMs: number | null = null;
  let processesGoneMs: number | null = null;
  while (Date.now() - closedAt < 5000) {
    if (workersStoppedMs === null && (await runningWorkers(id)) === 0)
      workersStoppedMs = Date.now() - closedAt;
    if (processesGoneMs === null && gamePids.every((pid) => !alive(pid)))
      processesGoneMs = Date.now() - closedAt;
    await sleep(100);
  }
  const after: ProcessInfo[] = await metrics();
  record.afterClose5s = after;
  record.workersStoppedMs = workersStoppedMs;
  record.processesGoneMs = processesGoneMs;
  record.aliveAfterClose5s = gamePids.filter(alive);
  record.workersAfterClose5s = await runningWorkers(id);
  console.log(`AC-13 close record: ${JSON.stringify(record)}`);
  expect(await gameState(launched, id)).toBe("exited");
  expect(await runningWorkers(id)).toBe(0);
  expect(gamePids.filter(alive)).toEqual([]);
  expect(after.filter((p) => gamePids.includes(p.pid))).toEqual([]);
  expect(await eventsNamed(launched, "SW_STOP_FAILED")).toEqual([]);

  // Quit with the game open again: the quit runs the same procedure, then nothing of the bundle remains.
  await openGame(launched, id);
  await expect.poll(() => runningWorkers(id), { timeout: 15_000 }).toBeGreaterThan(0);
  const atQuit: ProcessInfo[] = await metrics();
  record.atQuit = atQuit;
  const mainPid = launched.app.process().pid;
  const quitAt = Date.now();
  await launched.app.close();
  record.quitMs = Date.now() - quitAt;
  // The quit ran the close procedure for the open game before the process went (exiting would kill the children
  // anyway, so the process list alone proves nothing about the procedure): its records are in the log.
  expect((await eventsNamed(launched, "app.quit-closing-games")).map((line) => line.count)).toEqual(
    [1],
  );
  expect((await eventsNamed(launched, "game.closing")).map((line) => line.gameId)).toEqual([
    id,
    id,
  ]);
  expect((await eventsNamed(launched, "game.exited")).map((line) => line.gameId)).toEqual([id, id]);
  await sleep(5000);
  const bundlePids = [...atQuit.map((p) => p.pid), ...(mainPid ? [mainPid] : [])];
  record.aliveAfterQuit5s = bundlePids.filter(alive);
  console.log(`AC-13 record: ${JSON.stringify(record)}`);
  test.info().annotations.push({ type: "AC-13", description: JSON.stringify(record) });
  expect(bundlePids.filter(alive)).toEqual([]);
});
