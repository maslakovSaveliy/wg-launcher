// Fault injection for the restore protocol (save-transfer.md section 6, AC-8; plan Review Focus 2), test flavor only:
// the e2e suite names a point and what happens there. `fail:<point>` makes that step fail as soon as it starts (after
// its journal entry was written); `throw:<point>` throws a plain Error there instead, as an unexpected bug would;
// `slow:<point>:<ms>` makes the step's quiescent window wait that long inside its deadline, as a large save would;
// `crash-after:<point>` lets the step finish and then ends the process at once, as a crash or a power loss would.
// Production passes no hook. Pure apart from the injected `crash`.

/** The steps of a restore or a delete, in order (save-transfer.md section 6, R1 to R8). */
export const RESTORE_STEPS = [
  "validate",
  "plan",
  "lock",
  "backup",
  "wipe",
  "import",
  "verify",
  "commit",
] as const;
export type RestoreStep = (typeof RESTORE_STEPS)[number];

/** The rollback's own steps: wipe the wipe set again, import the backup, verify it. */
export const ROLLBACK_STEPS = ["rollback-wipe", "rollback-import", "rollback-verify"] as const;
export type RollbackStep = (typeof ROLLBACK_STEPS)[number];

export type FaultPoint = RestoreStep | RollbackStep;
export type FaultSpec =
  | `fail:${FaultPoint}`
  | `throw:${FaultPoint}`
  | `crash-after:${FaultPoint}`
  | `slow:${FaultPoint}:${number}`;

/**
 * Called when a step starts, inside its quiescent window (`window`: returns how many milliseconds the window waits),
 * and when it has finished. Throws to fail the step.
 */
export type FaultHook = (point: FaultPoint, when: "start" | "window" | "end") => number | undefined;

export class InjectedFault extends Error {
  constructor(readonly point: FaultPoint) {
    super(`A test fault stopped the ${point} step.`);
    this.name = "InjectedFault";
  }
}

const POINTS: readonly string[] = [...RESTORE_STEPS, ...ROLLBACK_STEPS];

type Mode = "fail" | "throw" | "crash-after" | "slow";
const MODES: readonly string[] = ["fail", "throw", "crash-after", "slow"];

/** Parses a fault spec; anything else is null. */
export function parseFault(spec: string): { mode: Mode; point: FaultPoint; ms: number } | null {
  const [mode, point, ms, ...rest] = spec.split(":");
  if (rest.length > 0 || point === undefined || !POINTS.includes(point)) return null;
  if (mode === undefined || !MODES.includes(mode)) return null;
  if (mode === "slow") {
    const delay = Number(ms);
    return ms !== undefined && /^\d+$/.test(ms) && Number.isSafeInteger(delay)
      ? { mode, point: point as FaultPoint, ms: delay }
      : null;
  }
  return ms === undefined ? { mode: mode as Mode, point: point as FaultPoint, ms: 0 } : null;
}

/** The hook for a list of specs; `crash` ends the process (the test flavor kills it, no clean-up). */
export function faultHook(specs: readonly string[], crash: () => void): FaultHook {
  const faults = specs.flatMap((spec) => {
    const parsed = parseFault(spec);
    if (parsed === null) throw new TypeError(`Unknown fault spec: ${spec}`);
    return [parsed];
  });
  return (point, when) => {
    let delay = 0;
    for (const fault of faults) {
      if (fault.point !== point) continue;
      if (fault.mode === "fail" && when === "start") throw new InjectedFault(point);
      if (fault.mode === "throw" && when === "start") {
        throw new Error(`A test bug in the ${point} step.`);
      }
      if (fault.mode === "slow" && when === "window") delay += fault.ms;
      if (fault.mode === "crash-after" && when === "end") crash();
    }
    return delay;
  };
}
