// Helpers for the game-window e2e specs: drive the main process through the test hooks, find the game window's
// Playwright page, read the redacted main log, and drive progress-lab (its README is the contract).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { GameState, LaunchResult } from "../src/main/games/lifecycle.js";
import type { Launched } from "./harness.js";

export async function addGame(launched: Launched, url: string, title?: string): Promise<string> {
  return launched.app.evaluate(
    (_electron, [url, title]) => globalThis.__wgTest?.addGame(url as string, title) ?? "",
    [url, title] as const,
  );
}

export async function launchGame(launched: Launched, gameId: string): Promise<LaunchResult> {
  return launched.app.evaluate(
    (_electron, id) => globalThis.__wgTest?.launchGame(id) as Promise<LaunchResult>,
    gameId,
  );
}

export async function gameState(launched: Launched, gameId: string): Promise<GameState> {
  return launched.app.evaluate(
    (_electron, id) => globalThis.__wgTest?.gameState(id) ?? "idle",
    gameId,
  );
}

export async function expectState(launched: Launched, gameId: string, state: GameState) {
  await expect.poll(() => gameState(launched, gameId), { timeout: 15_000 }).toBe(state);
}

/**
 * Launches the game and resolves with its window's page once that window shows the game. Snapshot jobs open
 * hidden windows too (a storage check runs after every exit), so the game's page is the new window that shows the
 * game window's own URL, never the first window that appears.
 */
export async function openGame(
  launched: Launched,
  gameId: string,
  /** How the launch is asked for; by default through the test hook, a UI spec clicks Play instead. */
  start?: () => Promise<void>,
): Promise<Page> {
  const pages: Page[] = [];
  const onWindow = (page: Page) => pages.push(page);
  launched.app.on("window", onWindow);
  try {
    if (start) await start();
    else {
      const result = await launchGame(launched, gameId);
      expect(result).toEqual({ ok: true, data: { window: "opened" } });
    }
    await expectState(launched, gameId, "running");
    const urlOfGame = () =>
      launched.app.evaluate(({ webContents }, id) => {
        const cid = globalThis.__wgTest?.gameWebContentsId(id) ?? null;
        return cid === null ? null : (webContents.fromId(cid)?.getURL() ?? null);
      }, gameId);
    let found: Page | undefined;
    await expect
      .poll(async () => {
        const url = await urlOfGame();
        found = pages.find((page) => !page.isClosed() && url !== null && page.url() === url);
        return found !== undefined;
      })
      .toBe(true);
    const page = found as Page;
    await page.waitForLoadState("load");
    return page;
  } finally {
    launched.app.off("window", onWindow);
  }
}

export async function closeGame(launched: Launched, gameId: string): Promise<boolean> {
  return launched.app.evaluate(
    (_electron, id) => globalThis.__wgTest?.closeGame(id) ?? false,
    gameId,
  );
}

/** The windows of the app but the hidden quiescent ones (a storage check runs after every game exit). */
export async function windowCount(launched: Launched): Promise<number> {
  return launched.app.evaluate(() => globalThis.__wgTest?.windowCount() ?? -1);
}

export function queueConfirm(launched: Launched, value: boolean): Promise<void> {
  return launched.app.evaluate(
    (_electron, value) => globalThis.__wgTest?.queueDialogAnswer({ kind: "confirm", value }),
    value,
  );
}

export function queueOpenFile(launched: Launched, path: string | null): Promise<void> {
  return launched.app.evaluate(
    (_electron, value) => globalThis.__wgTest?.queueDialogAnswer({ kind: "openFile", value }),
    path,
  );
}

export type LogLine = Record<string, unknown> & { event: string; level: string };

/** Every record of `logs/main.log` so far (the logger writes asynchronously, so poll for what you expect). */
export async function logLines(launched: Launched): Promise<LogLine[]> {
  const text = await readFile(join(launched.userData, "logs", "main.log"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LogLine);
}

export async function eventsNamed(launched: Launched, event: string): Promise<LogLine[]> {
  return (await logLines(launched)).filter((line) => line.event === event);
}

/** Drives progress-lab in a page or a frame. */
export function progressLab(scope: { locator(selector: string): Locator }) {
  const hash = scope.locator("#progress-hash");
  const coins = scope.locator("#coins");
  const ready = async (): Promise<string> => {
    await expect(hash).toHaveAttribute("data-ready", "true");
    await expect(hash).toHaveText(/^[0-9a-f]{64}$/);
    return (await hash.textContent()) ?? "";
  };
  return {
    coins,
    ready,
    async play(steps: number): Promise<void> {
      await ready();
      const start = Number(await coins.textContent());
      for (let step = 1; step <= steps; step++) {
        await scope.locator("#play-step").click();
        await expect(coins).toHaveText(String(start + step * 10));
      }
      await ready();
    },
  };
}
