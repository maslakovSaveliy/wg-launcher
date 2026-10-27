import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { type ClosableWindow, closeGameWindow } from "./close-procedure.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const FAST = { unloadMs: 50, workersMs: 60, pollMs: 5, commandMs: 40 };

interface FakeOptions {
  /** Version ids of running service workers before the close. */
  workers?: number[];
  /** What `ServiceWorker.stopAllWorkers` leaves running. */
  afterStopAll?: number[];
  /** What each `ServiceWorker.stopWorker` leaves running (by default it stops that version). */
  stopWorkerWorks?: boolean;
  /** The page has a beforeunload trap. */
  trap?: boolean;
  /** loadURL never settles (a hanging unload handler). */
  hang?: boolean;
  attachThrows?: boolean;
  /** `ServiceWorker.stopAllWorkers` rejects. */
  stopAllThrows?: boolean;
  /** Version ids whose `ServiceWorker.stopWorker` never answers. */
  stopWorkerHangs?: string[];
  /** The window was destroyed before the close procedure started. */
  destroyed?: boolean;
}

function fakeWindow(options: FakeOptions = {}) {
  const calls: string[] = [];
  let running = new Set(options.workers ?? []);
  const contents = new EventEmitter();
  let destroyed = options.destroyed ?? false;
  const window: ClosableWindow = {
    hide: () => calls.push("hide"),
    show: () => calls.push("show"),
    destroy: () => {
      calls.push("destroy");
      destroyed = true;
    },
    isDestroyed: () => destroyed,
    webContents: Object.assign(contents, {
      loadURL: async (url: string) => {
        calls.push(`loadURL ${url}`);
        if (options.hang) return new Promise<void>(() => undefined);
        if (options.trap) {
          let prevented = false;
          contents.emit("will-prevent-unload", { preventDefault: () => (prevented = true) });
          if (!prevented) {
            calls.push("unload cancelled");
            throw Object.assign(new Error("ERR_ABORTED (-3) loading 'about:blank'"), {
              code: "ERR_ABORTED",
              errno: -3,
            });
          }
          calls.push("unload forced");
        }
      },
      debugger: {
        attached: false,
        attach(version?: string) {
          calls.push(`attach ${version}`);
          if (options.attachThrows) throw new Error("Another debugger is already attached");
          this.attached = true;
        },
        detach() {
          calls.push("detach");
          this.attached = false;
        },
        isAttached() {
          return this.attached;
        },
        async sendCommand(method: string, params?: { versionId?: string }) {
          calls.push(params ? `${method} ${JSON.stringify(params)}` : method);
          if (method === "ServiceWorker.stopAllWorkers" && options.stopAllThrows) {
            throw new Error("Protocol error (ServiceWorker.stopAllWorkers): Internal error");
          }
          if (
            method === "ServiceWorker.stopWorker" &&
            options.stopWorkerHangs?.includes(params?.versionId ?? "")
          ) {
            return new Promise<object>(() => undefined);
          }
          if (method === "ServiceWorker.stopAllWorkers")
            running = new Set(options.afterStopAll ?? []);
          if (method === "ServiceWorker.stopWorker" && options.stopWorkerWorks !== false) {
            running.delete(Number(params?.versionId));
          }
          return {};
        },
      },
      session: {
        serviceWorkers: {
          getAllRunning: () =>
            Object.fromEntries([...running].map((id) => [id, { scope: "https://game.example/" }])),
        },
      },
    }),
  };
  return { window, calls, running: () => [...running] };
}

function deps(answers: Array<boolean | Error> = []) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const calls: string[] = [];
  const confirm = vi.fn(async () => {
    calls.push("confirm");
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer ?? false;
  });
  return {
    log,
    confirm,
    deps: {
      gameId: GAME,
      log,
      dialogs: { confirm },
      stopPlaytime: () => calls.push("stopPlaytime"),
      timing: FAST,
    },
    calls,
  };
}

