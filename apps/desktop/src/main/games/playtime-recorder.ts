// Playtime recording (architecture.md section 10, PRD section 8, F-9). The rule itself is the pure machine of
// `policy/playtime.ts`; this module feeds it a game window's events and the `powerMonitor` events, and writes
// `play_sessions`. A session is one window lifetime: it starts when the window is created (which also sets
// `last_launched_at`), is checkpointed every 60 s, and at the window's `closed` is ended, or deleted when it has less
// than 10 000 ms of active time. Sessions a crash left unfinished are settled at start-up by the same rule.
// Electron is not imported: the caller forwards `powerMonitor` events and passes a monotonic clock.

import type { Logger } from "../log/logger.js";
import { createPlaytime, keepSession, type PlaytimeEvent } from "../policy/playtime.js";

export const CHECKPOINT_MS = 60_000;

const WINDOW_EVENTS = ["show", "hide", "focus", "blur", "minimize", "restore"] as const;
export type PowerEvent = "suspend" | "resume" | "lock-screen" | "unlock-screen";

/** The part of the play-sessions repository used here. */
export interface SessionStore {
  start(gameId: string): { id: number };
  checkpoint(id: number, activeMs: number): void;
  end(id: number, activeMs: number): void;
  delete(id: number): void;
}

export interface PlaytimeWindow {
  on(event: string, listener: () => void): unknown;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
}

export interface PlaytimeHubDeps {
  sessions: SessionStore;
  games: { markLaunched(gameId: string): void };
  /** A monotonic clock in milliseconds (`performance.now`). */
  clock(): number;
  log: Pick<Logger, "info" | "error">;
  /** Whether the screen is locked right now (macOS and Windows; `powerMonitor.getSystemIdleState`). */
  isScreenLocked(): boolean;
}

export interface PlaytimeRecorder {
  /** Step 1 of the close procedure: stop counting. A window shown again ("Stay") counts again. */
  pause(): void;
}

/**
 * One hub per app: `attach` starts a game window's session, `power` forwards a `powerMonitor` event to every open
 * session. Database failures are logged, never thrown into a window event.
 */
export function createPlaytimeHub(deps: PlaytimeHubDeps) {
  const { sessions, clock, log } = deps;
  const live = new Set<(event: PlaytimeEvent) => void>();
  let suspended = false;
  let locked = false;

  const write = (gameId: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      log.error("game.playtime-write-failed", { gameId, error });
    }
  };

  return {
    attach(gameId: string, window: PlaytimeWindow): PlaytimeRecorder {
      write(gameId, () => deps.games.markLaunched(gameId));
      let session: { id: number } | null = null;
      write(gameId, () => {
        session = sessions.start(gameId);
      });
      const machine = createPlaytime(clock());
      const on = (event: PlaytimeEvent) => machine.on(event, clock());
      // The machine starts knowing nothing: replay what is already true.
      // Asked at every launch, so a missed lock event cannot stick (Linux emits none).
      locked = deps.isScreenLocked();
      if (suspended) on("suspend");
      if (locked) on("lock-screen");
      if (window.isVisible()) on("show");
      if (window.isFocused()) on("focus");
      if (window.isMinimized()) on("minimize");
      for (const event of WINDOW_EVENTS) window.on(event, () => on(event));
      live.add(on);

      const timer = setInterval(() => {
        const id = session?.id;
        if (id !== undefined)
          write(gameId, () => sessions.checkpoint(id, machine.activeMs(clock())));
      }, CHECKPOINT_MS);
      window.on("closed", () => {
        on("closed");
        live.delete(on);
        clearInterval(timer);
        const id = session?.id;
        if (id === undefined) return;
        const activeMs = machine.activeMs(clock());
        const kept = keepSession(activeMs);
        write(gameId, () => (kept ? sessions.end(id, activeMs) : sessions.delete(id)));
        log.info("game.playtime", { gameId, activeMs, kept });
      });
      return { pause: () => on("hide") };
    },
    power(event: PowerEvent): void {
      if (event === "suspend" || event === "resume") suspended = event === "suspend";
      else locked = event === "lock-screen";
      for (const on of live) on(event);
    },
  };
}

/** Start-up: unfinished sessions under 10 000 ms are deleted, the others end at their last checkpoint. */
export function settleUnfinishedSessions(
  sessions: {
    listUnfinished(): Array<{ id: number; activeMs: number }>;
    endAtCheckpoint(id: number): void;
    delete(id: number): void;
  },
  log: Pick<Logger, "info">,
): void {
  let deleted = 0;
  let ended = 0;
  for (const session of sessions.listUnfinished()) {
    if (keepSession(session.activeMs)) {
      sessions.endAtCheckpoint(session.id);
      ended += 1;
    } else {
      sessions.delete(session.id);
      deleted += 1;
    }
  }
  if (deleted + ended > 0) log.info("playtime.settled", { deleted, ended });
}
