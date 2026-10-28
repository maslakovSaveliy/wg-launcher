import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowState } from "../db/repos/window-state.js";
import {
  applySavedFlags,
  displayAreas,
  FULLSCREEN_RESTORE_ATTEMPTS,
  FULLSCREEN_RESTORE_RETRY_MS,
  initialBounds,
  trackWindowState,
  WINDOW_STATE_DEBOUNCE_MS,
} from "./window-state.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

class FakeWindow extends EventEmitter {
  normal = { x: 10, y: 20, width: 800, height: 600 };
  /** What getBounds would give (fullscreen or maximized): must never be saved. */
  current = { x: 0, y: 0, width: 1920, height: 1080 };
  maximized = false;
  fullscreen = false;
  calls: string[] = [];
  getNormalBounds() {
    return { ...this.normal };
  }
  getBounds() {
    return { ...this.current };
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return this.fullscreen;
  }
  maximize() {
    this.calls.push("maximize");
  }
  setFullScreen(flag: boolean) {
    this.calls.push(`setFullScreen ${flag}`);
  }
}

function setUp(
  options: {
    save?: (state: Omit<WindowState, "updatedAt">) => void;
    isPageFullscreen?: () => boolean;
  } = {},
) {
  const window = new FakeWindow();
  const saved: Array<Omit<WindowState, "updatedAt">> = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const displayIdOf = vi.fn((bounds: { x: number }) => (bounds.x < 1920 ? "1" : "2"));
  trackWindowState(window, {
    gameId: GAME,
    save: options.save ?? ((state) => saved.push(state)),
    displayIdOf,
    log,
    isPageFullscreen: options.isPageFullscreen ?? (() => false),
  });
  return { window, saved, log, displayIdOf };
}

