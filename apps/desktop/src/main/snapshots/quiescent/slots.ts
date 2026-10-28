// The process-wide cap on snapshot jobs running at once (security.md section 8).

/**
 * At most `limit` snapshot jobs run at once in the process (security.md section 8: two); a job takes a slot after
 * its lease and gives it back before the lease.
 */
export class JobSlots {
  #running = 0;
  constructor(readonly limit: number) {}
  get running(): number {
    return this.#running;
  }
  /** Takes a slot; returns the function that gives it back once, or null when all are taken. */
  take(): (() => void) | null {
    if (this.#running >= this.limit) return null;
    this.#running += 1;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.#running -= 1;
    };
  }
}

export const SNAPSHOT_JOB_SLOTS = new JobSlots(2);
