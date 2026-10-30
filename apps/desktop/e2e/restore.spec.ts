// Restore through the quiescent window (save-transfer.md section 6) on progress-lab, in the real Electron 45 test
// build: a stored revision restored into a second entry of the same URL (plan M8), fault injection at each step
// (AC-8: the progress hash and the stored data equal the pre-import state, the backup validates), a failed rollback
// (needs_recovery, a launch refused naming the backup, "Retry recovery"), a crash after the wipe (Review Focus 2: the
// next start rolls back before any launch), IMP_REVISION_CONFLICT and an external file adopted as `imported`, and
// verify ("Export verified").

import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "@playwright/test";
import { uuidv7 } from "@wg-launcher/shared";
import {
  readEntries,
  type SnapshotFile,
  validateSnapshot,
  writeSnapshot,
} from "@wg-launcher/snapshot/container";
import {
  addGame,
  closeGame,
  expectState,
  launchGame,
  openGame,
  progressLab,
  queueConfirm,
} from "./games.js";
import { type Launched, launchApp, type ProgressLab, startProgressLab } from "./harness.js";
import {
  exportSnapshot,
  gameRow,
  journalOf,
  ok,
  recoveryDone,
  restoreSnapshot,
  retryRecovery,
  setFaults,
  setJobTiming,
  snapshotRows,
  storageDigest,
  validated,
  verifySnapshot,
} from "./snapshots.js";

let launched: Launched | undefined;
let server: ProgressLab | undefined;
const dirs: string[] = [];
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await server?.stop();
  server = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Opens the game, plays `steps` steps, reads the hash and closes it as the user does. */
async function play(app: Launched, gameId: string, steps: number): Promise<string> {
  const page = await openGame(app, gameId);
  const lab = progressLab(page);
  if (steps > 0) await lab.play(steps);
  const hash = await lab.ready();
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
  return hash;
}

const hashOf = (app: Launched, gameId: string) => play(app, gameId, 0);

test("restores a stored revision into a second entry of the same URL: hash equal, no new row for it, base moved (M8)", async () => {
  test.setTimeout(120_000);
  launched = await launchApp();
  const app = launched;
  const a = await addGame(app, `${app.progressLab.local}/`, "A");
  const h7 = await play(app, a, 7);
  const snapshot = ok(await exportSnapshot(app, a));
  const b = await addGame(app, `${app.progressLab.local}/`, "B");
  const fresh = await hashOf(app, b);
  expect(fresh).not.toBe(h7);

  await queueConfirm(app, true);
  const outcome = ok(
    await restoreSnapshot(app, b, { source: { revisionId: snapshot.revisionId } }),
  );
  expect(outcome.revisionId).toBe(snapshot.revisionId);
  expect(await hashOf(app, b)).toBe(h7);

  // The restored revision's row stays A's; B got its pre-import backup only, and B now descends from the revision.
  const rowsOfB = await snapshotRows(app, b);
  expect(rowsOfB.map((row) => row.kind)).toEqual(["backup"]);
  expect(rowsOfB[0]?.revisionId).toBe(outcome.backupRevisionId);
  expect((await snapshotRows(app, a)).map((row) => row.revisionId)).toEqual([snapshot.revisionId]);
  expect(await gameRow(app, b)).toEqual({
    needsRecovery: false,
    baseRevisionId: snapshot.revisionId,
  });
  const backup = await validated(app, rowsOfB[0] as never);
  expect(backup.manifest.storageKeys).toEqual([
    { origin: app.progressLab.local, topLevelSite: null, role: "top" },
  ]);
  expect((await journalOf(app, b)).map((entry) => [entry.kind, entry.step, entry.state])).toEqual([
    ["import", "commit", "done"],
  ]);

  // AC-11: refused while the window is open, before any question, also through the launcher bridge.
  await openGame(app, b);
  expect(
    await restoreSnapshot(app, b, { source: { revisionId: snapshot.revisionId } }),
  ).toMatchObject({ ok: false, code: "GAME_RUNNING" });
  expect(
    await app.launcher.evaluate(
      ([id, revisionId]) =>
        window.wg?.importSnapshot({
          gameId: id as string,
          source: { revisionId: revisionId as string },
        }),
      [b, snapshot.revisionId],
    ),
  ).toMatchObject({ ok: false, code: "GAME_RUNNING" });
  expect((await app.hooks()).dialogsShown.map((d) => d.title)).toEqual(["Restore snapshot?"]);
  await closeGame(app, b);
});

