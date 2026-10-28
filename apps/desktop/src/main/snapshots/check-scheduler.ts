// When the storage check behind the "Local data" badge runs (architecture.md section 11): after a game window exits,
// never while any game window is focused, one check at a time (so background work holds at most one of the two job
// slots, security.md section 8), each game once however often it exited meanwhile. A launch or a user task cancels
// a running check (locks.ts); a check that cannot start (the game launched again, a task holds it) is dropped, and
// the next exit schedules it again.
import type { Logger } from "../log/logger.js";

/**
 * The quiet time after an exit before a check starts (Assumed: 2 s), so a user who opens the game again at once
 * finds no check to cancel and does not wait for one to let go.
 */
export const QUIET_MS = 2000;

export interface StorageCheckScheduler {
  gameExited(gameId: string): void;
  /** Focus moved between windows: a check that waited for a game window to lose focus may run now. */
  focusChanged(): void;
  /** No check starts after this (app quit). */
  stop(): void;
  pending(): string[];
}

export function createStorageCheckScheduler(deps: {
  run(gameId: string): Promise<{ ok: boolean; code?: string }>;
  gameWindowFocused(): boolean;
  log: Pick<Logger, "info" | "error">;
  /** How long after an exit the check may start (default QUIET_MS). */
  delayMs?: number;
}): StorageCheckScheduler {
  const delayMs = deps.delayMs ?? QUIET_MS;
  const waiting = new Set<string>();
  let running = false;
  let stopped = false;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (!stopped && !deps.gameWindowFocused()) {
        const [next] = waiting;
        if (next === undefined) break;
        waiting.delete(next);
        try {
          const result = await deps.run(next);
          if (!result.ok)
            deps.log.info("snapshot.storage-check.skipped", { gameId: next, code: result.code });
        } catch (error) {
          deps.log.error("snapshot.storage-check.failed", { gameId: next, error });
        }
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
      void pump();
    },
    stop() {
      stopped = true;
      waiting.clear();
    },
    pending: () => [...waiting],
  };
}
