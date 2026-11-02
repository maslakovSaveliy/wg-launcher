// The library UI over the real IPC contract (Phase 1 Task 9): AC-17, AC-1 (library part), AC-2's warning for the
// same URL, remove from library, S-15 for titles, the read-only database and a corrupt library.db at start-up.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, test } from "@playwright/test";
import {
  closeGame,
  eventsNamed,
  expectState,
  progressLab,
  queueConfirm,
  queueOpenFile,
} from "./games.js";
import { type Launched, launchApp, runSecondInstance, startProgressLab } from "./harness.js";
import { guardRealProfiles } from "./real-profile-guard.js";

let launched: Launched | undefined;
const dirs: string[] = [];
const servers: Array<{ stop(): Promise<void> }> = [];
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wg-e2e-"));
  dirs.push(dir);
  return dir;
}

/** A 1 x 1 PNG. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Console messages Chromium writes for a CSP or Trusted Types violation. */
const VIOLATION = /Content Security Policy|Trusted ?Type|TrustedHTML|TrustedScript/i;

const cards = (launcher: Page) => launcher.locator("li.card");
const cardOf = (launcher: Page, gameId: string) =>
  launcher.locator(`li.card[data-game-id="${gameId}"]`);

async function addByUi(launcher: Page, url: string, title?: string): Promise<void> {
  await launcher.getByLabel("Game address").fill(url);
  await launcher.getByLabel("Title (optional)").fill(title ?? "");
  await launcher.getByRole("button", { name: "Add", exact: true }).click();
}

/** Clicks Play on the card and resolves with the game window's page once the game runs. */
async function playFromCard(app: Launched, gameId: string): Promise<Page> {
  const [page] = await Promise.all([
    app.app.waitForEvent("window"),
    cardOf(app.launcher, gameId).getByRole("button", { name: "Play" }).click(),
  ]);
  await expectState(app, gameId, "running");
  await page.waitForLoadState("load");
  return page;
}

/** True when the game window's session is `persist:game:<gameId>`. */
async function usesPartitionOf(app: Launched, gameId: string): Promise<boolean> {
  return app.app.evaluate(({ session, webContents }, id) => {
    const wcId = globalThis.__wgTest?.gameWebContentsId(id);
    const contents = wcId == null ? undefined : webContents.fromId(wcId);
    return contents?.session === session.fromPartition(`persist:game:${id}`);
  }, gameId);
}

