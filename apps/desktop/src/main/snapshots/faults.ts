// Fault injection for the restore protocol (save-transfer.md section 6, AC-8; plan Review Focus 2), test flavor only:
// the e2e suite names a point and what happens there. `fail:<point>` makes that step fail as soon as it starts (after
// its journal entry was written); `crash-after:<point>` lets the step finish and then ends the process at once, as a
// crash or a power loss would. Production passes no hook. Pure apart from the injected `crash`.

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
export type FaultSpec = `fail:${FaultPoint}` | `crash-after:${FaultPoint}`;

/** Called when a step starts and when it has finished. Throws `InjectedFault` to fail the step. */
export type FaultHook = (point: FaultPoint, when: "start" | "end") => void;

export class InjectedFault extends Error {
  constructor(readonly point: FaultPoint) {
    super(`A test fault stopped the ${point} step.`);
    this.name = "InjectedFault";
  }
}

const POINTS: readonly string[] = [...RESTORE_STEPS, ...ROLLBACK_STEPS];

/** Parses a fault spec; anything else is null (the hook then does nothing). */
export function parseFault(
  spec: string,
): { mode: "fail" | "crash-after"; point: FaultPoint } | null {
  const [mode, point, ...rest] = spec.split(":");
  if (rest.length > 0 || point === undefined || !POINTS.includes(point)) return null;
  if (mode !== "fail" && mode !== "crash-after") return null;
  return { mode, point: point as FaultPoint };
}

/** The hook for a list of specs; `crash` ends the process (the test flavor kills it, no clean-up). */
export function faultHook(specs: readonly string[], crash: () => void): FaultHook {
  const faults = specs.flatMap((spec) => {
    const parsed = parseFault(spec);
    if (parsed === null) throw new TypeError(`Unknown fault spec: ${spec}`);
    return [parsed];
  });
  return (point, when) => {
    for (const fault of faults) {
      if (fault.point !== point) continue;
      if (fault.mode === "fail" && when === "start") throw new InjectedFault(point);
      if (fault.mode === "crash-after" && when === "end") crash();
    }
  };
}
