// The per-game lock of architecture.md section 4 (AC-11) and the plan's ruling M5. Pure: no Electron import.
//
// A game holds at most one lease: `session` (its window is anywhere between launching and closed), `task` (export,
// import, delete local saves, clear cache: something the user asked for) or `background` (a storage check or
// another job the user did not ask for). `needs_recovery` refuses everything until recovery clears it.
//
// | Held by        | session request          | task request  | background request |
// | -------------- | ------------------------ | ------------- | ------------------ |
// | none           | granted                  | granted       | granted            |
// | session        | GAME_RUNNING             | GAME_RUNNING  | GAME_RUNNING       |
// | task           | GAME_BUSY                | GAME_BUSY     | GAME_BUSY          |
// | background     | cancels it, then granted | GAME_BUSY     | GAME_BUSY          |
// | needs_recovery | NEEDS_RECOVERY           | NEEDS_RECOVERY| NEEDS_RECOVERY     |
//
// M5: a session request aborts the background lease's `AbortSignal` (reason code `CANCELLED`) and waits for the
// job to release it, at most `releaseTimeoutMs` (2 s). If the job does not let go in time the launch is refused
// with `INTERNAL` and logged, because opening the game while a job may still touch its storage would break the
// quiescence the job relies on (Assumed: the plan says "INTERNAL logged" without naming the launch's outcome).
// While a session request waits, the game counts as held by that session. A task request never cancels a
// background lease (Assumed).

import type { Logger } from "../log/logger.js";

export type LockKind = "session" | "task" | "background";
export type LockHolder = LockKind | "needs_recovery" | "none";

export interface LockRefusal {
  code: "GAME_RUNNING" | "GAME_BUSY" | "NEEDS_RECOVERY" | "INTERNAL";
}

export interface Lease {
  readonly gameId: string;
  readonly kind: LockKind;
  /** Aborted (reason code `CANCELLED`) when a launch wants the game back; only background leases are aborted. */
  readonly signal: AbortSignal;
  /** Gives the game back. Idempotent; releasing a lease that is no longer the holder changes nothing. */
  release(): void;
}

/** The reason a background lease's signal is aborted with. */
export class CancelledByLaunch extends Error {
  readonly code = "CANCELLED";
  constructor() {
    super("Cancelled because the game is being launched.");
    this.name = "CancelledByLaunch";
  }
}

interface Held {
  lease: Lease;
  controller: AbortController;
  released: Promise<void>;
}

export interface LockManagerOptions {
  log: Pick<Logger, "error">;
  /** How long a launch waits for a cancelled background lease to be released (M5: 2 s). */
  releaseTimeoutMs?: number;
}

export class LockManager {
  readonly #held = new Map<string, Held>();
  /** Games whose session request waits for a background lease to go. */
  readonly #pendingSessions = new Set<string>();
  readonly #recovery = new Set<string>();
  readonly #log: Pick<Logger, "error">;
  readonly #releaseTimeoutMs: number;

  constructor(options: LockManagerOptions) {
    this.#log = options.log;
    this.#releaseTimeoutMs = options.releaseTimeoutMs ?? 2000;
  }

  holder(gameId: string): LockHolder {
    if (this.#recovery.has(gameId)) return "needs_recovery";
    if (this.#pendingSessions.has(gameId)) return "session";
    return this.#held.get(gameId)?.lease.kind ?? "none";
  }

  markNeedsRecovery(gameId: string): void {
    this.#recovery.add(gameId);
  }

  clearNeedsRecovery(gameId: string): void {
    this.#recovery.delete(gameId);
  }

  async acquire(gameId: string, kind: LockKind): Promise<Lease | LockRefusal> {
    const holder = this.holder(gameId);
    if (holder === "needs_recovery") return { code: "NEEDS_RECOVERY" };
    if (holder === "none") return this.#grant(gameId, kind);
    if (holder === "session") return { code: "GAME_RUNNING" };
    if (holder === "task" || kind !== "session") return { code: "GAME_BUSY" };

    // A session request against a background lease (M5).
    const held = this.#held.get(gameId);
    if (!held) return this.#grant(gameId, kind);
    this.#pendingSessions.add(gameId);
    try {
      held.controller.abort(new CancelledByLaunch());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.#releaseTimeoutMs);
      });
      const outcome = await Promise.race([held.released.then(() => "released" as const), timedOut]);
      clearTimeout(timer);
      if (outcome === "timeout") {
        this.#log.error("locks.background-not-released", {
          gameId,
          code: "INTERNAL",
          waitedMs: this.#releaseTimeoutMs,
        });
        return { code: "INTERNAL" };
      }
    } finally {
      this.#pendingSessions.delete(gameId);
    }
    if (this.#recovery.has(gameId)) return { code: "NEEDS_RECOVERY" };
    return this.#grant(gameId, kind);
  }

  #grant(gameId: string, kind: LockKind): Lease {
    const controller = new AbortController();
    const released = Promise.withResolvers<void>();
    const lease: Lease = {
      gameId,
      kind,
      signal: controller.signal,
      release: () => {
        if (this.#held.get(gameId)?.lease === lease) this.#held.delete(gameId);
        released.resolve();
      },
    };
    this.#held.set(gameId, { lease, controller, released: released.promise });
    return lease;
  }
}
