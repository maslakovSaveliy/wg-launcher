// Fullscreen of a game window (architecture.md section 9, PRD F-6, AC-18). The toggle is the menu item with role
// `togglefullscreen` (`app-menu.ts`). Esc stays with the game: the launcher never consumes it, has no accelerator on
// it and never calls `preventDefault` in `before-input-event`, which it only observes. A fullscreen the launcher set
// (the toggle, or the saved state re-applied at launch) also ends when Esc is held for 1.5 s; a short press only
// reaches the game. A fullscreen the page requested (`requestFullscreen`, Electron's `enter-html-full-screen`) is
// left to Chromium.

import type { Logger } from "../log/logger.js";

export const ESC_HOLD_MS = 1500;

/** The fields of Electron's `before-input-event` input that the hold reads. */
export interface KeyInput {
  type: string;
  key: string;
  isAutoRepeat?: boolean;
}

/**
 * Calls `onHold` once Esc has been down for `holdMs` without a key-up; auto-repeat does not restart it, and it fires
 * once per press. `cancel` drops a running hold (blur, close: the key-up may never arrive).
 */
export function createEscHold(onHold: () => void, holdMs = ESC_HOLD_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let down = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    down = false;
  };
  return {
    input(input: KeyInput): void {
      if (input.key !== "Escape") return;
      if (input.type === "keyUp") {
        cancel();
        return;
      }
      if (down || input.isAutoRepeat) return;
      down = true;
      timer = setTimeout(() => {
        timer = undefined;
        onHold();
      }, holdMs);
    },
    cancel,
  };
}

export interface FullscreenWindow {
  on(event: string, listener: () => void): unknown;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  webContents: {
    on(event: "before-input-event", listener: (event: unknown, input: KeyInput) => void): unknown;
  };
}

/** Wires the Esc hold of section 9 to one game window; tells whether the page holds its own fullscreen. */
export function wireFullscreen(
  window: FullscreenWindow,
  deps: { gameId: string; log: Pick<Logger, "info"> },
): { isPageFullscreen(): boolean } {
  let pageFullscreen = false;
  const hold = createEscHold(() => {
    if (!window.isFullScreen() || pageFullscreen) return;
    deps.log.info("game.fullscreen-esc-exit", { gameId: deps.gameId });
    window.setFullScreen(false);
  });
  window.on("enter-html-full-screen", () => {
    pageFullscreen = true;
  });
  window.on("leave-html-full-screen", () => {
    pageFullscreen = false;
  });
  // Observes only: the event object is never touched, so every key, Esc included, reaches the page.
  window.webContents.on("before-input-event", (_event, input) => hold.input(input));
  window.on("blur", hold.cancel);
  window.on("closed", hold.cancel);
  return { isPageFullscreen: () => pageFullscreen };
}
