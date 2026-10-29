// The delete actions of PRD section 9 (AC-16) on progress-lab: "Delete local saves" makes and verifies a backup
// first, then wipes (and is refused while the window is open, AC-11); "Clear cache" leaves the saves and reaches the
// partitioned keys of a cross-site iframe (open check 4: `clearStorageData` without `origin`); a removed game's data
// is deleted the same way through `library:deleteOrphanData`.

import { expect, type Page, test } from "@playwright/test";
import type { TaskProgressEvent } from "@wg-launcher/shared";
import { addGame, closeGame, expectState, openGame, progressLab, queueConfirm } from "./games.js";
import { type Launched, launchApp } from "./harness.js";
import {
  clearCache,
  deleteLocalSaves,
  gameRow,
  journalOf,
  ok,
  snapshotRows,
  storageDigest,
  storageInventory,
  validated,
} from "./snapshots.js";

let launched: Launched | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

async function play(app: Launched, gameId: string, steps: number, frame = false) {
  const page: Page = await openGame(app, gameId);
  const lab = progressLab(frame ? page.frameLocator("#game-frame") : page);
  if (steps > 0) await lab.play(steps);
  const hash = await lab.ready();
  return { page, hash };
}

async function close(app: Launched, gameId: string) {
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
}

test("delete local saves backs up and verifies first, then wipes; refused while open, nothing on Cancel (AC-16)", async () => {
  test.setTimeout(150_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  const { hash: empty } = await play(app, gameId, 0);
  // AC-11: refused while the window is open, before any question.
  expect(await deleteLocalSaves(app, gameId)).toMatchObject({ ok: false, code: "GAME_RUNNING" });
  expect(await clearCache(app, gameId)).toMatchObject({ ok: false, code: "GAME_RUNNING" });
  await close(app, gameId);
  const { hash: h5 } = await play(app, gameId, 5);
  await close(app, gameId);
  const before = ok(await storageDigest(app, gameId));

  await queueConfirm(app, false);
  expect(await deleteLocalSaves(app, gameId)).toMatchObject({ ok: false, code: "CANCELLED" });
  expect(ok(await storageDigest(app, gameId))).toBe(before);
  expect(await snapshotRows(app, gameId)).toEqual([]);

  await queueConfirm(app, true);
  const { backupRevisionId } = ok(await deleteLocalSaves(app, gameId)) as {
    backupRevisionId: string;
  };
  // The backup holds exactly what was there, read back through the full validator.
  const backup = (await snapshotRows(app, gameId)).find(
    (row) => row.revisionId === backupRevisionId,
  );
  expect(backup).toMatchObject({ kind: "backup" });
  expect((await validated(app, backup as never)).manifest.contentHash).toBe(before);
  const inventory = ok(await storageInventory(app, gameId));
  expect(inventory[app.progressLab.local]).toMatchObject({ localStorageItems: 0, databases: [] });
  expect(await gameRow(app, gameId)).toMatchObject({ baseRevisionId: null });
  expect((await journalOf(app, gameId)).at(-1)).toMatchObject({
    kind: "delete-saves",
    state: "done",
  });
  const { hash: after } = await play(app, gameId, 0);
  expect(after).toBe(empty);
  expect(after).not.toBe(h5);
  await close(app, gameId);
});

test("clear cache keeps the saves and reaches a cross-site iframe's partitioned cache (AC-16, open check 4)", async () => {
  test.setTimeout(150_000);
  launched = await launchApp();
  const app = launched;
  const { local, loopback } = app.progressLab;
  const gameId = await addGame(
    app,
    `${local}/iframe-host.html?src=${encodeURIComponent(`${loopback}/`)}`,
    "progress-lab",
  );
  const { page, hash } = await play(app, gameId, 3, true);
  // progress-lab's worker precaches its files in Cache Storage, here in the iframe's partitioned key.
  const frame = page.frames().find((f) => f.url().startsWith(loopback)) ?? page.mainFrame();
  await expect
    .poll(() => frame.evaluate(async () => (await caches.keys()).length))
    .toBeGreaterThan(0);
  await close(app, gameId);
  const frameKey = `${loopback} http://localhost`;
  const before = ok(await storageInventory(app, gameId));
  expect(before[frameKey]?.usageDetails?.caches ?? 0).toBeGreaterThan(0);
  expect(before[frameKey]?.usageDetails?.serviceWorkerRegistrations ?? 0).toBeGreaterThan(0);
  const saves = ok(await storageDigest(app, gameId));

  await queueConfirm(app, true);
  ok(await clearCache(app, gameId));
  const after = ok(await storageInventory(app, gameId));
  expect(after[frameKey]?.usageDetails?.caches ?? 0).toBe(0);
  expect(after[frameKey]?.usageDetails?.serviceWorkerRegistrations ?? 0).toBe(0);
  // The saves stay: the iframe's localStorage and databases, byte for byte.
  expect(after[frameKey]).toMatchObject({ localStorageItems: before[frameKey]?.localStorageItems });
  expect(after[frameKey]?.databases).toEqual(before[frameKey]?.databases);
  expect(ok(await storageDigest(app, gameId))).toBe(saves);
  const { hash: again } = await play(app, gameId, 0, true);
  expect(again).toBe(hash);
  await close(app, gameId);
});

test("a removed game's data is deleted through library:deleteOrphanData, with a backup first", async () => {
  test.setTimeout(150_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  await play(app, gameId, 4);
  await close(app, gameId);
  const before = ok(await storageDigest(app, gameId));
  await queueConfirm(app, true);
  expect(
    await app.launcher.evaluate((id) => window.wg?.removeGame({ gameId: id }), gameId),
  ).toEqual({ ok: true, data: {} });
  const orphans = () =>
    app.launcher.evaluate(async () => {
      const listed = await window.wg?.listOrphans({});
      return listed?.ok ? listed.data.orphans.map((o) => o.gameId) : null;
    });
  expect(await orphans()).toEqual([gameId]);

  await app.launcher.evaluate(() => {
    const seen: TaskProgressEvent[] = [];
    (window as unknown as { seen: TaskProgressEvent[] }).seen = seen;
    window.wg?.onTaskProgress((event) => seen.push(event));
  });
  await queueConfirm(app, true);
  const started = await app.launcher.evaluate(
    (id) => window.wg?.deleteOrphanData({ gameId: id }),
    gameId,
  );
  expect(started).toMatchObject({ ok: true });
  const seen = () =>
    app.launcher.evaluate(() =>
      (window as unknown as { seen: TaskProgressEvent[] }).seen.map((e) => `${e.step} ${e.status}`),
    );
  await expect.poll(seen, { timeout: 60_000 }).toContain("commit done");
  expect(await seen()).toEqual([
    "lock running",
    "backup running",
    "wipe running",
    "commit running",
    "commit done",
  ]);
  expect(await orphans()).toEqual([]);
  const backup = (await snapshotRows(app, gameId)).find((row) => row.kind === "backup");
  expect((await validated(app, backup as never)).manifest.contentHash).toBe(before);
  // Neither the entry nor the orphan row is left; the storage keys are found from the URL.
  const inventory = ok(await storageInventory(app, gameId, `${app.progressLab.local}/`));
  expect(inventory[app.progressLab.local]).toMatchObject({ localStorageItems: 0, databases: [] });
});
