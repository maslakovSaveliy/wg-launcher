// How a quiescent job stops: every wait rejects with a `JobStop` that carries the job's failure value, and the
// job's `AbortSignal` is aborted with one, so code after the window (a commit) can tell why it was stopped.
import type { ErrorCode } from "@wg-launcher/shared";

export type Failure = { ok: false; code: ErrorCode; message: string };

export const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });

export class JobStop extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
    this.name = "JobStop";
  }
}

/** The failure an aborted job signal stands for: the watchdog's EXP_TIMEOUT, a cancellation's CANCELLED, ... */
export function failureOf(signal: AbortSignal): Failure {
  const reason: unknown = signal.reason;
  return reason instanceof JobStop ? reason.failure : fail("CANCELLED", "The job was stopped.");
}
