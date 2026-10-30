// Storage keys of a restore (save-transfer.md section 2, "Changed keys"; AC-24, S-16) on progress-lab: exported on
// `localhost` with its `127.0.0.1` iframe, restored where the keys differ (refused naming both keys, nothing
// written), with a confirmed mapping (every record lands under the mapped key, so the game reads its progress
// there), into a target that has no frame observations yet (asked first; nothing written without consent), and
// into a target whose iframe moved to another port (refused, or mapped to it).

import { expect, type Page, test } from "@playwright/test";
import { addGame, closeGame, expectState, openGame, progressLab, queueConfirm } from "./games.js";
import { type Launched, launchApp, type ProgressLab, startProgressLab } from "./harness.js";
import {
  exportSnapshot,
  journalOf,
  ok,
  restoreSnapshot,
  snapshotRows,
  storageDigest,
} from "./snapshots.js";

let launched: Launched | undefined;
let second: ProgressLab | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await second?.stop();
  second = undefined;
});

const host = (top: string, frame: string) =>
  `${top}/iframe-host.html?src=${encodeURIComponent(`${frame}/`)}`;

/** Opens the game, plays `steps` in its iframe, reads the iframe's hash and closes the window. */
async function playInFrame(app: Launched, gameId: string, steps: number): Promise<string> {
  const page: Page = await openGame(app, gameId);
  const lab = progressLab(page.frameLocator("#game-frame"));
  if (steps > 0) await lab.play(steps);
  const hash = await lab.ready();
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
  return hash;
}

const dialogTitles = async (app: Launched) => (await app.hooks()).dialogsShown.map((d) => d.title);

test("changed keys are refused naming both; a confirmed mapping lands every record under the mapped key (AC-24)", async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  const app = launched;
  const { local, loopback } = app.progressLab;
  const a = await addGame(app, host(local, loopback), "A");
  const h5 = await playInFrame(app, a, 5);
  const snapshot = ok(
    await exportSnapshot(app, a, {
      frameKeys: [{ origin: loopback, topLevelSite: "http://localhost" }],
    }),
  );

  // The target runs the other way round: 127.0.0.1 on top, the game in a localhost iframe. Never played.
  const b = await addGame(app, host(loopback, local), "B");
  const before = ok(await storageDigest(app, b));
  const refused = await restoreSnapshot(app, b, { source: { revisionId: snapshot.revisionId } });
  expect(refused).toMatchObject({ ok: false, code: "IMP_STORAGE_KEY_MISMATCH" });
  const message = refused.ok ? "" : refused.message;
  expect(message).toContain(local);
  expect(message).toContain(loopback);
  // Refused before anything was written: no confirmation, no backup, the storage as it was.
  expect(await dialogTitles(app)).toEqual([]);
  expect(await snapshotRows(app, b)).toEqual([]);
  expect(ok(await storageDigest(app, b))).toBe(before);

  const mapping = [
    { from: local, to: loopback },
    { from: loopback, to: local },
  ];
  // B has no frame observations yet: the mapped iframe key cannot be checked, so the user is asked first.
  await queueConfirm(app, false);
  expect(
    await restoreSnapshot(app, b, { source: { revisionId: snapshot.revisionId }, mapping }),
  ).toMatchObject({ ok: false, code: "CANCELLED" });
  expect(await dialogTitles(app)).toEqual(["Restore snapshot?"]);
  expect(await snapshotRows(app, b)).toEqual([]);
  expect(ok(await storageDigest(app, b))).toBe(before);

  await queueConfirm(app, true);
  ok(await restoreSnapshot(app, b, { source: { revisionId: snapshot.revisionId }, mapping }));
  // The game, now in a localhost iframe under 127.0.0.1, reads the progress the 127.0.0.1 iframe made under localhost.
  expect(await playInFrame(app, b, 0)).toBe(h5);
  expect((await journalOf(app, b)).at(-1)).toMatchObject({ state: "done" });
});

test("an iframe that moved to another port is refused, and restored once mapped to where it is now", async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  const app = launched;
  const { local, loopback } = app.progressLab;
  // A second fixture server: the same game's iframe at another port of 127.0.0.1.
  second = await startProgressLab();
  const moved = second.loopback;
  const a = await addGame(app, host(local, loopback), "A");
  const h4 = await playInFrame(app, a, 4);
  const snapshot = ok(
    await exportSnapshot(app, a, {
      frameKeys: [{ origin: loopback, topLevelSite: "http://localhost" }],
    }),
  );

  const c = await addGame(app, host(local, moved), "C");
  // Played once, so the target has observed its iframe at the new host.
  const fresh = await playInFrame(app, c, 0);
  expect(fresh).not.toBe(h4);
  const before = ok(await storageDigest(app, c));
  const refused = await restoreSnapshot(app, c, { source: { revisionId: snapshot.revisionId } });
  expect(refused).toMatchObject({ ok: false, code: "IMP_STORAGE_KEY_MISMATCH" });
  expect(refused.ok ? "" : refused.message).toContain(moved);
  expect(refused.ok ? "" : refused.message).toContain(loopback);
  expect(ok(await storageDigest(app, c))).toBe(before);

  await queueConfirm(app, true);
  ok(
    await restoreSnapshot(app, c, {
      source: { revisionId: snapshot.revisionId },
      mapping: [{ from: loopback, to: moved }],
    }),
  );
  expect(await playInFrame(app, c, 0)).toBe(h4);
});
