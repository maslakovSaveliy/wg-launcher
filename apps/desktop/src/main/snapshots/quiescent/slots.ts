// The process-wide cap on snapshot jobs running at once (security.md section 8).

/** How long a user task waits for a cancelled background job to give its slot back (as locks.ts waits: 2 s). */
export const SLOT_RELEASE_TIMEOUT_MS = 2000;

export type SlotTake =
  | { ok: true; give: () => void }
  /** `GAME_BUSY`: every slot is held by a job the user asked for; `INTERNAL`: a background job did not let go. */
  | { ok: false; code: "GAME_BUSY" | "INTERNAL" };

interface Holder {
  kind: "task" | "background";
  cancel(): void;
  /** Set while a user task waits for this background job's slot: its `give` hands the slot over. */
  handOver: (() => void) | null;
}

/**
 * At most `limit` snapshot jobs run at once in the process (security.md section 8: two); a job takes a slot after
 * its lease and gives it back before the lease. Background work never blocks a user action (architecture.md
 * section 4): when every slot is taken, a user task (`task`) cancels a background job and takes its slot once that
 * job gives it back, waiting at most `releaseTimeoutMs` (then `INTERNAL`, the job may still be running). A
 * background job never takes another job's slot.
 */
export class JobSlots {
  readonly #holders = new Set<Holder>();
  /** Slots handed over by a background job to a waiting task, not yet taken by it. */
  #handedOver = 0;

  constructor(
    readonly limit: number,
    readonly releaseTimeoutMs = SLOT_RELEASE_TIMEOUT_MS,
  ) {}

  get running(): number {
    return this.#holders.size + this.#handedOver;
  }

  /** Takes a slot for a job of `kind`; `cancel` stops that job when a user task needs its slot. */
  async take(kind: "task" | "background", cancel: () => void): Promise<SlotTake> {
    if (this.running < this.limit) return this.#grant(kind, cancel);
    if (kind !== "task") return { ok: false, code: "GAME_BUSY" };
    const victim = [...this.#holders].find(
      (holder) => holder.kind === "background" && holder.handOver === null,
    );
    if (!victim) return { ok: false, code: "GAME_BUSY" };
    const handed = Promise.withResolvers<void>();
    let wasHanded = false;
    victim.handOver = () => {
      wasHanded = true;
      handed.resolve();
    };
    victim.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      handed.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.releaseTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!wasHanded) {
      // The job keeps its slot and gives it back as usual when it ends.
      victim.handOver = null;
      return { ok: false, code: "INTERNAL" };
    }
    this.#handedOver -= 1;
    return this.#grant(kind, cancel);
  }

  #grant(kind: "task" | "background", cancel: () => void): SlotTake {
    const holder: Holder = { kind, cancel, handOver: null };
    this.#holders.add(holder);
    let given = false;
    const give = () => {
      if (given) return;
      given = true;
      this.#holders.delete(holder);
      if (holder.handOver !== null) {
        // Reserved for the waiting task, so no other job takes it in between.
        this.#handedOver += 1;
        holder.handOver();
      }
    };
    return { ok: true, give };
  }
}

export const SNAPSHOT_JOB_SLOTS = new JobSlots(2);