test("a fault at each step leaves the progress hash and the stored data as before, and the backup validates (AC-8)", async () => {
  test.setTimeout(300_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  await play(app, gameId, 7);
  const snapshot = ok(await exportSnapshot(app, gameId));
  const h10 = await play(app, gameId, 3);
  const before = ok(await storageDigest(app, gameId));

  for (const step of ["validate", "plan", "lock", "backup", "wipe", "import", "verify"]) {
    await setFaults(app, [`fail:${step}`]);
    // The confirmation is asked at the end of R2, after the plan step started.
    if (step !== "validate" && step !== "plan") await queueConfirm(app, true);
    const result = await restoreSnapshot(app, gameId, {
      source: { revisionId: snapshot.revisionId },
    });
    expect(result, step).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(ok(await storageDigest(app, gameId)), step).toBe(before);
    const entry = (await journalOf(app, gameId)).at(-1);
    expect(entry, step).toMatchObject({ kind: "import", state: "failed" });
    const backups = (await snapshotRows(app, gameId)).filter((row) => row.kind === "backup");
    if (["wipe", "import", "verify"].includes(step)) {
      expect(entry?.step, step).toBe("rollback-verify");
      const backup = backups.find((row) => row.revisionId === entry?.backupRevisionId);
      expect(backup, step).toBeDefined();
      const file = await validated(app, backup as never);
      expect(file.manifest.contentHash, step).toBe(before);
    } else {
      expect(entry?.step, step).toBe(step);
      expect(
        backups.filter((row) => row.revisionId === entry?.backupRevisionId),
        step,
      ).toEqual([]);
    }
  }
  await setFaults(app, []);
  expect(await gameRow(app, gameId)).toMatchObject({ needsRecovery: false });
  expect(await hashOf(app, gameId)).toBe(h10);
});

test("a failed rollback marks the game needs_recovery, a launch names the backup, and Retry recovery puts the saves back", async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  await play(app, gameId, 7);
  const snapshot = ok(await exportSnapshot(app, gameId));
  const h9 = await play(app, gameId, 2);
  const before = ok(await storageDigest(app, gameId));

  await setFaults(app, ["fail:import", "fail:rollback-import"]);
  await queueConfirm(app, true);
  const result = await restoreSnapshot(app, gameId, {
    source: { revisionId: snapshot.revisionId },
  });
  expect(result).toMatchObject({ ok: false, code: "IMP_RECOVERY_FAILED" });
  const entry = (await journalOf(app, gameId)).at(-1);
  expect(entry).toMatchObject({ state: "rolling-back", step: "rollback-import" });
  const backupId = entry?.backupRevisionId as string;
  expect(!result.ok && result.message).toContain(backupId);
  expect(await gameRow(app, gameId)).toMatchObject({ needsRecovery: true });

  const refused = await launchGame(app, gameId);
  expect(refused).toMatchObject({ ok: false, code: "NEEDS_RECOVERY" });
  expect(!refused.ok && refused.message).toContain(backupId);
  // Every other task is refused too.
  expect(await exportSnapshot(app, gameId)).toMatchObject({ ok: false, code: "NEEDS_RECOVERY" });

  await setFaults(app, []);
  ok(await retryRecovery(app, gameId));
  expect(await gameRow(app, gameId)).toMatchObject({ needsRecovery: false });
  expect((await journalOf(app, gameId)).at(-1)).toMatchObject({
    state: "failed",
    step: "rollback-verify",
  });
  expect(ok(await storageDigest(app, gameId))).toBe(before);
  expect(await hashOf(app, gameId)).toBe(h9);
  // The backup is never deleted.
  expect((await snapshotRows(app, gameId)).some((row) => row.revisionId === backupId)).toBe(true);
});

