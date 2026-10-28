// The main process's handle on one snapshot worker (a `utilityProcess` per job, killed when the job ends, so a job
// never shares memory or state with another). Every event is validated with `WorkerEvent`; a worker that exits or
// sends something unexpected fails every pending request with INTERNAL.
import type { FrameInventory } from "@wg-launcher/exporters/wire";
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { Logger } from "../log/logger.js";
import { type ManifestFields, type WorkerCommand, WorkerEvent } from "./protocol.js";

/** The parts of Electron's `UtilityProcess` the client uses. */
export interface UtilityProcessLike {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: unknown, transfer?: unknown[]): void;
  kill(): boolean;
}

export type ExportCounts = Extract<WorkerEvent, { type: "exported" }>["summary"];
export type Written = Omit<Extract<WorkerEvent, { type: "written" }>, "type" | "requestId">;
export type Limits = Extract<WorkerCommand, { type: "begin" }>["limits"];

export interface WriteOptions {
  manifest: ManifestFields;
  partialPath: string;
  finalPath: string;
  fault?: "fail-write";
}

export interface SnapshotWorker {
  /** Starts the job (one per worker); its entries are held to `limits`. */
  begin(limits: Limits): void;
  inventory(port: unknown): Promise<Result<FrameInventory, ErrorCode>>;
  exportFrame(
    port: unknown,
    op: Omit<Extract<WorkerCommand, { type: "frame" }>["op"] & { op: "export" }, "op">,
  ): Promise<Result<ExportCounts, ErrorCode>>;
  write(options: WriteOptions): Promise<Result<Written, ErrorCode>>;
  /** Entry bytes received so far, as the worker measured them. */
  onReceived(listener: (bytes: number) => void): void;
  kill(): void;
}

const JOB = 1;
const READY_MS = 10_000;

/** Forks the worker and resolves once it is ready. */
export async function startSnapshotWorker(deps: {
  fork(): UtilityProcessLike;
  log: Pick<Logger, "error" | "warn">;
}): Promise<SnapshotWorker> {
  const child = deps.fork();
  const pending = new Map<number, (event: WorkerEvent) => void>();
  const received: Array<(bytes: number) => void> = [];
  let nextId = 1;
  let gone: string | null = null;
  const ready = Promise.withResolvers<void>();

  const failAll = (why: string) => {
    if (gone !== null) return;
    gone = why;
    ready.reject(new Error(why));
    for (const resolve of pending.values()) {
      resolve({
        type: "failed",
        requestId: 1,
        code: "INTERNAL",
        message: "The snapshot worker stopped.",
      });
    }
    pending.clear();
  };
  child.on("exit", (code) => {
    if (gone === null) deps.log.warn("snapshot.worker-exit", { code });
    failAll("exit");
  });
  child.on("message", (message) => {
    const parsed = WorkerEvent.safeParse(message);
    if (!parsed.success) {
      deps.log.error("snapshot.worker-invalid-event", {});
      failAll("invalid event");
      child.kill();
      return;
    }
    const event = parsed.data;
    if (event.type === "ready") ready.resolve();
    else if (event.type === "received") for (const listener of received) listener(event.bytes);
    else {
      const resolve = pending.get(event.requestId);
      pending.delete(event.requestId);
      resolve?.(event);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the snapshot worker did not start")), READY_MS);
      }),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const request = (command: Record<string, unknown>, transfer: unknown[] = []) =>
    new Promise<WorkerEvent>((resolve) => {
      const requestId = nextId++;
      if (gone !== null) {
        resolve({
          type: "failed",
          requestId,
          code: "INTERNAL",
          message: "The snapshot worker stopped.",
        });
        return;
      }
      pending.set(requestId, resolve);
      child.postMessage({ ...command, jobId: JOB, requestId }, transfer);
    });
  const failed = (event: WorkerEvent): Result<never, ErrorCode> =>
    event.type === "failed"
      ? { ok: false, code: event.code, message: event.message }
      : { ok: false, code: "INTERNAL", message: "The snapshot worker answered out of turn." };

  return {
    begin(limits) {
      child.postMessage({ type: "begin", jobId: JOB, limits });
    },
    async inventory(port) {
      const event = await request({ type: "frame", op: { op: "inventory" } }, [port]);
      return event.type === "inventory" ? { ok: true, data: event.inventory } : failed(event);
    },
    async exportFrame(port, op) {
      const event = await request({ type: "frame", op: { op: "export", ...op } }, [port]);
      return event.type === "exported" ? { ok: true, data: event.summary } : failed(event);
    },
    async write(options) {
      const event = await request({ type: "write", ...options });
      if (event.type !== "written") return failed(event);
      const { type: _type, requestId: _id, ...written } = event;
      return { ok: true, data: written };
    },
    onReceived(listener) {
      received.push(listener);
    },
    kill() {
      gone ??= "killed";
      child.kill();
    },
  };
}
