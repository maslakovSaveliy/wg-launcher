// Snapshot export through the quiescent window (save-transfer.md sections 5 to 7) on progress-lab, in the real
// Electron 45 test build: the plain, service-worker and cross-site iframe variants (AC-7 export part), an export
// refused while the window is open (AC-11), a session with cookies, Cache Storage and a worker (AC-20, S-17), save
// data above a limit (Review Focus 4), a failing disk (Review Focus 5), the flush state, the key-generator probe in
// Electron, and the IPC path with its progress events.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { TaskProgressEvent } from "@wg-launcher/shared";
import { addGame, closeGame, eventsNamed, expectState, openGame, progressLab } from "./games.js";
import { type Launched, launchApp } from "./harness.js";
import { entriesOf, exportSnapshot, leftovers, snapshotRows, validated } from "./snapshots.js";

let launched: Launched | undefined;
const dirs: string[] = [];
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Adds progress-lab at `path`, plays `steps` steps (in `frame` when given), closes the window as the user does. */
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
  const lab = progressLab(options.frame ? page.frameLocator("#game-frame") : page);
  await lab.play(steps);
  const hash = await lab.ready();
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
  return { gameId, hash, page };
}

const ok = <T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
};

/** The keys of progress-lab's `stepLog` store, read in the game page. */
const stepLogKeys = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const open = indexedDB.open("progress-lab");
        open.onsuccess = () => {
          const request = open.result.transaction("stepLog").objectStore("stepLog").getAllKeys();
          request.onsuccess = () => resolve(request.result as number[]);
          request.onerror = () => reject(request.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );

test("exports progress-lab (plain): a validated file, a row, unconfirmed flush, no leftovers", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const { gameId } = await played(app, 7);
  const row = ok(await exportSnapshot(app, gameId));

  const file = await validated(app, row);
  expect(file.manifest).toMatchObject({
    gameId,
    revisionId: row.revisionId,
    parentRevisionId: null,
    exporter: { id: "generic-web-storage", version: "1.0.0" },
    // The adapter matches http://localhost:4317 only; this server has a free port.
    adapter: null,
    flushState: "unconfirmed",
    storageKeys: [{ origin: app.progressLab.local, topLevelSite: null, role: "top" }],
  });
  const paths = file.manifest.entries.map((entry) => entry.path);
  expect(paths[0]).toMatch(/^blobs\/[0-9a-f]{64}$/);
  expect(paths.slice(1)).toEqual([
    "data/0/idb/0/schema.cbor",
    "data/0/idb/0/store-0.cbor",
    "data/0/idb/1/schema.cbor",
    "data/0/idb/1/store-0.cbor",
    "data/0/idb/1/store-1.cbor",
    "data/0/local-storage.cbor",
  ]);
  // Date, ArrayBuffer, Uint8Array and Blob values were read with their exact prototypes in the preload's world
  // (the exporter refuses any other prototype with EXP_UNSUPPORTED_VALUE); the thumbnail Blob is one blob entry.
  expect(file.storageKeys).toEqual([
    {
      localStorageItems: 2,
      databases: [{ stores: [{ records: 3 }] }, { stores: [{ records: 1 }, { records: 7 }] }],
    },
  ]);
  expect(file.blobs.count).toBe(1);

  expect(row).toMatchObject({
    gameId,
    kind: "export",
    flushState: "unconfirmed",
    contentHash: file.manifest.contentHash,
  });
  expect(await snapshotRows(app, gameId)).toHaveLength(1);
  expect(await leftovers(app, gameId)).toEqual({
    tmp: [],
    snapshots: [`${row.revisionId}.wgsnap`],
  });

  // A second export descends from the first (save-transfer.md, "Revision parents").
  const second = ok(await exportSnapshot(app, gameId));
  expect(second.parentRevisionId).toBe(row.revisionId);
  expect((await validated(app, second)).manifest.parentRevisionId).toBe(row.revisionId);
});

test("the key-generator probe is reverted in Electron 45: two exports agree and the game's next key is 8 (open check 2)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const { gameId } = await played(app, 7);
  const first = ok(await exportSnapshot(app, gameId));
  const second = ok(await exportSnapshot(app, gameId));
  // contentHash covers schema.cbor, which records each store's keyGenerator.
  expect(second.contentHash).toBe(first.contentHash);

  const page = await openGame(app, gameId);
  await progressLab(page).play(1);
  expect(await stepLogKeys(page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
});

test("exports with the game's service worker running: the job stops it first (service-worker variant)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const { gameId } = await played(app, 4);
  const started = await app.app.evaluate(
    (_electron, [id, scope]) =>
      globalThis.__wgTest?.startServiceWorker(id as string, scope as string),
    [gameId, `${app.progressLab.local}/`] as const,
  );
  expect(started).toBe(true);
  await expect
    .poll(() =>
      app.app.evaluate((_electron, id) => globalThis.__wgTest?.runningServiceWorkers(id), gameId),
    )
    .toBe(1);

  const row = ok(await exportSnapshot(app, gameId));
  expect((await validated(app, row)).storageKeys[0]?.localStorageItems).toBe(2);
  expect(await eventsNamed(app, "snapshot.quiescent.violation")).toEqual([]);
});

