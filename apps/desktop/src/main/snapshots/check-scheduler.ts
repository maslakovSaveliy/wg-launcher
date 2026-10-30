// When the storage check behind the "Local data" badge runs (architecture.md section 11): after a game window exits,
// never while any game window is focused, one check at a time (so background work holds at most one of the two job
// slots, security.md section 8), each game once however often it exited meanwhile. A launch or a user task cancels
// a running check (locks.ts, slots.ts); a check that cannot start (the game launched again, a task holds it) is
// dropped, and the next exit schedules it again. A running check is also cancelled when a game window takes focus
// (that game is checked again once no game window is focused) and when the app starts quitting; a check only
// reads, so cancelling it is safe.
import type { Logger } from "../log/logger.js";

/**
 * The quiet time after an exit before a check starts (Assumed: 2 s), so a user who opens the game again at once
 * finds no check to cancel and does not wait for one to let go.
 */
export const QUIET_MS = 2000;

export interface StorageCheckScheduler {
  gameExited(gameId: string): void;
  /**
   * Focus moved between windows: a check that waited for a game window to lose focus may run now, and a running
   * check is cancelled when a game window has taken focus.
   */
  focusChanged(): void;
  /** App quit: cancels a running check; no check starts after this. */
  stop(): void;
  pending(): string[];
}

export function createStorageCheckScheduler(deps: {
  /** Runs one check; aborting `signal` cancels it (the job then returns CANCELLED and records nothing). */
  run(gameId: string, signal: AbortSignal): Promise<{ ok: boolean; code?: string }>;
  gameWindowFocused(): boolean;
  log: Pick<Logger, "info" | "error">;
  /** How long after an exit the check may start (default QUIET_MS). */
  delayMs?: number;
}): StorageCheckScheduler {
  const delayMs = deps.delayMs ?? QUIET_MS;
  const waiting = new Set<string>();
  let running = false;
  let stopped = false;
  /** The running check's game and its cancel switch; `byFocus` once a game window's focus cancelled it. */
  let current: { gameId: string; controller: AbortController; byFocus: boolean } | null = null;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (!stopped && !deps.gameWindowFocused()) {
        const [next] = waiting;
        if (next === undefined) break;
        waiting.delete(next);
        const check = { gameId: next, controller: new AbortController(), byFocus: false };
        current = check;
        try {
          const result = await deps.run(next, check.controller.signal);
          if (!result.ok)
            deps.log.info("snapshot.storage-check.skipped", { gameId: next, code: result.code });
        } catch (error) {
          deps.log.error("snapshot.storage-check.failed", { gameId: next, error });
        } finally {
          current = null;
        }
        // Cancelled for a focused game window: that game waits again, like a check not yet started.
        if (check.byFocus && !stopped) waiting.add(next);
      }
    } finally {
      running = false;
    }
  };
  return {
    gameExited(gameId) {
      if (stopped) return;
      waiting.add(gameId);
      // Later, never in the reporting turn: the game runtime reports the exit before it releases the session lease.
      setTimeout(() => void pump(), delayMs);
    },
    focusChanged() {
      if (current !== null && !current.byFocus && deps.gameWindowFocused()) {
        current.byFocus = true;
        deps.log.info("snapshot.storage-check.cancelled", { gameId: current.gameId, for: "focus" });
        current.controller.abort();
      }
      void pump();
    },
    stop() {
      stopped = true;
      waiting.clear();
      if (current !== null) {
        deps.log.info("snapshot.storage-check.cancelled", { gameId: current.gameId, for: "quit" });
        current.controller.abort();
      }
    },
    pending: () => [...waiting],
  };
}