test("editing the title and cover keeps gameId and partition; after a restart the card and the saves are the same (AC-17, AC-1)", async () => {
  const userData = await tempDir();
  const coverFile = join(await tempDir(), "cover.png");
  await writeFile(coverFile, PNG_1X1);
  // A fixture server of its own, so the game's URL (and its origin, which keys the storage) survives the restart.
  const lab = await startProgressLab();
  servers.push(lab);
  launched = await launchApp({ userData });

  await addByUi(launched.launcher, `${lab.local}/`);
  await expect(cards(launched.launcher)).toHaveCount(1);
  const gameId = (await cards(launched.launcher).getAttribute("data-game-id")) ?? "";
  expect(gameId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const card = cardOf(launched.launcher, gameId);
  // The title defaults to the host name; badges are the recorded ones only.
  await expect(card.locator(".title")).toHaveText("localhost");
  await expect(card.locator(".url")).toHaveText(`${lab.local}/`);
  await expect(card.locator(".badges li")).toHaveText([
    "By link",
    "Needs internet",
    "Compatibility not verified",
  ]);

  // Play opens the game; the card follows the game:state events.
  const page = await playFromCard(launched, gameId);
  await expect(card.locator(".state")).toHaveText("Running");
  expect(await usesPartitionOf(launched, gameId)).toBe(true);
  const game = progressLab(page);
  await game.play(2);
  const hash = await game.ready();
  expect(await closeGame(launched, gameId)).toBe(true);
  await expectState(launched, gameId, "exited");
  await expect(card.locator(".state")).toHaveCount(0);

  // Edit the title (trimmed by main) and the cover (chosen in the native dialog, copied to covers/).
  await card.getByRole("button", { name: "Edit title" }).click();
  await card.getByLabel("Title", { exact: true }).fill("  Progress Lab  ");
  await card.getByRole("button", { name: "Save title" }).click();
  await expect(card.locator(".title")).toHaveText("Progress Lab");
  await queueOpenFile(launched, coverFile);
  await card.getByRole("button", { name: "Choose cover" }).click();
  const cover = card.locator("img.cover");
  await expect(cover).toHaveAttribute(
    "src",
    new RegExp(`^app://launcher/covers/${gameId}-[0-9a-f]{16}\\.png$`),
  );
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  const coverSrc = await cover.getAttribute("src");
  expect((await launched.hooks()).dialogsShown).toContainEqual({
    kind: "openFile",
    title: "Choose a cover image",
  });
  await launched.close();

  // AC-1: after a full restart the entry is the same, and Play opens the same partition with the same progress.
  launched = await launchApp({ userData });
  const again = cardOf(launched.launcher, gameId);
  await expect(cards(launched.launcher)).toHaveCount(1);
  await expect(again.locator(".title")).toHaveText("Progress Lab");
  await expect(again.locator(".url")).toHaveText(`${lab.local}/`);
  await expect(again.locator("img.cover")).toHaveAttribute("src", coverSrc ?? "");
  await expect
    .poll(() => again.locator("img.cover").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  const reopened = await playFromCard(launched, gameId);
  expect(await usesPartitionOf(launched, gameId)).toBe(true);
  expect(await progressLab(reopened).ready()).toBe(hash);
  expect(await closeGame(launched, gameId)).toBe(true);
  await expectState(launched, gameId, "exited");
});

test("bad URLs are refused, the same URL twice warns first, titles render as text, remove keeps the data (AC-17, AC-2, S-15)", async () => {
  launched = await launchApp();
  const { launcher, progressLab: lab } = launched;
  const address = launcher.getByLabel("Game address");

  // AC-17: not https is refused with URL_NOT_ALLOWED; the pasted address is trimmed visibly before it is sent.
  for (const bad of ["  ftp://example.com/  ", "http://example.com/"]) {
    await addByUi(launcher, bad);
    await expect(address).toHaveValue(bad.trim());
    await expect(launcher.locator(".add-message")).toHaveText(/^Only https:\/\/ addresses/);
  }
  for (const url of ["ftp://example.com/", "http://example.com/", " https://example.com/"]) {
    expect(await launcher.evaluate((u) => window.wg?.addGame({ url: u }), url)).toMatchObject({
      ok: false,
      code: "URL_NOT_ALLOWED",
    });
  }
  await expect(cards(launcher)).toHaveCount(0);

  // S-15: a hostile title is text, nothing runs, and no CSP violation happens.
  const hostile = `<img src=x onerror="document.title='pwned'">`;
  await addByUi(launcher, `  ${lab.loopback}/  `, hostile);
  await expect(cards(launcher)).toHaveCount(1);
  const first = (await cards(launcher).getAttribute("data-game-id")) ?? "";
  await expect(cardOf(launcher, first).locator(".title")).toHaveText(hostile);
  await expect(cardOf(launcher, first).locator(".title img")).toHaveCount(0);
  expect(await launcher.title()).toBe("WGLauncher");

  // AC-2: the same URL again asks first. Cancel adds nothing; confirming adds a second entry with its own id.
  await queueConfirm(launched, false);
  await addByUi(launcher, `${lab.loopback}/`);
  await expect(launcher.locator(".add-message")).toHaveText("Nothing was added.");
  await expect(cards(launcher)).toHaveCount(1);
  await queueConfirm(launched, true);
  await addByUi(launcher, `${lab.loopback}/`, "Second");
  await expect(cards(launcher)).toHaveCount(2);
  const ids = await cards(launcher).evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-game-id")),
  );
  const second = ids.find((id) => id !== first) ?? "";
  expect(second).not.toBe("");
  expect(
    (await launched.hooks()).dialogsShown.filter((d) => d.title === "Already in the library"),
  ).toHaveLength(2);

  // Remove from library: the card goes, the snapshot row stays, the entry is listed under "Data of removed games".
  await launched.app.evaluate(
    (_electron, id) => globalThis.__wgTest?.addSnapshotRecord(id),
    second,
  );
  await queueConfirm(launched, true);
  await cardOf(launcher, second).getByRole("button", { name: "Remove from library" }).click();
  await expect(cardOf(launcher, second)).toHaveCount(0);
  await expect(cards(launcher)).toHaveCount(1);
  expect((await launched.hooks()).dialogsShown.at(-1)).toEqual({
    kind: "confirm",
    title: "Remove from library?",
  });
  expect(
    await launched.app.evaluate((_electron, id) => globalThis.__wgTest?.snapshotCount(id), second),
  ).toBe(1);
  await launcher.getByRole("button", { name: "Settings" }).click();
  const orphan = launcher.locator(`.orphans li[data-game-id="${second}"]`);
  await expect(orphan.locator(".title")).toHaveText("Second");
  await expect(orphan.locator(".url")).toHaveText(`${lab.loopback}/`);

  const console = (await launched.hooks()).launcherConsole;
  expect(console.filter((record) => VIOLATION.test(record.message))).toEqual([]);
  expect(console.filter((record) => record.level === "error")).toEqual([]);
});

test("a database written by a newer app: the UI says so and every write is refused (architecture.md section 7)", async () => {
  const userData = await tempDir();
  const file = join(userData, "library.db");
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  const before = await readFile(file);

  launched = await launchApp({ userData });
  const { launcher } = launched;
  await expect(launcher.locator("#library-read-only")).toContainText("newer");
  await expect(launcher.getByLabel("Game address")).toHaveCount(0);
  const id = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
  const results = await launcher.evaluate(async (gameId) => {
    const wg = window.wg;
    if (!wg) return [];
    return Promise.all([
      wg.addGame({ url: "https://example.com/" }),
      wg.updateGame({ gameId, title: "T" }),
      wg.removeGame({ gameId }),
      wg.launchGame({ gameId }),
      wg.setSettings({}),
    ]);
  }, id);
  expect(results).toHaveLength(5);
  for (const result of results)
    expect(result).toMatchObject({ ok: false, code: "LIBRARY_READ_ONLY" });
  // The notice stays on the other view too.
  await launcher.getByRole("button", { name: "Settings" }).click();
  await expect(launcher.getByRole("alert")).toContainText("read-only");
  await launched.close();
  launched = undefined;
  expect(await readFile(file)).toEqual(before);
});

test("a corrupt library.db at start-up shows an error dialog and exits 1 without changing the file", async () => {
  const userData = await tempDir();
  const file = join(userData, "library.db");
  const garbage = Buffer.from("this is not a SQLite database\n".repeat(64));
  await writeFile(file, garbage);
  const profiles = await guardRealProfiles();

  // Plain spawn: the app exits during start-up, before Playwright could attach to a window.
  expect(await runSecondInstance(userData)).toBe(1);
  await profiles.verify();

  // The test flavor records error dialogs in this file (TEST_ERROR_DIALOGS_FILE in src/main/test-hooks.ts).
  const shown = (await readFile(join(userData, "test-error-dialogs.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  expect(shown).toEqual([
    {
      title: "WGLauncher cannot open its library",
      message: expect.stringContaining("Nothing was deleted"),
    },
  ]);
  expect(await readFile(file)).toEqual(garbage);
  const failures = await eventsNamed({ userData } as Launched, "db.open-failed");
  expect(failures).toHaveLength(1);
});
