// The vertical scenario (PRD section 5, AC-6) and the restore into a clean session for the service-worker and
// cross-site iframe variants (AC-7), driven through the launcher UI only: add by address, Play, export from the
// card's export panel, add the same address again (entry B, a new gameId and an empty partition, plan M8), restore
// entry A's snapshot from B's snapshot panel, and the same progress hash in B, also after a restart (AC-1). Native
// dialogs are answered through the test flavor's queue. Also: an export that fails in a frame shows its code in the
// card (AC-10), and no launcher text shows install, sync, FPS, download, completion or achievement wording (AC-14).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { closeGame, expectState, openGame, progressLab, queueConfirm } from "./games.js";
import { type Launched, launchApp, type ProgressLab, startProgressLab } from "./harness.js";
import { startTestPages, type TestPages } from "./test-pages.js";

let launched: Launched | undefined;
let server: ProgressLab | undefined;
let pages: TestPages | undefined;
const dirs: string[] = [];
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await server?.stop();
  server = undefined;
  await pages?.stop();
  pages = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Words no launcher text may show (AC-14; save-transfer.md section 7 for the snapshot wording). */
const FORBIDDEN = /install|\bsync|\bfps\b|download|complet|achievement|save point|guarantee/i;

const cardTitled = (launcher: Page, title: string) =>
  launcher.locator("li.card").filter({ has: launcher.locator(".title", { hasText: title }) });

/** Adds an entry through the add form and returns its gameId (read from the new card). */
async function addByUi(app: Launched, url: string, title: string): Promise<string> {
  const { launcher } = app;
  await launcher.getByLabel("Game address").fill(url);
  await launcher.getByLabel("Title (optional)").fill(title);
  await launcher.getByRole("button", { name: "Add", exact: true }).click();
  const card = cardTitled(launcher, title);
  await expect(card).toHaveCount(1);
  return (await card.getAttribute("data-game-id")) ?? "";
}

const cardOf = (app: Launched, gameId: string) =>
  app.launcher.locator(`li.card[data-game-id="${gameId}"]`);

/** Clicks Play on the card and resolves with the game window's page. */
const playFromCard = (app: Launched, gameId: string) =>
  openGame(app, gameId, () =>
    cardOf(app, gameId).getByRole("button", { name: "Play", exact: true }).click(),
  );

/** Closes the game window as the user does and waits until it is gone. */
async function close(app: Launched, gameId: string) {
  await closeGame(app, gameId);
  await expectState(app, gameId, "exited");
}

/** Waits for the card's latest task to end and returns its text. */
async function taskOutcome(app: Launched, gameId: string): Promise<string> {
  const task = cardOf(app, gameId).locator(".task");
  await expect(task).toHaveAttribute("data-task-status", /^(done|failed)$/, { timeout: 60_000 });
  return (await task.textContent()) ?? "";
}