const closeEvent = () => ({ preventDefault: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("trackWindowState (architecture.md section 9)", () => {
  it("saves 500 ms after the last move or resize, once, with the latest state", () => {
    const { window, saved } = setUp();
    expect(WINDOW_STATE_DEBOUNCE_MS).toBe(500);
    window.emit("move");
    vi.advanceTimersByTime(300);
    window.normal = { x: 40, y: 50, width: 900, height: 700 };
    window.emit("resize");
    vi.advanceTimersByTime(499);
    expect(saved).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(saved).toEqual([
      {
        gameId: GAME,
        x: 40,
        y: 50,
        width: 900,
        height: 700,
        displayId: "1",
        maximized: false,
        fullscreen: false,
      },
    ]);
    vi.advanceTimersByTime(5000);
    expect(saved).toHaveLength(1);
  });

  it("saves the normal bounds, the maximized and fullscreen flags and the display of the normal bounds", () => {
    const { window, saved, displayIdOf } = setUp();
    window.normal = { x: 2000, y: 30, width: 1000, height: 640 };
    window.maximized = true;
    window.fullscreen = true;
    window.emit("resize");
    vi.advanceTimersByTime(WINDOW_STATE_DEBOUNCE_MS);
    expect(saved).toEqual([
      {
        gameId: GAME,
        x: 2000,
        y: 30,
        width: 1000,
        height: 640,
        displayId: "2",
        maximized: true,
        fullscreen: true,
      },
    ]);
    expect(displayIdOf).toHaveBeenCalledWith({ x: 2000, y: 30, width: 1000, height: 640 });
  });

  it("saves a fullscreen the page requested as not fullscreen, so it never comes back as the launcher's (review fix 1)", () => {
    let page = true;
    const { window, saved } = setUp({ isPageFullscreen: () => page });
    window.fullscreen = true;
    window.emit("enter-full-screen");
    vi.advanceTimersByTime(WINDOW_STATE_DEBOUNCE_MS);
    window.emit("close", closeEvent());
    expect(saved.map((state) => state.fullscreen)).toEqual([false, false]);
    // Once the page has left its fullscreen, a fullscreen the launcher sets is saved again.
    page = false;
    window.emit("show");
    window.emit("close", closeEvent());
    expect(saved.at(-1)?.fullscreen).toBe(true);
  });

  it("also saves after maximize and fullscreen changes", () => {
    for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
      const { window, saved } = setUp();
      window.emit(event);
      vi.advanceTimersByTime(WINDOW_STATE_DEBOUNCE_MS);
      expect(saved, event).toHaveLength(1);
    }
  });

  it("saves at once on close and drops the pending debounced save", () => {
    const { window, saved } = setUp();
    window.emit("move");
    window.normal = { x: 70, y: 80, width: 640, height: 480 };
    window.emit("close", closeEvent());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ x: 70, y: 80, width: 640, height: 480 });
    vi.advanceTimersByTime(5000);
    expect(saved).toHaveLength(1);
  });

  it("never prevents the close itself", () => {
    const { window } = setUp();
    const event = closeEvent();
    window.emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("saves once per close: a repeated close and moves while closing are ignored until the window is shown again", () => {
    const { window, saved } = setUp();
    window.emit("close", closeEvent());
    window.emit("close", closeEvent());
    window.emit("move");
    vi.advanceTimersByTime(WINDOW_STATE_DEBOUNCE_MS);
    expect(saved).toHaveLength(1);
    // "Stay" shows the window again: the next close saves again.
    window.emit("show");
    window.emit("close", closeEvent());
    expect(saved).toHaveLength(2);
  });

  it("saves nothing after the window is closed", () => {
    const { window, saved } = setUp();
    window.emit("resize");
    window.emit("closed");
    vi.advanceTimersByTime(WINDOW_STATE_DEBOUNCE_MS * 2);
    expect(saved).toEqual([]);
  });

  it("logs a failed save and never throws out of the window event", () => {
    const { window, log } = setUp({
      save: () => {
        throw new Error("disk full");
      },
    });
    expect(() => window.emit("close", closeEvent())).not.toThrow();
    expect(log.error).toHaveBeenCalledWith("game.window-state-save-failed", {
      gameId: GAME,
      error: expect.any(Error),
    });
  });
});

describe("restoring a window", () => {
  const displays = [
    { id: "1", primary: true, workArea: { x: 0, y: 25, width: 1920, height: 1055 } },
  ];
  const row = (patch: Partial<WindowState>): WindowState => ({
    gameId: GAME,
    x: 100,
    y: 120,
    width: 900,
    height: 600,
    displayId: "1",
    maximized: false,
    fullscreen: false,
    updatedAt: 1,
    ...patch,
  });

  it("starts from the saved bounds through the off-screen guard", () => {
    expect(initialBounds(row({}), displays)).toEqual({ x: 100, y: 120, width: 900, height: 600 });
    expect(initialBounds(row({ x: 9000, y: 9000 }), displays)).toEqual({
      x: 320,
      y: 152,
      width: 1280,
      height: 800,
    });
    expect(initialBounds(null, displays)).toEqual({ x: 320, y: 152, width: 1280, height: 800 });
  });

  const flagDeps = () => ({
    gameId: GAME,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() },
  });

  it("re-applies maximized and fullscreen when the window is first shown, not before and not again", () => {
    const window = new FakeWindow();
    applySavedFlags(window, row({ maximized: true, fullscreen: true }), flagDeps());
    expect(window.calls).toEqual([]);
    window.emit("show");
    expect(window.calls).toEqual(["maximize", "setFullScreen true"]);
    window.emit("show");
    expect(window.calls).toHaveLength(2);
  });

  it("applies nothing for a normal window or no saved state", () => {
    const plain = new FakeWindow();
    applySavedFlags(plain, row({}), flagDeps());
    plain.emit("show");
    const none = new FakeWindow();
    applySavedFlags(none, null, flagDeps());
    none.emit("show");
    expect([...plain.calls, ...none.calls]).toEqual([]);
  });

  /**
   * What Electron 45 on macOS showed for a fullscreen request AppKit refused (a request made while the Space of a
   * fullscreen window closed a moment ago was still animating away): `isFullScreen()` turned true with a `resize`,
   * then false again with another `resize`, and neither `enter-full-screen` nor `leave-full-screen` came.
   */
  const refuse = (window: FakeWindow) => {
    window.fullscreen = true;
    window.emit("resize");
    window.fullscreen = false;
    window.emit("resize");
  };
  const enter = (window: FakeWindow) => {
    window.fullscreen = true;
    window.emit("resize");
    window.emit("enter-full-screen");
  };

  it("asks again when macOS refuses the restored fullscreen, until the window enters it", () => {
    const window = new FakeWindow();
    const deps = flagDeps();
    applySavedFlags(window, row({ fullscreen: true }), deps);
    window.emit("show");
    expect(window.calls).toEqual(["setFullScreen true"]);
    refuse(window);
    expect(window.calls).toHaveLength(1);
    vi.advanceTimersByTime(FULLSCREEN_RESTORE_RETRY_MS);
    expect(window.calls).toEqual(["setFullScreen true", "setFullScreen true"]);
    enter(window);
    expect(deps.log.info).toHaveBeenCalledWith("game.fullscreen-restore-retried", {
      gameId: GAME,
      attempts: 2,
    });
    // Once entered, leaving fullscreen is the user's (or Esc held): nothing asks again.
    window.fullscreen = false;
    window.emit("resize");
    window.emit("leave-full-screen");
    vi.advanceTimersByTime(10 * FULLSCREEN_RESTORE_RETRY_MS);
    expect(window.calls).toHaveLength(2);
    expect(deps.log.warn).not.toHaveBeenCalled();
  });

  it("gives up after a bounded number of refused requests and logs it", () => {
    const window = new FakeWindow();
    const deps = flagDeps();
    applySavedFlags(window, row({ fullscreen: true }), deps);
    window.emit("show");
    for (let attempt = 1; attempt <= FULLSCREEN_RESTORE_ATTEMPTS; attempt++) {
      refuse(window);
      vi.advanceTimersByTime(FULLSCREEN_RESTORE_RETRY_MS);
    }
    expect(window.calls).toHaveLength(FULLSCREEN_RESTORE_ATTEMPTS);
    expect(deps.log.warn).toHaveBeenCalledWith("game.fullscreen-restore-failed", {
      gameId: GAME,
      attempts: FULLSCREEN_RESTORE_ATTEMPTS,
    });
    vi.advanceTimersByTime(10 * FULLSCREEN_RESTORE_RETRY_MS);
    window.emit("resize");
    expect(window.calls).toHaveLength(FULLSCREEN_RESTORE_ATTEMPTS);
  });

  it("does not ask again once the window is closed, starts closing or has left fullscreen", () => {
    const closed = new FakeWindow();
    applySavedFlags(closed, row({ fullscreen: true }), flagDeps());
    closed.emit("show");
    refuse(closed);
    closed.emit("closed");
    vi.advanceTimersByTime(10 * FULLSCREEN_RESTORE_RETRY_MS);
    expect(closed.calls).toEqual(["setFullScreen true"]);

    // The close procedure starts at the first `close`, hides the window and destroys it only later: a retry due in
    // between would put a hidden window that is closing into fullscreen.
    const closing = new FakeWindow();
    applySavedFlags(closing, row({ fullscreen: true }), flagDeps());
    closing.emit("show");
    refuse(closing);
    closing.emit("close", closeEvent());
    vi.advanceTimersByTime(10 * FULLSCREEN_RESTORE_RETRY_MS);
    expect(closing.calls).toEqual(["setFullScreen true"]);

    const left = new FakeWindow();
    applySavedFlags(left, row({ fullscreen: true }), flagDeps());
    left.emit("show");
    refuse(left);
    left.emit("leave-full-screen");
    vi.advanceTimersByTime(10 * FULLSCREEN_RESTORE_RETRY_MS);
    expect(left.calls).toEqual(["setFullScreen true"]);

    // A refused request that the page's own fullscreen or a user toggle overtook: the window is in fullscreen when
    // the retry is due, so it is not asked again.
    const overtaken = new FakeWindow();
    applySavedFlags(overtaken, row({ fullscreen: true }), flagDeps());
    overtaken.emit("show");
    refuse(overtaken);
    overtaken.fullscreen = true;
    vi.advanceTimersByTime(FULLSCREEN_RESTORE_RETRY_MS);
    expect(overtaken.calls).toEqual(["setFullScreen true"]);
  });

  it("maps Electron's displays to work areas with the primary flagged", () => {
    const screen = {
      getAllDisplays: () => [
        { id: 7, workArea: { x: 0, y: 25, width: 1440, height: 875 } },
        { id: 9, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
      ],
      getPrimaryDisplay: () => ({ id: 9 }),
    };
    expect(displayAreas(screen)).toEqual([
      { id: "7", primary: false, workArea: { x: 0, y: 25, width: 1440, height: 875 } },
      { id: "9", primary: true, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
    ]);
  });
});
