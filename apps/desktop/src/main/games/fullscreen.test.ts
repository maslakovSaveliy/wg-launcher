import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEscHold, ESC_HOLD_MS, wireFullscreen } from "./fullscreen.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

class FakeWindow extends EventEmitter {
  fullscreen = false;
  calls: string[] = [];
  webContents = new EventEmitter();
  isFullScreen() {
    return this.fullscreen;
  }
  setFullScreen(flag: boolean) {
    this.calls.push(`setFullScreen ${flag}`);
    this.fullscreen = flag;
  }
}

/** Sends one key event through `before-input-event`, as Electron does, and returns the event object. */
function key(window: FakeWindow, type: "keyDown" | "keyUp", name: string, isAutoRepeat = false) {
  const event = { preventDefault: vi.fn() };
  window.webContents.emit("before-input-event", event, { type, key: name, isAutoRepeat });
  return event;
}

function setUp() {
  const window = new FakeWindow();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const wired = wireFullscreen(window, { gameId: GAME, log });
  return { window, log, wired };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createEscHold", () => {
  it("fires once Esc has been held for 1.5 s, and not before", () => {
    expect(ESC_HOLD_MS).toBe(1500);
    const onHold = vi.fn();
    const hold = createEscHold(onHold);
    hold.input({ type: "keyDown", key: "Escape" });
    // Auto-repeat while held does not restart the hold.
    vi.advanceTimersByTime(1000);
    hold.input({ type: "keyDown", key: "Escape", isAutoRepeat: true });
    vi.advanceTimersByTime(499);
    expect(onHold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    // Still held: no second exit until Esc is released and pressed again.
    vi.advanceTimersByTime(5000);
    hold.input({ type: "keyDown", key: "Escape", isAutoRepeat: true });
    vi.advanceTimersByTime(5000);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a short press, or when Esc is released at 1499 ms", () => {
    const onHold = vi.fn();
    const hold = createEscHold(onHold);
    hold.input({ type: "keyDown", key: "Escape" });
    vi.advanceTimersByTime(100);
    hold.input({ type: "keyUp", key: "Escape" });
    hold.input({ type: "keyDown", key: "Escape" });
    vi.advanceTimersByTime(1499);
    hold.input({ type: "keyUp", key: "Escape" });
    vi.advanceTimersByTime(10_000);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("ignores other keys, and stops on cancel", () => {
    const onHold = vi.fn();
    const hold = createEscHold(onHold);
    hold.input({ type: "keyDown", key: "Enter" });
    hold.input({ type: "keyDown", key: "Esc" });
    vi.advanceTimersByTime(ESC_HOLD_MS);
    hold.input({ type: "keyDown", key: "Escape" });
    hold.cancel();
    vi.advanceTimersByTime(ESC_HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });
});

describe("wireFullscreen (architecture.md section 9, AC-18)", () => {
  it("never prevents a key event, Esc included, held or not", () => {
    const { window } = setUp();
    window.fullscreen = true;
    const events = [
      key(window, "keyDown", "Escape"),
      key(window, "keyUp", "Escape"),
      key(window, "keyDown", "Escape"),
    ];
    vi.advanceTimersByTime(ESC_HOLD_MS);
    events.push(key(window, "keyUp", "Escape"), key(window, "keyDown", "a"));
    for (const event of events) expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ends a fullscreen the launcher set when Esc is held for 1.5 s, and logs it", () => {
    const { window, log } = setUp();
    window.fullscreen = true;
    key(window, "keyDown", "Escape");
    vi.advanceTimersByTime(ESC_HOLD_MS);
    expect(window.calls).toEqual(["setFullScreen false"]);
    expect(log.info).toHaveBeenCalledWith("game.fullscreen-esc-exit", { gameId: GAME });
  });

  it("leaves fullscreen alone on a short Esc", () => {
    const { window } = setUp();
    window.fullscreen = true;
    key(window, "keyDown", "Escape");
    vi.advanceTimersByTime(200);
    key(window, "keyUp", "Escape");
    vi.advanceTimersByTime(ESC_HOLD_MS * 2);
    expect(window.calls).toEqual([]);
  });

  it("does nothing when the window is not fullscreen", () => {
    const { window } = setUp();
    key(window, "keyDown", "Escape");
    vi.advanceTimersByTime(ESC_HOLD_MS);
    expect(window.calls).toEqual([]);
  });

  it("leaves a fullscreen the page requested to Chromium", () => {
    const { window } = setUp();
    window.emit("enter-html-full-screen");
    window.fullscreen = true;
    key(window, "keyDown", "Escape");
    vi.advanceTimersByTime(ESC_HOLD_MS);
    expect(window.calls).toEqual([]);
    // Once the page has left its fullscreen, a fullscreen the launcher sets is the launcher's again.
    window.emit("leave-html-full-screen");
    key(window, "keyUp", "Escape");
    key(window, "keyDown", "Escape");
    vi.advanceTimersByTime(ESC_HOLD_MS);
    expect(window.calls).toEqual(["setFullScreen false"]);
  });

  it("tells whether the page holds a fullscreen of its own (window-state.ts saves that as not fullscreen)", () => {
    const { window, wired } = setUp();
    expect(wired.isPageFullscreen()).toBe(false);
    window.emit("enter-html-full-screen");
    expect(wired.isPageFullscreen()).toBe(true);
    window.emit("leave-html-full-screen");
    expect(wired.isPageFullscreen()).toBe(false);
  });

  it("cancels a hold when the window loses focus or closes (the key-up may never arrive)", () => {
    for (const event of ["blur", "closed"]) {
      const { window } = setUp();
      window.fullscreen = true;
      key(window, "keyDown", "Escape");
      vi.advanceTimersByTime(1000);
      window.emit(event);
      vi.advanceTimersByTime(ESC_HOLD_MS);
      expect(window.calls, event).toEqual([]);
    }
  });
});
