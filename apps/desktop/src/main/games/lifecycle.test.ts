import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GameRuntime, type GameWindow } from "./lifecycle.js";
import { LockManager } from "./locks.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const URL_OF_GAME = "http://localhost:4317/";

class FakeWindow extends EventEmitter {
  visible = false;
  minimized = false;
  destroyed = false;
  calls: string[] = [];
  webContents = Object.assign(new EventEmitter(), {
    loading: true,
    load: Promise.withResolvers<void>(),
    loadURL: (url: string) => {
      this.calls.push(`loadURL ${url}`);
      return this.webContents.load.promise;
    },
    isLoading: () => this.webContents.loading,
    forcefullyCrashRenderer: () => {
      this.calls.push("crash");
      this.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    },
  });
  show() {
    this.visible = true;
    this.calls.push("show");
  }
  focus() {
    this.calls.push("focus");
  }
  restore() {
    this.minimized = false;
    this.calls.push("restore");
  }
  isMinimized() {
    return this.minimized;
  }
  isVisible() {
    return this.visible;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.calls.push("destroy");
    this.emit("closed");
  }
  close() {
    const event = {
      defaultPrevented: false,
      preventDefault: () => (event.defaultPrevented = true),
    };
    this.emit("close", event);
    if (!event.defaultPrevented) this.destroy();
  }
}

