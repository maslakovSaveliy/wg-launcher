// The snapshot worker of one job: started on first use, begun once with the job's limits, and killed when the job
// ends, also when the job is stopped while the worker is still starting (the start promise is kept, so a worker
// that finishes starting late is killed too, never left running).
import type { Limits, SnapshotWorker } from "./client.js";

export interface WorkerSlot {
  /** The job's worker, or null when `signal` is aborted or the slot was disposed (any worker started is killed). */
  get(signal: AbortSignal): Promise<SnapshotWorker | null>;
  /** Kills the worker, once it has started if it is still starting, and waits until it has exited. */
  dispose(): Promise<void>;
}

export function workerSlot(start: () => Promise<SnapshotWorker>, limits: Limits): WorkerSlot {
  let starting: Promise<SnapshotWorker> | null = null;
  let disposed = false;
  return {
    async get(signal) {
      starting ??= start().then((worker) => {
        worker.begin(limits);
        return worker;
      });
      const worker = await starting;
      if (disposed || signal.aborted) {
        await worker.kill();
        return null;
      }
      return worker;
    },
    async dispose() {
      disposed = true;
      if (starting === null) return;
      let worker: SnapshotWorker;
      try {
        worker = await starting;
      } catch {
        // It never started: nothing to kill.
        return;
      }
      await worker.kill();
    },
  };
}