test("exports a cross-site iframe's partitioned storage under its top-level site (iframe variant)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const { gameId } = await played(app, 5, {
    path: `/iframe-host.html?src=${encodeURIComponent(`${launched.progressLab.loopback}/`)}`,
    frame: true,
  });
  const frameKey = { origin: app.progressLab.loopback, topLevelSite: "http://localhost" };
  // The export dialog's list: the frame with what it holds, not chosen yet (counts only, through the bridge).
  const listFrames = () =>
    app.launcher.evaluate((id) => window.wg?.listFrames({ gameId: id }), gameId);
  const listed = ok((await listFrames()) ?? { ok: false, code: "INTERNAL", message: "no bridge" });
  // progress-lab keeps two databases (its own and the Emscripten-style one) and two localStorage items.
  expect(listed.frames).toEqual([
    {
      ...frameKey,
      inExport: false,
      localStorageItems: 2,
      databases: 2,
      indexedDbBytes: expect.any(Number),
    },
  ]);
  expect(listed.frames[0]?.indexedDbBytes).toBeGreaterThan(0);
  // Without the user's choice the cross-site frame is not part of the game's keys.
  const topOnly = ok(await exportSnapshot(app, gameId));
  expect((await validated(app, topOnly)).manifest.storageKeys).toEqual([
    { origin: app.progressLab.local, topLevelSite: null, role: "top" },
  ]);

  const row = ok(await exportSnapshot(app, gameId, { frameKeys: [frameKey] }));
  const file = await validated(app, row);
  expect(file.manifest.storageKeys).toEqual([
    { ...frameKey, role: "frame" },
    { origin: app.progressLab.local, topLevelSite: null, role: "top" },
  ]);
  // The iframe's progress is under key 0; the host page itself stored nothing.
  expect(file.storageKeys[0]).toMatchObject({ localStorageItems: 2 });
  expect(file.storageKeys[1]).toEqual({ localStorageItems: 0, databases: [] });
  // The choice is remembered: the next export without one includes the frame again.
  const again = ok(await exportSnapshot(app, gameId));
  expect(again.contentHash).toBe(row.contentHash);
  const remembered = ok(
    (await listFrames()) ?? { ok: false, code: "INTERNAL", message: "no bridge" },
  );
  expect(remembered.frames).toEqual([expect.objectContaining({ ...frameKey, inExport: true })]);
  // A frame key that is not one of the game's frames is refused.
  expect(
    await exportSnapshot(app, gameId, {
      frameKeys: [{ origin: "https://elsewhere.example", topLevelSite: "http://localhost" }],
    }),
  ).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
});

test("refuses an export while the game window is open (AC-11), also through the launcher bridge", async () => {
  test.setTimeout(60_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  await openGame(app, gameId);
  expect(await exportSnapshot(app, gameId)).toMatchObject({ ok: false, code: "GAME_RUNNING" });
  expect(
    await app.launcher.evaluate((id) => window.wg?.exportSnapshot({ gameId: id }), gameId),
  ).toMatchObject({ ok: false, code: "GAME_RUNNING" });
  expect(await snapshotRows(app, gameId)).toEqual([]);
  expect(await leftovers(app, gameId)).toEqual({ tmp: [], snapshots: [] });
});

test("a snapshot of a session with cookies, Cache Storage and a worker holds none of them (AC-20, S-17)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  const page = await openGame(app, gameId);
  await progressLab(page).play(3);
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: the test plants a cookie the snapshot must not contain.
    document.cookie = "wg-e2e-token=SECRET-COOKIE-VALUE; max-age=3600; path=/";
  });
  // progress-lab's worker precaches its files in Cache Storage.
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).length))
    .toBeGreaterThan(0);
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");

  const row = ok(await exportSnapshot(app, gameId));
  const file = await validated(app, row);
  const entries = await entriesOf(app, row);
  expect(entries.every((entry) => /^(?:data\/0\/|blobs\/)/.test(entry.path))).toBe(true);
  const text = entries.map((entry) => Buffer.from(entry.bytes).toString("latin1")).join("\n");
  expect(text).not.toContain("SECRET-COOKIE-VALUE");
  expect(text).not.toContain("wg-e2e-token");
  expect(text).not.toContain("sw.js");
  // Cache Storage and the worker registration are named, not exported: `usageDetails` from the preload's isolated
  // world saw them (open check 8).
  expect(file.manifest.notExported).toEqual(
    expect.arrayContaining([
      { key: 0, kind: "cacheStorage" },
      { key: 0, kind: "serviceWorkers" },
    ]),
  );
});

