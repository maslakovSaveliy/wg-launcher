// The quiescent window's evidence in Electron 45 (save-transfer.md section 5): the canary's calibration on a clean
// job, the canary against an injected main-world script and a started service worker (S-13), the no-bypass iframe
// control (open check 3), and a storage check that a launch cancels (plan M5).

import { expect, test } from "@playwright/test";
import {
  addGame,
  closeGame,
  eventsNamed,
  expectState,
  launchGame,
  openGame,
  progressLab,
  windowCount,
} from "./games.js";
import { type Launched, launchApp } from "./harness.js";
import { exportSnapshot, leftovers, setQuiescentControl, snapshotRows } from "./snapshots.js";

let launched: Launched | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

async function played(
  app: Launched,
  steps: number,
  options: { path?: string; frame?: boolean } = {},
) {
  const gameId = await addGame(
    app,
    `${app.progressLab.local}${options.path ?? "/"}`,
    "progress-lab",
  );
  const page = await openGame(app, gameId);
  await progressLab(options.frame ? page.frameLocator("#game-frame") : page).play(steps);
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
  return gameId;
}

const iframeHost = (app: Launched) =>
  `/iframe-host.html?src=${encodeURIComponent(`${app.progressLab.loopback}/`)}`;

test("calibration: a clean job parses only Electron's isolated-world scripts and our preload", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const plain = await played(app, 3);
  const framed = await played(app, 3, { path: iframeHost(app), frame: true });
  expect((await exportSnapshot(app, plain)).ok).toBe(true);
  const frameKey = { origin: app.progressLab.loopback, topLevelSite: "http://localhost" };
  expect((await exportSnapshot(app, framed, { frameKeys: [frameKey] })).ok).toBe(true);

  // The exports' jobs (task leases); the storage checks after each exit are background jobs.
  const exports = async () =>
    (await eventsNamed(app, "snapshot.quiescent.clean")).filter((line) => line.lock === "task");
  await expect.poll(async () => (await exports()).length).toBe(2);
  expect(await eventsNamed(app, "snapshot.quiescent.violation")).toEqual([]);
  const clean = await exports();
  expect(clean.map((line) => line.gameId)).toEqual([plain, framed]);
  for (const line of clean) {
    const scripts = line.scripts as Record<string, number>;
    expect(Object.keys(scripts).sort()).toEqual([
      "electron",
      "harness",
      "isolatedWorldSetUp",
      "preload",
    ]);
    // about:blank and each stub document: Electron's event-emitter module, the preload and `void 0` each time.
    expect(scripts.preload).toBeGreaterThanOrEqual(2);
    expect(scripts.electron).toBe(scripts.preload);
    expect(scripts.isolatedWorldSetUp).toBe(scripts.preload);
  }
  // One more document in the iframe job: the cross-site iframe's own.
  const preloads = clean.map((line) => (line.scripts as Record<string, number>).preload);
  expect(preloads[1]).toBe((preloads[0] ?? 0) + 1);
  // Nothing but the stubs was asked for, so the interceptor refused nothing.
  expect(clean.map((line) => line.refused)).toEqual([0, 0]);
});

test("the canary stops a job when a script runs in the window's main world (S-13)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await played(app, 3);
  await setQuiescentControl(app, { kind: "main-world-script", lock: "task" });
  expect(await exportSnapshot(app, gameId)).toMatchObject({
    ok: false,
    code: "EXP_QUIESCENCE_VIOLATION",
  });
  await expect
    .poll(() => eventsNamed(app, "snapshot.quiescent.violation"))
    .toEqual([
      expect.objectContaining({ gameId, violation: "script-outside-preload", world: "default" }),
    ]);
  expect(await leftovers(app, gameId)).toEqual({ tmp: [], snapshots: [] });
  expect(await snapshotRows(app, gameId)).toEqual([]);
});

test("the canary stops a job when the game's service worker starts during it (S-13)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await played(app, 3);
  await setQuiescentControl(app, {
    kind: "start-worker",
    scope: `${app.progressLab.local}/`,
    lock: "task",
  });
  expect(await exportSnapshot(app, gameId)).toMatchObject({
    ok: false,
    code: "EXP_QUIESCENCE_VIOLATION",
  });
  await expect
    .poll(async () => (await eventsNamed(app, "snapshot.quiescent.violation")).length)
    .toBe(1);
  const [violation] = await eventsNamed(app, "snapshot.quiescent.violation");
  expect(["service-worker-started", "worker-target"]).toContain(violation?.violation);
  expect(await leftovers(app, gameId)).toEqual({ tmp: [], snapshots: [] });
  expect(await snapshotRows(app, gameId)).toEqual([]);
});

