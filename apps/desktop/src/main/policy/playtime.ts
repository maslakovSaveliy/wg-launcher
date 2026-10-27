// Playtime rule (PRD section 8, architecture.md section 10) as a pure state machine. It knows
// nothing of Electron: a later task feeds it window and powerMonitor events with a monotonic
// clock reading (for example `performance.now()`), and reads the active time at close.

export type PlaytimeEvent =
  | "show"
  | "hide"
  | "focus"
  | "blur"
  | "minimize"
  | "restore"
  | "closed"
  | "suspend"
  | "resume"
  | "lock-screen"
  | "unlock-screen";

/** A session with less active time than this is dropped, not recorded (PRD section 8). */
export const MIN_SESSION_MS = 10_000;

/** True when a session's active time is long enough to be recorded: 10 000 ms or more. */
export function keepSession(activeMs: number): boolean {
  return activeMs >= MIN_SESSION_MS;
}

export interface Playtime {
  /** Applies an event at the clock reading `nowMs`. Events after `closed` are ignored. */
  on(event: PlaytimeEvent, nowMs: number): void;
  /** Active milliseconds so far; frozen once `closed` was seen. Never changes the machine. */
  activeMs(nowMs: number): number;
}

/**
 * Time accrues only while the window is visible, focused, not minimized, not suspended and not
 * locked. A new machine starts with none of "visible" and "focused" known, so it accrues nothing
 * until it has seen both `show` and `focus`; the caller replays the window's real state as
 * events if the window was already up. Every event is idempotent.
 *
 * A clock that goes backwards counts as zero elapsed time: the reading is never negative, and
 * after an event the machine continues from the new, lower reading.
 */
export function createPlaytime(nowMs: number): Playtime {
  let visible = false;
  let focused = false;
  let minimized = false;
  let suspended = false;
  let locked = false;
  let closed = false;
  let total = 0;
  let lastTick = nowMs;

  const accruing = () => visible && focused && !minimized && !suspended && !locked;
  const elapsedAt = (now: number) => (accruing() ? Math.max(0, now - lastTick) : 0);

  return {
    on(event, now) {
      if (closed) return;
      total += elapsedAt(now);
      lastTick = now;
      switch (event) {
        case "show":
          visible = true;
          break;
        case "hide":
          visible = false;
          break;
        case "focus":
          focused = true;
          break;
        case "blur":
          focused = false;
          break;
        case "minimize":
          minimized = true;
          break;
        case "restore":
          minimized = false;
          break;
        case "suspend":
          suspended = true;
          break;
        case "resume":
          suspended = false;
          break;
        case "lock-screen":
          locked = true;
          break;
        case "unlock-screen":
          locked = false;
          break;
        case "closed":
          closed = true;
          break;
      }
    },
    activeMs(now) {
      return closed ? total : total + elapsedAt(now);
    },
  };
}