test("save data above a limit fails with its SNAP code, leaves no file and writes no row (Review Focus 4)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const { gameId } = await played(app, 7);
  expect(
    await exportSnapshot(app, gameId, { test: { limits: { maxTotalBytes: 1024 } } }),
  ).toMatchObject({
    ok: false,
    code: "SNAP_TOTAL_TOO_LARGE",
  });
  expect(await leftovers(app, gameId)).toEqual({ tmp: [], snapshots: [] });
  expect(await snapshotRows(app, gameId)).toEqual([]);
  // The ratio bound is the read-back's (the writer does not check it).
  expect(
    await exportSnapshot(app, gameId, { test: { limits: { ratioFloorBytes: 512, maxRatio: 1 } } }),
  ).toMatchObject({ ok: false, code: "SNAP_RATIO_EXCEEDED" });
  expect(await leftovers(app, gameId)).toEqual({ tmp: [], snapshots: [] });
  expect(await snapshotRows(app, gameId)).toEqual([]);
});

test("a failing disk write removes the partial file, adds no row and reports the real error (Review Focus 5)", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const { gameId } = await played(app, 7);
  expect(await exportSnapshot(app, gameId, { test: { fault: "fail-write" } })).toEqual({
    ok: false,
    code: "INTERNAL",
    message: "The snapshot file could not be written (EIO).",
  });
  expect(await leftovers(app, gameId)).toEqual({ tmp: [], snapshots: [] });
  expect(await snapshotRows(app, gameId)).toEqual([]);
  // The game's lineage did not move: the next export has no parent.
  expect(ok(await exportSnapshot(app, gameId)).parentRevisionId).toBeNull();
});

test("snapshot:export over IPC answers with a task id and reports real steps and bytes; list and save as", async () => {
  test.setTimeout(90_000);
  launched = await launchApp();
  const app = launched;
  const { gameId } = await played(app, 7);
  await app.launcher.evaluate(() => {
    const events: TaskProgressEvent[] = [];
    (window as unknown as { progress: TaskProgressEvent[] }).progress = events;
    window.wg?.onTaskProgress((event) => events.push(event));
  });
  const started = await app.launcher.evaluate(
    (id) => window.wg?.exportSnapshot({ gameId: id }),
    gameId,
  );
  const { taskId } = ok(started as { ok: true; data: { taskId: string } });
  const events = () =>
    app.launcher.evaluate(() => (window as unknown as { progress: TaskProgressEvent[] }).progress);
  await expect.poll(async () => (await events()).at(-1)?.status, { timeout: 30_000 }).toBe("done");
  const seen = await events();
  expect(seen.every((event) => event.taskId === taskId && event.gameId === gameId)).toBe(true);
  expect(seen.map((event) => [event.step, event.status])).toEqual(
    expect.arrayContaining([
      ["lock", "running"],
      ["read", "running"],
      ["write", "running"],
      ["write", "done"],
    ]),
  );
  // Bytes are the worker's measurement, never a total it does not know.
  const bytes = seen.flatMap((event) => (event.bytesDone === undefined ? [] : [event.bytesDone]));
  expect(bytes.at(-1)).toBeGreaterThan(0);
  expect(seen.some((event) => event.bytesTotal !== undefined)).toBe(false);

  const listed = await app.launcher.evaluate(
    (id) => window.wg?.listSnapshots({ gameId: id }),
    gameId,
  );
  const { snapshots } = ok(
    listed as { ok: true; data: { snapshots: Array<{ revisionId: string; flushState: string }> } },
  );
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.flushState).toBe("unconfirmed");
  expect(JSON.stringify(snapshots)).not.toContain(app.userData);

  const dir = await mkdtemp(join(tmpdir(), "wg-e2e-save-"));
  dirs.push(dir);
  const destination = join(dir, "copy.wgsnap");
  await app.app.evaluate(
    (_electron, value) => globalThis.__wgTest?.queueDialogAnswer({ kind: "saveFile", value }),
    destination,
  );
  const revisionId = snapshots[0]?.revisionId as string;
  expect(
    await app.launcher.evaluate(
      ([id, revision]) =>
        window.wg?.saveSnapshotAs({ gameId: id as string, revisionId: revision as string }),
      [gameId, revisionId] as const,
    ),
  ).toEqual({ ok: true, data: { saved: true } });
  const [row] = await snapshotRows(app, gameId);
  expect(await readFile(destination)).toEqual(await readFile(join(app.userData, row?.path ?? "")));
});