test("a slow import and an equally slow rollback both finish: each window's deadline grows with its data", async () => {
  test.setTimeout(240_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  await play(app, gameId, 7);
  const snapshot = ok(await exportSnapshot(app, gameId));
  const h9 = await play(app, gameId, 2);
  const before = ok(await storageDigest(app, gameId));
  // A short base deadline and a long allowance per MiB: only a window sized from its data outlasts a 6 s import.
  await setJobTiming(app, { deadlineMs: 4000, deadlinePerMiBMs: 1_000_000_000 });

  // The import is slow but finishes; the verify fails; the rollback's import is just as slow and finishes too.
  await setFaults(app, ["slow:import:6000", "slow:rollback-import:6000", "fail:verify"]);
  await queueConfirm(app, true);
  const result = await restoreSnapshot(app, gameId, {
    source: { revisionId: snapshot.revisionId },
  });
  expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  expect((await journalOf(app, gameId)).at(-1)).toMatchObject({
    state: "failed",
    step: "rollback-verify",
  });
  expect(ok(await storageDigest(app, gameId))).toBe(before);

  // "Retry recovery" of a failed rollback is sized the same way.
  await setFaults(app, ["fail:import", "fail:rollback-import"]);
  await queueConfirm(app, true);
  expect(
    await restoreSnapshot(app, gameId, { source: { revisionId: snapshot.revisionId } }),
  ).toMatchObject({ ok: false, code: "IMP_RECOVERY_FAILED" });
  await setFaults(app, ["slow:rollback-import:6000"]);
  ok(await retryRecovery(app, gameId));
  expect(await gameRow(app, gameId)).toMatchObject({ needsRecovery: false });
  expect(ok(await storageDigest(app, gameId))).toBe(before);
  await setJobTiming(app, null);
  await setFaults(app, []);
  expect(await hashOf(app, gameId)).toBe(h9);
});

test("an unexpected error after the wipe still rolls back, and one inside the rollback marks the game for recovery", async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  await play(app, gameId, 7);
  const snapshot = ok(await exportSnapshot(app, gameId));
  const h8 = await play(app, gameId, 1);
  const before = ok(await storageDigest(app, gameId));

  // A plain Error (no test fault value) thrown when the commit starts.
  await setFaults(app, ["throw:commit"]);
  await queueConfirm(app, true);
  expect(
    await restoreSnapshot(app, gameId, { source: { revisionId: snapshot.revisionId } }),
  ).toMatchObject({ ok: false, code: "INTERNAL" });
  expect((await journalOf(app, gameId)).at(-1)).toMatchObject({
    state: "failed",
    step: "rollback-verify",
  });
  expect(await gameRow(app, gameId)).toMatchObject({ needsRecovery: false });
  expect(ok(await storageDigest(app, gameId))).toBe(before);

  // A plain Error inside the rollback is a failed rollback, never an escape that frees the game.
  await setFaults(app, ["fail:import", "throw:rollback-import"]);
  await queueConfirm(app, true);
  expect(
    await restoreSnapshot(app, gameId, { source: { revisionId: snapshot.revisionId } }),
  ).toMatchObject({ ok: false, code: "IMP_RECOVERY_FAILED" });
  expect(await gameRow(app, gameId)).toMatchObject({ needsRecovery: true });
  expect(await launchGame(app, gameId)).toMatchObject({ ok: false, code: "NEEDS_RECOVERY" });
  await setFaults(app, []);
  ok(await retryRecovery(app, gameId));
  expect(ok(await storageDigest(app, gameId))).toBe(before);
  expect(await hashOf(app, gameId)).toBe(h8);
});

test("a crash right after the wipe is rolled back at the next start, before any launch (Review Focus 2)", async () => {
  test.setTimeout(180_000);
  const userData = await mkdtemp(join(tmpdir(), "wg-e2e-crash-"));
  dirs.push(userData);
  server = await startProgressLab();
  launched = await launchApp({ userData, progressLab: server });
  let app = launched;
  const gameId = await addGame(app, `${server.local}/`, "progress-lab");
  await play(app, gameId, 7);
  const snapshot = ok(await exportSnapshot(app, gameId));
  const h11 = await play(app, gameId, 4);
  const before = ok(await storageDigest(app, gameId));

  await setFaults(app, ["crash-after:wipe"]);
  await queueConfirm(app, true);
  // The app dies inside this call (SIGKILL after R5).
  await expect(
    restoreSnapshot(app, gameId, { source: { revisionId: snapshot.revisionId } }),
  ).rejects.toThrow();
  await launched.close();

  launched = await launchApp({ userData, progressLab: server });
  app = launched;
  await expect.poll(() => recoveryDone(app), { timeout: 60_000 }).toBe(true);
  const entry = (await journalOf(app, gameId)).at(-1);
  expect(entry).toMatchObject({ kind: "import", state: "failed", step: "rollback-verify" });
  expect(await gameRow(app, gameId)).toMatchObject({ needsRecovery: false });
  expect(ok(await storageDigest(app, gameId))).toBe(before);
  expect(await hashOf(app, gameId)).toBe(h11);
  const backup = (await snapshotRows(app, gameId)).find(
    (row) => row.revisionId === entry?.backupRevisionId,
  );
  expect((await validated(app, backup as never)).manifest.contentHash).toBe(before);
});

/** Writes a `.wgsnap` with these fields and files to `path`. */
async function writeFileSnapshot(
  path: string,
  fields: Parameters<typeof writeSnapshot>[0],
): Promise<string> {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const { contentHash } = await writeSnapshot(fields, out);
  await writeFile(path, Buffer.concat(chunks));
  return contentHash;
}