function setUp(
  options: {
    game?: object | null;
    closeOutcome?: "closed" | "stayed";
    answers?: boolean[];
    launchShowTimeoutMs?: number;
  } = {},
) {
  const windows: FakeWindow[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const locks = new LockManager({ log });
  const answers = options.answers ?? [];
  const confirm = vi.fn(async () => answers.shift() ?? false);
  const closeWindow = vi.fn(async (window: GameWindow) => {
    const outcome = options.closeOutcome ?? "closed";
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (outcome === "closed") window.destroy();
    return outcome;
  });
  const game =
    options.game === undefined
      ? { id: GAME, url: URL_OF_GAME, title: "Lab", needsRecovery: false }
      : options.game;
  const states: string[] = [];
  const runtime = new GameRuntime({
    onState: (gameId, state) => states.push(`${gameId === GAME ? "game" : gameId} ${state}`),
    games: { get: (id: string) => (game && id === GAME ? (game as never) : null) },
    locks,
    log,
    dialogs: { confirm },
    flavor: "test",
    openWindow: () => {
      const window = new FakeWindow();
      windows.push(window);
      return window as unknown as GameWindow;
    },
    closeWindow,
    ...(options.launchShowTimeoutMs === undefined
      ? {}
      : { launchShowTimeoutMs: options.launchShowTimeoutMs }),
  });
  return { runtime, windows, locks, log, confirm, closeWindow, states };
}

describe("GameRuntime.launch: one window per game (F-5, Review Focus 3)", () => {
  it("opens the window hidden, loads the entry URL and shows it on ready-to-show", async () => {
    const { runtime, windows } = setUp();
    expect(await runtime.launch(GAME)).toEqual({ ok: true, data: { window: "opened" } });
    expect(runtime.state(GAME)).toBe("launching");
    const [window] = windows;
    expect(window?.calls).toEqual([`loadURL ${URL_OF_GAME}`]);
    window?.emit("ready-to-show");
    expect(runtime.state(GAME)).toBe("running");
    expect(window?.calls).toEqual([`loadURL ${URL_OF_GAME}`, "show", "focus"]);
  });

  it("two launches at once open one window", async () => {
    const { runtime, windows } = setUp();
    const [first, second] = await Promise.all([runtime.launch(GAME), runtime.launch(GAME)]);
    expect(windows).toHaveLength(1);
    expect(first).toEqual({ ok: true, data: { window: "opened" } });
    expect(second).toEqual({ ok: true, data: { window: "focused" } });
  });

  it("a launch while launching or running focuses the window instead", async () => {
    const { runtime, windows } = setUp();
    await runtime.launch(GAME);
    expect(await runtime.launch(GAME)).toEqual({ ok: true, data: { window: "focused" } });
    const [window] = windows;
    expect(window?.calls).not.toContain("show");
    window?.emit("ready-to-show");
    if (window) window.minimized = true;
    expect(await runtime.launch(GAME)).toEqual({ ok: true, data: { window: "focused" } });
    expect(window?.calls.slice(-2)).toEqual(["restore", "focus"]);
    expect(windows).toHaveLength(1);
  });

  it("refuses an unknown game, a malformed id and a game that needs recovery", async () => {
    expect(await setUp({ game: null }).runtime.launch(GAME)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await setUp().runtime.launch("not-an-id")).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
    const recovery = setUp({
      game: { id: GAME, url: URL_OF_GAME, title: "Lab", needsRecovery: true },
    });
    expect(await recovery.runtime.launch(GAME)).toMatchObject({
      ok: false,
      code: "NEEDS_RECOVERY",
    });
    expect(recovery.windows).toHaveLength(0);
  });

  it("refuses an entry URL this build does not allow", async () => {
    const { runtime, windows } = setUp({
      game: { id: GAME, url: "file:///etc/passwd", title: "x", needsRecovery: false },
    });
    expect(await runtime.launch(GAME)).toMatchObject({ ok: false, code: "URL_NOT_ALLOWED" });
    expect(windows).toHaveLength(0);
  });

  it("passes a lock refusal through and opens nothing (GAME_BUSY while a task holds the lock)", async () => {
    const { runtime, locks, windows } = setUp();
    await locks.acquire(GAME, "task");
    expect(await runtime.launch(GAME)).toMatchObject({ ok: false, code: "GAME_BUSY" });
    expect(windows).toHaveLength(0);
    expect(runtime.state(GAME)).toBe("idle");
  });
});

describe("GameRuntime: closing, crash and hang", () => {
  it("close runs the procedure, then the game is exited and the session lock is free", async () => {
    const { runtime, windows, locks, closeWindow } = setUp();
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    expect(locks.holder(GAME)).toBe("session");
    windows[0]?.close();
    expect(runtime.state(GAME)).toBe("closing");
    await vi.waitFor(() => expect(runtime.state(GAME)).toBe("exited"));
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(locks.holder(GAME)).toBe("none");
    expect((await runtime.launch(GAME)).ok).toBe(true);
    expect(windows).toHaveLength(2);
  });

  it("when the user stays, the game keeps running", async () => {
    const { runtime, windows, locks } = setUp({ closeOutcome: "stayed" });
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    windows[0]?.close();
    await vi.waitFor(() => expect(runtime.state(GAME)).toBe("running"));
    expect(locks.holder(GAME)).toBe("session");
  });

  it("a launch while closing opens no second window and says the game is closing", async () => {
    const { runtime, windows } = setUp({ closeOutcome: "stayed" });
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    windows[0]?.close();
    expect(await runtime.launch(GAME)).toEqual({ ok: true, data: { window: "closing" } });
    expect(windows).toHaveLength(1);
    // Only the focus of ready-to-show: the closing window is neither shown nor focused.
    expect(windows[0]?.calls.filter((call) => call === "focus" || call === "show")).toEqual([
      "show",
      "focus",
    ]);
  });

  it("a window that never paints is shown after the launching timeout and can then be closed", async () => {
    const { runtime, windows, log } = setUp({ launchShowTimeoutMs: 20 });
    await runtime.launch(GAME);
    const [window] = windows;
    expect(window?.visible).toBe(false);
    await vi.waitFor(() => expect(runtime.state(GAME)).toBe("running"));
    expect(window?.calls).toEqual([`loadURL ${URL_OF_GAME}`, "show", "focus"]);
    expect(log.warn).toHaveBeenCalledWith("game.show-timeout", { gameId: GAME, waitedMs: 20 });
    // A late ready-to-show changes nothing.
    window?.emit("ready-to-show");
    expect(window?.calls.filter((call) => call === "show")).toHaveLength(1);
    window?.close();
    await vi.waitFor(() => expect(runtime.state(GAME)).toBe("exited"));
  });

  it("the launching timeout does nothing once the window was shown", async () => {
    const { runtime, windows, log } = setUp({ launchShowTimeoutMs: 20 });
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(windows[0]?.calls.filter((call) => call === "show")).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalledWith("game.show-timeout", expect.anything());
  });

  it("render-process-gone ends the session as crashed and frees the lock", async () => {
    const { runtime, windows, locks } = setUp();
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    windows[0]?.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    expect(runtime.state(GAME)).toBe("crashed");
    expect(windows[0]?.destroyed).toBe(true);
    expect(locks.holder(GAME)).toBe("none");
  });

  it("unresponsive offers Force close, which crashes the renderer (then crashed)", async () => {
    const { runtime, windows, confirm } = setUp({ answers: [true] });
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    windows[0]?.emit("unresponsive");
    await vi.waitFor(() => expect(runtime.state(GAME)).toBe("crashed"));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "Force close" }));
    expect(windows[0]?.calls).toContain("crash");
  });

  it("unresponsive and Wait keeps the game", async () => {
    const { runtime, windows } = setUp({ answers: [false] });
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    windows[0]?.emit("unresponsive");
    await Promise.resolve();
    expect(runtime.state(GAME)).toBe("running");
    expect(windows[0]?.calls).not.toContain("crash");
  });

  it("a load that is aborted before the window was shown ends as exited", async () => {
    const { runtime, windows, locks } = setUp();
    await runtime.launch(GAME);
    const window = windows[0];
    if (!window) throw new Error("no window");
    window.webContents.loading = false;
    window.webContents.load.reject(Object.assign(new Error("ERR_ABORTED (-3)"), { errno: -3 }));
    await vi.waitFor(() => expect(runtime.state(GAME)).toBe("exited"));
    expect(window.destroyed).toBe(true);
    expect(locks.holder(GAME)).toBe("none");
  });

  it("closeAll closes every open game and resolves when they are done", async () => {
    const { runtime, windows, closeWindow } = setUp();
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    await runtime.closeAll();
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(runtime.state(GAME)).toBe("exited");
    expect(runtime.openGames()).toEqual([]);
  });
});

describe("GameRuntime: state changes for game:state (architecture.md section 6)", () => {
  it("reports every transition of a launch and a close, once each", async () => {
    const { runtime, windows, states } = setUp();
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    await runtime.launch(GAME); // a focus changes no state
    windows[0]?.close();
    await vi.waitFor(() => expect(runtime.state(GAME)).toBe("exited"));
    expect(states).toEqual(["game launching", "game running", "game closing", "game exited"]);
  });

  it("reports running again when the user stays, and crashed on a crash", async () => {
    const { runtime, windows, states } = setUp({ closeOutcome: "stayed" });
    await runtime.launch(GAME);
    windows[0]?.emit("ready-to-show");
    windows[0]?.close();
    await vi.waitFor(() => expect(states.at(-1)).toBe("game running"));
    windows[0]?.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    expect(states).toEqual([
      "game launching",
      "game running",
      "game closing",
      "game running",
      "game crashed",
    ]);
  });

  it("reports idle again when a launch is refused by the lock", async () => {
    const { runtime, locks, states } = setUp();
    const lease = await locks.acquire(GAME, "task");
    expect((await runtime.launch(GAME)).ok).toBe(false);
    expect(states).toEqual(["game launching", "game idle"]);
    if ("release" in lease) lease.release();
  });
});
