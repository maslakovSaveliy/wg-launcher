// Per-game window state (architecture.md section 9, PRD F-7). Saved on `close` and, debounced by 500 ms, on move,
// resize, maximize and fullscreen changes: the normal bounds (`getNormalBounds()`, never the fullscreen or maximized
// bounds), `isMaximized()`, `isFullScreen()` and the id of the display matching the normal bounds. Restored through
// the off-screen guard `restoreBounds`; the maximized and fullscreen flags are re-applied when the window is first
// shown (a hidden window is not put into fullscreen). Electron is not imported: the caller passes the window and the
// `screen` functions, so the rules are unit-tested.

import type { WindowState } from "../db/repos/window-state.js";
import type { Logger } from "../log/logger.js";
import { type Bounds, type DisplayArea, restoreBounds } from "../policy/window-guard.js";

export const WINDOW_STATE_DEBOUNCE_MS = 500;

/** Window events after which the state is saved, debounced (move and resize per section 9; the rest are cheap). */
const CHANGE_EVENTS = [
  "move",
  "resize",
  "maximize",
  "unmaximize",
  "enter-full-screen",
  "leave-full-screen",
] as const;

export interface TrackedWindow {
  on(event: string, listener: () => void): unknown;
  getNormalBounds(): Bounds;
  isMaximized(): boolean;
  isFullScreen(): boolean;
}

export interface WindowStateDeps {
  gameId: string;
  save(state: Omit<WindowState, "updatedAt">): void;
  /** `String(screen.getDisplayMatching(bounds).id)`. */
  displayIdOf(bounds: Bounds): string | null;
  log: Pick<Logger, "error">;
  /**
   * True while the page holds a fullscreen it requested itself (`wireFullscreen`): that is saved as not fullscreen,
   * so it never comes back at the next launch as a fullscreen the launcher set, whose exit the page could not drive.
   */
  isPageFullscreen(): boolean;
}

/**
 * Saves the window's state as section 9 says. Never prevents the close. While the close procedure runs (from the
 * first `close` until the window is shown again after a "Stay"), nothing more is saved: the window is hidden then,
 * and its first `close` already recorded what the user saw.
 */
export function trackWindowState(window: TrackedWindow, deps: WindowStateDeps): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let closed = false;

  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    try {
      const normal = window.getNormalBounds();
      deps.save({
        gameId: deps.gameId,
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        displayId: deps.displayIdOf(normal),
        maximized: window.isMaximized(),
        fullscreen: window.isFullScreen() && !deps.isPageFullscreen(),
      });
    } catch (error) {
      deps.log.error("game.window-state-save-failed", { gameId: deps.gameId, error });
    }
  };
  const schedule = () => {
    if (closing || closed) return;
    clearTimeout(timer);
    timer = setTimeout(save, WINDOW_STATE_DEBOUNCE_MS);
  };

  for (const event of CHANGE_EVENTS) window.on(event, schedule);
  window.on("close", () => {
    if (closing || closed) return;
    closing = true;
    save();
  });
  window.on("show", () => {
    closing = false;
  });
  window.on("closed", () => {
    closed = true;
    clearTimeout(timer);
  });
}

/** Where a game window opens: its saved bounds through the off-screen guard, or the default. */
export function initialBounds(saved: WindowState | null, displays: readonly DisplayArea[]): Bounds {
  return restoreBounds(
    saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null,
    displays,
  );
}

/** Delay before a refused fullscreen restore is asked again, and how many requests are made at most (Assumed). */
export const FULLSCREEN_RESTORE_RETRY_MS = 250;
export const FULLSCREEN_RESTORE_ATTEMPTS = 8;

export interface FlagWindow {
  once(event: "show", listener: () => void): unknown;
  on(
    event: "resize" | "enter-full-screen" | "leave-full-screen" | "closed",
    listener: () => void,
  ): unknown;
  removeListener(event: string, listener: () => void): unknown;
  isFullScreen(): boolean;
  maximize(): void;
  setFullScreen(flag: boolean): void;
}

/**
 * Re-applies the saved maximized and fullscreen flags when the window is first shown. A fullscreen restored here is
 * one the launcher set (the page did not request it), so it ends with the toggle or Esc held (`fullscreen.ts`).
 *
 * macOS can refuse a fullscreen request: one made while the Space of a fullscreen window closed a moment ago is still
 * animating away (closing a game in fullscreen and launching it again) turned `isFullScreen()` true, then false again
 * with a `resize`, and no `enter-full-screen` or `leave-full-screen` came (Electron 45, MEMORY.md). Such a refusal is
 * asked again after `FULLSCREEN_RESTORE_RETRY_MS`, at most `FULLSCREEN_RESTORE_ATTEMPTS` requests in all; the restore
 * ends at `enter-full-screen`, `leave-full-screen` or `closed`, and a window already fullscreen when a retry is due is
 * left alone.
 */
export function applySavedFlags(
  window: FlagWindow,
  saved: WindowState | null,
  deps: { gameId: string; log: Pick<Logger, "info" | "warn"> },
): void {
  if (!saved || (!saved.maximized && !saved.fullscreen)) return;
  window.once("show", () => {
    if (saved.maximized) window.maximize();
    if (saved.fullscreen) restoreFullscreen(window, deps);
  });
}

function restoreFullscreen(
  window: FlagWindow,
  deps: { gameId: string; log: Pick<Logger, "info" | "warn"> },
): void {
  let attempts = 0;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = () => {
    timer = undefined;
    if (window.isFullScreen()) {
      stop();
      return;
    }
    attempts += 1;
    pending = true;
    window.setFullScreen(true);
  };
  const onResize = () => {
    if (!pending || window.isFullScreen()) return;
    // Refused: the request was dropped without entering fullscreen.
    pending = false;
    if (attempts >= FULLSCREEN_RESTORE_ATTEMPTS) {
      deps.log.warn("game.fullscreen-restore-failed", { gameId: deps.gameId, attempts });
      stop();
      return;
    }
    timer = setTimeout(request, FULLSCREEN_RESTORE_RETRY_MS);
  };
  const onEnter = () => {
    if (attempts > 1)
      deps.log.info("game.fullscreen-restore-retried", { gameId: deps.gameId, attempts });
    stop();
  };
  const stop = () => {
    pending = false;
    clearTimeout(timer);
    timer = undefined;
    window.removeListener("resize", onResize);
    window.removeListener("enter-full-screen", onEnter);
    window.removeListener("leave-full-screen", stop);
    window.removeListener("closed", stop);
  };
  window.on("resize", onResize);
  window.on("enter-full-screen", onEnter);
  window.on("leave-full-screen", stop);
  window.on("closed", stop);
  request();
}

/** The part of Electron's `screen` used to map displays. */
export interface ScreenLike {
  getAllDisplays(): Array<{ id: number; workArea: Bounds }>;
  getPrimaryDisplay(): { id: number };
}

export function displayAreas(screen: ScreenLike): DisplayArea[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    primary: display.id === primary,
    workArea: { ...display.workArea },
  }));
}
