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

/** Launches the game and resolves with its window's page once that window shows the game. */
export async function openGame(launched: Launched, gameId: string): Promise<Page> {
  const [page, result] = await Promise.all([
    launched.app.waitForEvent("window"),
    launchGame(launched, gameId),
  ]);
  expect(result).toEqual({ ok: true, data: { window: "opened" } });
  await expectState(launched, gameId, "running");
  await page.waitForLoadState("load");
  return page;
}

export async function closeGame(launched: Launched, gameId: string): Promise<boolean> {
  return launched.app.evaluate(
    (_electron, id) => globalThis.__wgTest?.closeGame(id) ?? false,
    gameId,
  );
}

export async function windowCount(launched: Launched): Promise<number> {
  return launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

export function queueConfirm(launched: Launched, value: boolean): Promise<void> {
  return launched.app.evaluate(
    (_electron, value) => globalThis.__wgTest?.queueDialogAnswer({ kind: "confirm", value }),
    value,
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
