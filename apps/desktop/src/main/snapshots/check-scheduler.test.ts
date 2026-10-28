import { describe, expect, it, vi } from "vitest";
import { createStorageCheckScheduler, QUIET_MS } from "./check-scheduler.js";

const A = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7a";
const B = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const ok = { ok: true as const, data: undefined };

function setUp(focused = false) {
  let gameFocused = focused;
  const gates: Array<() => void> = [];
  const run = vi.fn(
    (_gameId: string) => new Promise<typeof ok>((resolve) => gates.push(() => resolve(ok))),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const scheduler = createStorageCheckScheduler({
    run,
    gameWindowFocused: () => gameFocused,
    log,
    delayMs: 0,
  });
  return {
    scheduler,
    run,
    gates,
    focus: (value: boolean) => {
      gameFocused = value;
    },
  };
}

describe("the storage check after a game exits (architecture.md section 11)", () => {
  it("checks a game after its window exits, one check at a time", async () => {
    const { scheduler, run, gates } = setUp();
    scheduler.gameExited(A);
    scheduler.gameExited(B);
    // Not in the turn that reports the exit: the runtime releases the game's lease right after reporting it.
    expect(run).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenLastCalledWith(A);
    gates.shift()?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith(B);
    gates.shift()?.();
    await vi.waitFor(() => expect(scheduler.pending()).toEqual([]));
  });

  it("waits while a game window is focused and runs when focus changes", async () => {
    const { scheduler, run, gates, focus } = setUp(true);
    scheduler.gameExited(A);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.pending()).toEqual([A]);
    scheduler.focusChanged();
    expect(run).not.toHaveBeenCalled();
    focus(false);
    scheduler.focusChanged();
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(A));
    gates.shift()?.();
  });

  it("checks a game once for several exits while it waits, and nothing after stop", async () => {
    const { scheduler, run, focus } = setUp(true);
    scheduler.gameExited(A);
    scheduler.gameExited(A);
    scheduler.stop();
    focus(false);
    scheduler.focusChanged();
    scheduler.gameExited(B);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).not.toHaveBeenCalled();
  });

  it("goes on after a check that fails or throws", async () => {
    const { scheduler, run } = setUp();
    run.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(ok);
    scheduler.gameExited(A);
    scheduler.gameExited(B);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });
});

describe("the quiet time after an exit", () => {
  it("starts a check only QUIET_MS after the exit", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => ({ ok: true }));
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
      const scheduler = createStorageCheckScheduler({ run, gameWindowFocused: () => false, log });
      scheduler.gameExited(A);
      await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledWith(A);
    } finally {
      vi.useRealTimers();
    }
  });
});