/** Opens the card's export panel, ticks the listed frames if asked, starts the export and waits for it. */
async function exportFromCard(app: Launched, gameId: string, tickFrames = false) {
  const card = cardOf(app, gameId);
  await card.getByRole("button", { name: "Export snapshot" }).click();
  const panel = card.getByRole("region", { name: "Export snapshot" });
  const start = panel.getByRole("button", { name: "Start export" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  if (tickFrames) {
    const boxes = panel.getByRole("checkbox");
    await expect(boxes).toHaveCount(1);
    await expect(boxes).not.toBeChecked();
    await boxes.check();
  }
  await start.click();
}

/** In entry B's snapshot panel, restores the newest snapshot listed under entry A; main's confirmation is accepted. */
async function restoreFromEntry(app: Launched, gameB: string, titleA: string) {
  const card = cardOf(app, gameB);
  await card.getByRole("button", { name: "Snapshots and restore" }).click();
  const fromA = card.getByRole("region", { name: `Snapshots of ${titleA}` });
  const row = fromA.locator("li").first();
  await expect(row).toContainText("flush unconfirmed");
  await queueConfirm(app, true);
  await row.getByRole("button", { name: "Restore into this game" }).click();
}

async function expectNoForbiddenText(app: Launched) {
  expect(await app.launcher.locator("body").textContent()).not.toMatch(FORBIDDEN);
}

test("AC-6: add, play, reopen, export, restore into a second entry, the same progress, also after a restart", async () => {
  test.setTimeout(180_000);
  const userData = await mkdtemp(join(tmpdir(), "wg-e2e-"));
  dirs.push(userData);
  server = await startProgressLab();
  launched = await launchApp({ userData, progressLab: server });
  let app = launched;
  const url = `${server.local}/`;

  const gameA = await addByUi(app, url, "Lab A");
  let page = await playFromCard(app, gameA);
  await progressLab(page).play(7);
  const hash = await progressLab(page).ready();
  await close(app, gameA);
  page = await playFromCard(app, gameA);
  expect(await progressLab(page).ready()).toBe(hash);
  await close(app, gameA);

  await exportFromCard(app, gameA);
  expect(await taskOutcome(app, gameA)).toBe("Export: done");
  await cardOf(app, gameA).getByRole("button", { name: "Snapshots and restore" }).click();
  await expect(
    cardOf(app, gameA).getByRole("list", { name: "Snapshots of this game" }).locator("li"),
  ).toContainText(["flush unconfirmed"]);

  // The same address again: main warns first, then a second entry with its own empty session.
  await queueConfirm(app, true);
  const gameB = await addByUi(app, url, "Lab B");
  expect(gameB).not.toBe(gameA);
  await restoreFromEntry(app, gameB, "Lab A");
  expect(await taskOutcome(app, gameB)).toBe("Import: done");
  page = await playFromCard(app, gameB);
  expect(await progressLab(page).ready()).toBe(hash);
  await close(app, gameB);
  await expectNoForbiddenText(app);

  await app.close();
  launched = await launchApp({ userData, progressLab: server });
  app = launched;
  page = await playFromCard(app, gameB);
  expect(await progressLab(page).ready()).toBe(hash);
  await close(app, gameB);
});

test("AC-7: the service-worker variant restores into a clean entry through the UI", async () => {
  test.setTimeout(150_000);
  launched = await launchApp();
  const app = launched;
  const url = `${app.progressLab.local}/`;
  const gameA = await addByUi(app, url, "Lab A");
  const page = await playFromCard(app, gameA);
  await progressLab(page).play(4);
  const hash = await progressLab(page).ready();
  await close(app, gameA);
  // The game's worker runs when the export starts; the job stops it first.
  expect(
    await app.app.evaluate(
      (_electron, [id, scope]) =>
        globalThis.__wgTest?.startServiceWorker(id as string, scope as string),
      [gameA, url] as const,
    ),
  ).toBe(true);

  await exportFromCard(app, gameA);
  expect(await taskOutcome(app, gameA)).toBe("Export: done");
  await queueConfirm(app, true);
  const gameB = await addByUi(app, url, "Lab B");
  await restoreFromEntry(app, gameB, "Lab A");
  expect(await taskOutcome(app, gameB)).toBe("Import: done");
  const restored = await playFromCard(app, gameB);
  expect(await progressLab(restored).ready()).toBe(hash);
  await close(app, gameB);
});

test("AC-7: the cross-site iframe variant, with the frame ticked in the export panel", async () => {
  test.setTimeout(150_000);
  launched = await launchApp();
  const app = launched;
  const url = `${app.progressLab.local}/iframe-host.html?src=${encodeURIComponent(`${app.progressLab.loopback}/`)}`;
  const gameA = await addByUi(app, url, "Lab A");
  const page = await playFromCard(app, gameA);
  const lab = progressLab(page.frameLocator("#game-frame"));
  await lab.play(5);
  const hash = await lab.ready();
  await close(app, gameA);

  await exportFromCard(app, gameA, true);
  expect(await taskOutcome(app, gameA)).toBe("Export: done");
  await queueConfirm(app, true);
  const gameB = await addByUi(app, url, "Lab B");
  // B never ran, so the iframe key cannot be checked: main lists it in the same confirmation, accepted here.
  await restoreFromEntry(app, gameB, "Lab A");
  expect(await taskOutcome(app, gameB)).toBe("Import: done");
  const restored = await playFromCard(app, gameB);
  expect(await progressLab(restored.frameLocator("#game-frame")).ready()).toBe(hash);
  await close(app, gameB);
  await expectNoForbiddenText(app);
});

test("AC-10: an export that fails in a frame shows its code and message in the card", async () => {
  test.setTimeout(90_000);
  pages = await startTestPages();
  launched = await launchApp();
  const app = launched;
  const gameId = await addByUi(app, `${pages.origin}/unsupported.html`, "Unsupported");
  const page = await playFromCard(app, gameId);
  await expect(page.locator("#stored")).toHaveText("stored");
  await close(app, gameId);

  await exportFromCard(app, gameId);
  const outcome = await taskOutcome(app, gameId);
  expect(outcome).toMatch(/^Export failed: EXP_UNSUPPORTED_VALUE: \S/);
  await expect(cardOf(app, gameId).locator(".task")).toHaveAttribute("role", "alert");
});

test("AC-24 through the UI: a moved iframe is refused naming both keys, and restored after the mapping form", async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  const app = launched;
  const { local, loopback } = app.progressLab;
  // A second fixture server: the same game's iframe at another port of 127.0.0.1.
  server = await startProgressLab();
  const moved = server.loopback;
  const host = (frame: string) =>
    `${local}/iframe-host.html?src=${encodeURIComponent(`${frame}/`)}`;
  const gameA = await addByUi(app, host(loopback), "Lab A");
  const pageA = await playFromCard(app, gameA);
  await progressLab(pageA.frameLocator("#game-frame")).play(4);
  const hash = await progressLab(pageA.frameLocator("#game-frame")).ready();
  await close(app, gameA);
  await exportFromCard(app, gameA, true);
  expect(await taskOutcome(app, gameA)).toBe("Export: done");

  // Entry C has the same origin and has run once, so its iframe at the new port is recorded.
  const gameC = await addByUi(app, host(moved), "Lab C");
  await playFromCard(app, gameC);
  await close(app, gameC);
  const card = cardOf(app, gameC);
  await card.getByRole("button", { name: "Snapshots and restore" }).click();
  const fromA = card.getByRole("region", { name: "Snapshots of Lab A" });
  await fromA.getByRole("button", { name: "Restore into this game" }).first().click();
  // Refused before anything was written: the card names both origins and offers the mapping form.
  const refusal = card.getByRole("alert").filter({ hasText: "IMP_STORAGE_KEY_MISMATCH" });
  await expect(refusal).toContainText(loopback);
  await expect(refusal).toContainText(moved);
  const form = card.getByRole("form", { name: "Map storage origins" });
  await form.getByLabel("Snapshot origin").fill(loopback);
  await form.getByLabel("Origin of this game").fill(moved);
  await queueConfirm(app, true);
  await form.getByRole("button", { name: "Restore with this mapping" }).click();
  expect(await taskOutcome(app, gameC)).toBe("Import: done");
  await expect(form).toHaveCount(0);
  const pageC = await playFromCard(app, gameC);
  expect(await progressLab(pageC.frameLocator("#game-frame")).ready()).toBe(hash);
  await close(app, gameC);
});