test("no-bypass iframe control: without any bypass the iframe's worker runs; the page-level bypass alone and the full bypass keep it out (open check 3)", async () => {
  test.setTimeout(120_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await played(app, 3, { path: iframeHost(app), frame: true });
  const frameKeys = [{ origin: app.progressLab.loopback, topLevelSite: "http://localhost" }];

  // Control: the cross-site iframe's own (partitioned) worker controls its stub without a bypass.
  expect(await exportSnapshot(app, gameId, { frameKeys, test: { bypass: "none" } })).toMatchObject({
    ok: false,
    code: "EXP_QUIESCENCE_VIOLATION",
  });
  await expect
    .poll(async () => (await eventsNamed(app, "snapshot.quiescent.violation")).length)
    .toBe(1);
  // A worker of the session started: the iframe's own, partitioned under the top-level site (its scope is the
  // iframe's origin; the top-level page, iframe-host.html, registers none).
  expect(await eventsNamed(app, "snapshot.quiescent.violation")).toEqual([
    expect.objectContaining({ gameId, violation: "service-worker-started" }),
  ]);
  const started = (await eventsNamed(app, "snapshot.quiescent.worker-status")).filter(
    (line) => line.gameId === gameId,
  );
  expect(started.length).toBeGreaterThan(0);
  expect(new Set(started.map((line) => line.scopeOrigin))).toEqual(
    new Set([app.progressLab.loopback]),
  );

  // The page-level bypass only (no bypass sent to the iframe's own target).
  const pageOnly = await exportSnapshot(app, gameId, { frameKeys, test: { bypass: "top-only" } });
  // The full bypass: page level and every child target.
  const full = await exportSnapshot(app, gameId, { frameKeys, test: { bypass: "all" } });
  test.info().annotations.push({
    type: "open check 3",
    description: `page-level bypass only: ${pageOnly.ok ? "clean" : pageOnly.code}; full bypass: ${full.ok ? "clean" : full.code}`,
  });
  expect(pageOnly.ok).toBe(true);
  expect(full.ok).toBe(true);
  expect(await eventsNamed(app, "snapshot.quiescent.violation")).toHaveLength(1);
});

/** The background jobs of a game (the storage checks), by log event. */
const background = async (app: Launched, event: string, gameId: string) =>
  (await eventsNamed(app, event)).filter(
    (line) => line.lock === "background" && line.gameId === gameId,
  );

test("a storage check runs after a game window exits and records local data (architecture.md section 11)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await played(app, 2);
  await expect
    .poll(async () =>
      (await eventsNamed(app, "snapshot.storage-check.done")).map((line) => line.gameId),
    )
    .toEqual([gameId]);
  expect((await eventsNamed(app, "snapshot.storage-check.done"))[0]).toMatchObject({
    hasData: true,
  });
  // The check's hidden window is gone again: only the launcher is left.
  await expect.poll(() => windowCount(app)).toBe(1);
});

test("a launch cancels a running storage check (M5)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  await setQuiescentControl(app, { kind: "hold", ms: 5000, lock: "background" });
  const gameId = await played(app, 2);
  await expect
    .poll(async () => (await background(app, "snapshot.quiescent.navigated", gameId)).length, {
      timeout: 20_000,
    })
    .toBe(1);
  const startedAt = Date.now();
  expect(await launchGame(app, gameId)).toEqual({ ok: true, data: { window: "opened" } });
  // The launch waited for the job to let go (at most 2 s), not for the 5 s hold.
  expect(Date.now() - startedAt).toBeLessThan(2500);
  await expectState(app, gameId, "running");
  await expect
    .poll(async () =>
      (await background(app, "snapshot.job.failed", gameId)).map((line) => line.code),
    )
    .toEqual(["CANCELLED"]);
  expect(await eventsNamed(app, "snapshot.storage-check.done")).toEqual([]);
  expect(await windowCount(app)).toBe(2);
});

test("an export right after the close cancels the running storage check and succeeds", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  await setQuiescentControl(app, { kind: "hold", ms: 5000, lock: "background" });
  const gameId = await played(app, 2);
  await expect
    .poll(async () => (await background(app, "snapshot.quiescent.navigated", gameId)).length, {
      timeout: 20_000,
    })
    .toBe(1);
  const startedAt = Date.now();
  expect((await exportSnapshot(app, gameId)).ok).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(5000);
  await expect
    .poll(async () =>
      (await background(app, "snapshot.job.failed", gameId)).map((line) => line.code),
    )
    .toEqual(["CANCELLED"]);
});

test("no storage check runs while another game window is focused", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const first = await addGame(app, `${app.progressLab.local}/`, "first");
  const second = await addGame(app, `${app.progressLab.local}/`, "second");
  await progressLab(await openGame(app, first)).play(1);
  await openGame(app, second);
  await app.app.evaluate((_electron, id) => globalThis.__wgTest?.focusGameWindow(id), second);
  await expect
    .poll(() => app.app.evaluate(() => globalThis.__wgTest?.gameWindowFocused() ?? false))
    .toBe(true);
  await closeGame(app, first);
  await expectState(app, first, "exited");
  // Longer than the quiet time after the exit (2 s) with the second game focused: no check starts.
  await new Promise((resolve) => setTimeout(resolve, 3500));
  expect(await eventsNamed(app, "snapshot.job.start")).toEqual([]);
  // Once no game window is focused any more (here: the second one closes), both games are checked.
  await closeGame(app, second);
  await expectState(app, second, "exited");
  await expect
    .poll(
      async () =>
        (await eventsNamed(app, "snapshot.storage-check.done")).map((line) => line.gameId).sort(),
      { timeout: 15_000 },
    )
    .toEqual([first, second].sort());
});
