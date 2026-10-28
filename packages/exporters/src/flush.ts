// The flush-state decision of save-transfer.md section 7 (AC-12): one pure function over what the launcher observed.

/** The hook run as the launcher saw it; times are milliseconds on one monotonic clock. */
export type HookRun =
  | { kind: "not-run" }
  | { kind: "returned"; value: unknown; startedAt: number; finishedAt: number }
  | { kind: "threw"; startedAt: number; finishedAt: number }
  | { kind: "timed-out"; startedAt: number };

export interface FlushObservation {
  /** The hook the adapter declares; `none` when no adapter applies or it has no hook. */
  hook: "none" | "emscripten-idbfs";
  /** The adapter's `timeoutMs`. */
  timeoutMs: number;
  /** The export was requested through "Flush, close and export". */
  viaFlushFlow: boolean;
  run: HookRun;
  /** Times at which user input reached the game window. */
  inputAt: readonly number[];
  /** When the launcher itself closed the game window after the hook; `null` if it did not. */
  closedByLauncherAt: number | null;
}

/** The launcher must close the window within this many milliseconds after the hook finished. */
export const PROMPT_CLOSE_MS = 2000;

/**
 * `confirmed` if and only if an adapter declares a hook, the export came through the flush flow, the hook returned
 * exactly `true` before its timeout, no input reached the game from the hook's start to the close, and the launcher
 * closed the window itself within 2 s after the hook finished. Anything else, unknown times included, is
 * `unconfirmed`.
 */
export function decideFlushState(o: FlushObservation): "confirmed" | "unconfirmed" {
  const { run, closedByLauncherAt: closedAt } = o;
  if (o.hook === "none" || !o.viaFlushFlow || run.kind !== "returned" || run.value !== true) {
    return "unconfirmed";
  }
  const times = [run.startedAt, run.finishedAt, o.timeoutMs, closedAt, ...o.inputAt];
  if (closedAt === null || !times.every((t) => typeof t === "number" && Number.isFinite(t))) {
    return "unconfirmed";
  }
  const inTime = run.finishedAt >= run.startedAt && run.finishedAt - run.startedAt <= o.timeoutMs;
  const promptClose = closedAt >= run.finishedAt && closedAt - run.finishedAt <= PROMPT_CLOSE_MS;
  const quiet = o.inputAt.every((t) => t < run.startedAt || t > closedAt);
  return inTime && promptClose && quiet ? "confirmed" : "unconfirmed";
}