test("a file whose revision is stored with other content is IMP_REVISION_CONFLICT; a new one is adopted as imported", async () => {
  test.setTimeout(150_000);
  launched = await launchApp();
  const app = launched;
  const dir = await mkdtemp(join(tmpdir(), "wg-e2e-files-"));
  dirs.push(dir);
  const a = await addGame(app, `${app.progressLab.local}/`, "A");
  const h6 = await play(app, a, 6);
  const snapshot = ok(await exportSnapshot(app, a));
  const stored = join(app.userData, snapshot.path);
  const { manifest } = await validateSnapshot(createReadStream(stored), {
    compressedSize: (await stat(stored)).size,
  });
  const files: SnapshotFile[] = [];
  for await (const entry of readEntries(createReadStream(stored), manifest, {
    compressedSize: (await stat(stored)).size,
  })) {
    files.push(entry);
  }
  const { entries: _entries, contentHash: _hash, ...fields } = manifest;
  const b = await addGame(app, `${app.progressLab.local}/`, "B");
  const before = ok(await storageDigest(app, b));

  // The same revision id with no data: another content under a stored revision.
  const conflict = join(dir, "conflict.wgsnap");
  await writeFileSnapshot(conflict, { ...fields, files: [] });
  expect(await restoreSnapshot(app, b, { source: { file: conflict } })).toMatchObject({
    ok: false,
    code: "IMP_REVISION_CONFLICT",
  });
  expect(ok(await storageDigest(app, b))).toBe(before);
  expect(await snapshotRows(app, b)).toEqual([]);

  // A file of a stored revision with the same content: restored, not adopted again, and its private copy removed.
  await queueConfirm(app, true);
  ok(await restoreSnapshot(app, b, { source: { file: stored } }));
  expect((await snapshotRows(app, b)).map((row) => row.kind)).toEqual(["backup"]);
  expect(await readdir(join(app.userData, "tmp"))).toEqual([]);

  // The same data under a new revision: restored, then stored as B's `imported` row next to its backup.
  const revisionId = uuidv7();
  const fresh = join(dir, "fresh.wgsnap");
  const hash = await writeFileSnapshot(fresh, { ...fields, revisionId, files });
  expect(hash).toBe(snapshot.contentHash);
  await queueConfirm(app, true);
  ok(await restoreSnapshot(app, b, { source: { file: fresh } }));
  expect(await hashOf(app, b)).toBe(h6);
  const imported = (await snapshotRows(app, b)).find((row) => row.kind === "imported");
  expect(imported).toMatchObject({
    revisionId,
    manifestGameId: a,
    path: `snapshots/${b}/${revisionId}.wgsnap`,
  });
  expect((await validated(app, imported as never)).manifest.contentHash).toBe(hash);
  expect(await gameRow(app, b)).toMatchObject({ baseRevisionId: revisionId });
});

test("verify restores into a fresh in-memory partition, sets Export verified and leaves the game's data alone", async () => {
  test.setTimeout(120_000);
  launched = await launchApp();
  const app = launched;
  const gameId = await addGame(app, `${app.progressLab.local}/`, "progress-lab");
  await play(app, gameId, 5);
  const snapshot = ok(await exportSnapshot(app, gameId));
  const h8 = await play(app, gameId, 3);
  const before = ok(await storageDigest(app, gameId));
  const badges = async () => {
    const listed = (await app.launcher.evaluate(() => window.wg?.listLibrary({}))) as {
      ok: true;
      data: { library: "ready"; cards: Array<{ gameId: string; badges: Array<{ id: string }> }> };
    };
    return listed.data.cards.find((card) => card.gameId === gameId)?.badges.map((b) => b.id) ?? [];
  };
  expect(await badges()).not.toContain("export-verified");

  const verified = ok(await verifySnapshot(app, gameId, snapshot.revisionId));
  expect(verified).toMatchObject({ verifiedExporterVersion: "1.0.0" });
  expect(verified.verifiedAt).not.toBeNull();
  expect(await badges()).toContain("export-verified");
  expect(ok(await storageDigest(app, gameId))).toBe(before);
  expect(await hashOf(app, gameId)).toBe(h8);

  // A file that is not the one recorded (another valid snapshot in its place) fails and sets nothing.
  const second = ok(await exportSnapshot(app, gameId));
  await copyFile(join(app.userData, snapshot.path), join(app.userData, second.path));
  expect(await verifySnapshot(app, gameId, second.revisionId)).toMatchObject({
    ok: false,
    code: "IMP_VERIFY_MISMATCH",
  });
  const rows = await snapshotRows(app, gameId);
  expect(rows.find((row) => row.revisionId === second.revisionId)?.verifiedAt).toBeNull();
});