describe("closeGameWindow: the close procedure of architecture.md section 4 (AC-13)", () => {
  it("runs the four steps in order: hide and stop playtime, unload, stop workers, destroy", async () => {
    const fake = fakeWindow({ workers: [7], afterStopAll: [] });
    const order: string[] = [];
    const setup = deps();
    const outcome = await closeGameWindow(fake.window, {
      ...setup.deps,
      stopPlaytime: () => fake.calls.push("stopPlaytime"),
    });
    order.push(...fake.calls);
    expect(outcome).toBe("closed");
    expect(order).toEqual([
      "hide",
      "stopPlaytime",
      "loadURL about:blank",
      "attach 1.3",
      "ServiceWorker.enable",
      "ServiceWorker.stopAllWorkers",
      "detach",
      "destroy",
    ]);
    expect(fake.running()).toEqual([]);
    expect(setup.log.error).not.toHaveBeenCalled();
  });

  it("stops each remaining version with stopWorker when stopAllWorkers left some running", async () => {
    const fake = fakeWindow({ workers: [3, 9], afterStopAll: [3, 9] });
    const setup = deps();
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(fake.calls).toContain('ServiceWorker.stopWorker {"versionId":"3"}');
    expect(fake.calls).toContain('ServiceWorker.stopWorker {"versionId":"9"}');
    expect(fake.calls.indexOf('ServiceWorker.stopWorker {"versionId":"3"}')).toBeLessThan(
      fake.calls.indexOf("destroy"),
    );
    expect(setup.log.error).not.toHaveBeenCalled();
  });

  it("logs SW_STOP_FAILED when workers survive stopWorker too, and still destroys the window", async () => {
    const fake = fakeWindow({ workers: [3], afterStopAll: [3], stopWorkerWorks: false });
    const setup = deps();
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(setup.log.error).toHaveBeenCalledWith("SW_STOP_FAILED", { gameId: GAME, running: 1 });
    expect(fake.calls.at(-1)).toBe("destroy");
  });

  it("still destroys the window when the debugger cannot attach", async () => {
    const fake = fakeWindow({ attachThrows: true });
    const setup = deps();
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(setup.log.error).toHaveBeenCalledWith(
      "game.close.debugger-failed",
      expect.objectContaining({ gameId: GAME }),
    );
    expect(fake.calls).not.toContain("detach");
    expect(fake.calls.at(-1)).toBe("destroy");
  });

  it("a hanging unload cannot block closing: after the unload timeout it goes on", async () => {
    const fake = fakeWindow({ hang: true });
    const setup = deps();
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(setup.log.warn).toHaveBeenCalledWith("game.close.unload-timeout", {
      gameId: GAME,
      waitedMs: FAST.unloadMs,
    });
    expect(fake.calls.at(-1)).toBe("destroy");
  });
});

describe("closeGameWindow: SW_STOP_FAILED whatever failed on the way (fix round 1)", () => {
  it("tries each stopWorker on its own: the first hangs, the second is still stopped, the rest is reported", async () => {
    const fake = fakeWindow({ workers: [3, 9], afterStopAll: [3, 9], stopWorkerHangs: ["3"] });
    const setup = deps();
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(fake.calls).toContain('ServiceWorker.stopWorker {"versionId":"9"}');
    expect(fake.running()).toEqual([3]);
    expect(setup.log.error).toHaveBeenCalledWith("SW_STOP_FAILED", { gameId: GAME, running: 1 });
    expect(fake.calls.at(-1)).toBe("destroy");
  });

  it("still stops each version when stopAllWorkers fails", async () => {
    const fake = fakeWindow({ workers: [4], afterStopAll: [4], stopAllThrows: true });
    const setup = deps();
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(fake.calls).toContain('ServiceWorker.stopWorker {"versionId":"4"}');
    expect(fake.running()).toEqual([]);
    expect(setup.log.error).not.toHaveBeenCalledWith("SW_STOP_FAILED", expect.anything());
  });

  it("logs SW_STOP_FAILED when the debugger cannot attach and workers keep running", async () => {
    const fake = fakeWindow({ workers: [5], attachThrows: true });
    const setup = deps();
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(setup.log.error).toHaveBeenCalledWith("SW_STOP_FAILED", { gameId: GAME, running: 1 });
    expect(fake.calls.at(-1)).toBe("destroy");
  });

  it("does nothing to a window that is already destroyed", async () => {
    const fake = fakeWindow({ destroyed: true });
    const setup = deps();
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(fake.calls).toEqual([]);
  });
});

describe("closeGameWindow: a beforeunload trap (S-7)", () => {
  it("asks; on Stay the window is shown again and nothing is destroyed", async () => {
    const fake = fakeWindow({ trap: true });
    const setup = deps([false]);
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("stayed");
    expect(setup.confirm).toHaveBeenCalledTimes(1);
    expect(setup.confirm.mock.calls[0]).toEqual([
      expect.objectContaining({ confirmLabel: "Leave", cancelLabel: "Stay" }),
    ]);
    expect(fake.calls).toEqual(["hide", "loadURL about:blank", "unload cancelled", "show"]);
  });

  it("on Leave the unload runs again with the trap ignored and the procedure finishes", async () => {
    const fake = fakeWindow({ trap: true });
    const setup = deps([true]);
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(fake.calls.slice(0, 5)).toEqual([
      "hide",
      "loadURL about:blank",
      "unload cancelled",
      "loadURL about:blank",
      "unload forced",
    ]);
    expect(fake.calls.at(-1)).toBe("destroy");
  });

  it("a dialog that fails counts as Leave, so a trap can never keep the window", async () => {
    const fake = fakeWindow({ trap: true });
    const setup = deps([new Error("no dialog")]);
    expect(await closeGameWindow(fake.window, setup.deps)).toBe("closed");
    expect(fake.calls.at(-1)).toBe("destroy");
  });
});
