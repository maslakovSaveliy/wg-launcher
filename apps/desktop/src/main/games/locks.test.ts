import { describe, expect, it, vi } from "vitest";
import { type Lease, LockManager, type LockRefusal } from "./locks.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const OTHER = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c";

const isLease = (value: Lease | LockRefusal): value is Lease => "release" in value;

function manager(releaseTimeoutMs = 2000) {
  const log = { error: vi.fn() };
  return { locks: new LockManager({ log, releaseTimeoutMs }), log };
}

async function lease(locks: LockManager, kind: Lease["kind"], gameId = GAME): Promise<Lease> {
  const result = await locks.acquire(gameId, kind);
  if (!isLease(result)) throw new Error(`expected a lease, got ${result.code}`);
  return result;
}

describe("LockManager: free game", () => {
  it.each(["session", "task", "background"] as const)("grants a %s lease", async (kind) => {
    const { locks } = manager();
    const granted = await lease(locks, kind);
    expect(granted).toMatchObject({ gameId: GAME, kind });
    expect(granted.signal.aborted).toBe(false);
    expect(locks.holder(GAME)).toBe(kind);
  });

  it("is free again after release, and a second release changes nothing", async () => {
    const { locks } = manager();
    const first = await lease(locks, "task");
    first.release();
    expect(locks.holder(GAME)).toBe("none");
    const second = await lease(locks, "session");
    first.release();
    expect(locks.holder(GAME)).toBe("session");
    second.release();
    expect(locks.holder(GAME)).toBe("none");
  });

  it("keeps games apart", async () => {
    const { locks } = manager();
    await lease(locks, "task", GAME);
    expect(isLease(await locks.acquire(OTHER, "session"))).toBe(true);
  });
});

describe("LockManager: the refusal matrix (architecture.md section 4, AC-11)", () => {
  const cases: Array<[Lease["kind"], Lease["kind"], LockRefusal["code"]]> = [
    ["session", "session", "GAME_RUNNING"],
    ["session", "task", "GAME_RUNNING"],
    ["session", "background", "GAME_RUNNING"],
    ["task", "session", "GAME_BUSY"],
    ["task", "task", "GAME_BUSY"],
    ["task", "background", "GAME_BUSY"],
    ["background", "background", "GAME_BUSY"],
  ];
  it.each(cases)("held by %s, a %s request is refused with %s", async (held, kind, code) => {
    const { locks } = manager();
    const holder = await lease(locks, held);
    expect(await locks.acquire(GAME, kind)).toEqual({ code });
    expect(holder.signal.aborted).toBe(false);
    expect(locks.holder(GAME)).toBe(held);
  });

  it.each(["session", "task", "background"] as const)(
    "a game that needs recovery refuses %s with NEEDS_RECOVERY",
    async (kind) => {
      const { locks } = manager();
      locks.markNeedsRecovery(GAME);
      expect(locks.holder(GAME)).toBe("needs_recovery");
      expect(await locks.acquire(GAME, kind)).toEqual({ code: "NEEDS_RECOVERY" });
      locks.clearNeedsRecovery(GAME);
      expect(isLease(await locks.acquire(GAME, kind))).toBe(true);
    },
  );
});

describe("LockManager: a launch or a user task cancels a background lease (M5)", () => {
  it("aborts the background signal with CANCELLED and grants the session once it is released", async () => {
    const { locks, log } = manager();
    const background = await lease(locks, "background");
    background.signal.addEventListener("abort", () => setTimeout(() => background.release(), 5));

    const session = await locks.acquire(GAME, "session");

    expect(background.signal.aborted).toBe(true);
    expect(background.signal.reason).toMatchObject({ code: "CANCELLED" });
    expect(isLease(session) && session.kind).toBe("session");
    expect(locks.holder(GAME)).toBe("session");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("refuses other requests while the session waits for the background release", async () => {
    const { locks } = manager();
    const background = await lease(locks, "background");
    const pending = locks.acquire(GAME, "session");
    expect(await locks.acquire(GAME, "session")).toEqual({ code: "GAME_RUNNING" });
    expect(await locks.acquire(GAME, "task")).toEqual({ code: "GAME_RUNNING" });
    background.release();
    expect(isLease(await pending)).toBe(true);
  });

  it("gives up after the timeout, logs INTERNAL and leaves the background holder in place", async () => {
    vi.useFakeTimers();
    try {
      const { locks, log } = manager(2000);
      const background = await lease(locks, "background");
      const pending = locks.acquire(GAME, "session");
      await vi.advanceTimersByTimeAsync(1999);
      // While it waits, the game counts as held by the launching session.
      expect(locks.holder(GAME)).toBe("session");
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ code: "INTERNAL" });
      expect(log.error).toHaveBeenCalledWith("locks.background-not-released", {
        gameId: GAME,
        code: "INTERNAL",
        waitedMs: 2000,
        for: "session",
      });
      expect(locks.holder(GAME)).toBe("background");
      background.release();
      expect(locks.holder(GAME)).toBe("none");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a user task cancels a background lease the same way and is granted once it is released", async () => {
    const { locks, log } = manager();
    const background = await lease(locks, "background");
    background.signal.addEventListener("abort", () => setTimeout(() => background.release(), 5));
    const pending = locks.acquire(GAME, "task");
    // While the task waits, the game counts as held by it: a launch or another task is refused.
    expect(locks.holder(GAME)).toBe("task");
    expect(await locks.acquire(GAME, "session")).toEqual({ code: "GAME_BUSY" });
    expect(await locks.acquire(GAME, "task")).toEqual({ code: "GAME_BUSY" });
    const task = await pending;
    expect(background.signal.reason).toMatchObject({ code: "CANCELLED" });
    expect(isLease(task) && task.kind).toBe("task");
    expect(locks.holder(GAME)).toBe("task");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("a task whose background lease is not released in time is refused with INTERNAL", async () => {
    vi.useFakeTimers();
    try {
      const { locks, log } = manager(2000);
      await lease(locks, "background");
      const pending = locks.acquire(GAME, "task");
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual({ code: "INTERNAL" });
      expect(log.error).toHaveBeenCalledWith(
        "locks.background-not-released",
        expect.objectContaining({ gameId: GAME, code: "INTERNAL" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a background request never cancels another background lease", async () => {
    const { locks } = manager();
    const background = await lease(locks, "background");
    expect(await locks.acquire(GAME, "background")).toEqual({ code: "GAME_BUSY" });
    expect(background.signal.aborted).toBe(false);
  });
});
