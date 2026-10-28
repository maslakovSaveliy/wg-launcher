// What the snapshot worker does with each command of the main process (protocol.ts), without Electron: the entry
// (snapshot-worker.ts) adapts `process.parentPort` and `MessagePortMain` to this. Per job it keeps one EntryCollector;
// a frame command runs over the port that came with it and the port is closed afterwards; `write` turns the job's
// entries into the file (write.ts) and forgets them, whatever the outcome. The worker never opens the database: it
// reports to main (architecture.md section 1).

import { ERROR_CODES, type ErrorCode } from "@wg-launcher/shared";
import { type Limits, resolveLimits } from "@wg-launcher/snapshot/container";
import { EntryCollector } from "./collector.js";
import { FrameCommandError, frameExport, frameInventory, type WorkerPort } from "./frame-client.js";
import { WorkerCommand, type WorkerEvent } from "./protocol.js";
import { writeVerified } from "./write.js";

export interface WorkerCoreOptions {
  post(event: WorkerEvent): void;
  /** True only in the test flavor: the `fail-write` fault is honored. */
  allowFaults: boolean;
  /** Passed on to every frame command (tests shorten it). */
  silenceMs?: number;
}

/** A `received` event is sent each time the job's bytes pass another multiple of this (and after each frame). */
const PROGRESS_STEP_BYTES = 1024 * 1024;

const MAX_MESSAGE = 512;

function failure(error: unknown): { code: ErrorCode; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  if ((ERROR_CODES as readonly unknown[]).includes(code) && error instanceof Error) {
    return { code: code as ErrorCode, message: error.message.slice(0, MAX_MESSAGE) };
  }
  if (error instanceof FrameCommandError) return { code: error.code, message: error.message };
  return { code: "INTERNAL", message: "The snapshot worker failed." };
}

/** The overrides that are set (zod's partial object may hold `undefined` members). */
function defined(limits: Record<string, number | undefined>): Partial<Limits> {
  return Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined));
}

export function createWorkerCore(options: WorkerCoreOptions) {
  const { post } = options;
  const jobs = new Map<number, { collector: EntryCollector; reported: number }>();
  const commandOptions = options.silenceMs === undefined ? {} : { silenceMs: options.silenceMs };

  const report = (jobId: number, force = false) => {
    const job = jobs.get(jobId);
    if (!job) return;
    const bytes = job.collector.received;
    if (force ? bytes !== job.reported : bytes - job.reported >= PROGRESS_STEP_BYTES) {
      job.reported = bytes;
      post({ type: "received", jobId, bytes });
    }
  };

  return {
    /** Handles one message of the main process; `ports` are the ports that came with it. */
    async handle(data: unknown, ports: readonly WorkerPort[]): Promise<void> {
      const parsed = WorkerCommand.safeParse(data);
      if (!parsed.success) {
        for (const port of ports) port.close();
        throw new TypeError("The snapshot worker got a message it does not know.");
      }
      const command = parsed.data;
      switch (command.type) {
        case "begin":
          jobs.set(command.jobId, {
            collector: new EntryCollector(resolveLimits(defined(command.limits))),
            reported: 0,
          });
          return;
        case "frame": {
          const { requestId, jobId, op } = command;
          const port = ports[0];
          const job = jobs.get(jobId);
          if (port === undefined || ports.length !== 1 || job === undefined) {
            for (const extra of ports) extra.close();
            post({ type: "failed", requestId, code: "INTERNAL", message: "No frame port or job." });
            return;
          }
          try {
            if (op.op === "inventory") {
              const inventory = await frameInventory(port, commandOptions);
              post({ type: "inventory", requestId, inventory });
            } else {
              const keyFiles = job.collector.forKey(op.keyIndex);
              const summary = await frameExport(
                port,
                { keyIndex: op.keyIndex, storageKey: op.storageKey, scope: op.scope },
                (chunk) => {
                  keyFiles.add(chunk);
                  report(jobId);
                },
                commandOptions,
              );
              keyFiles.finish();
              report(jobId, true);
              post({
                type: "exported",
                requestId,
                summary: {
                  localStorageItems: summary.localStorageItems,
                  databases: summary.databases.length,
                  records: summary.databases.reduce((n, db) => n + db.records, 0),
                  blobs: summary.blobs,
                  notExported: summary.notExported,
                },
              });
            }
          } catch (error) {
            post({ type: "failed", requestId, ...failure(error) });
          } finally {
            port.close();
          }
          return;
        }
        case "write": {
          const { requestId, jobId } = command;
          const job = jobs.get(jobId);
          jobs.delete(jobId);
          if (job === undefined) {
            post({ type: "failed", requestId, code: "INTERNAL", message: "No such job." });
            return;
          }
          try {
            const written = await writeVerified({
              manifest: command.manifest,
              files: job.collector.files(),
              partialPath: command.partialPath,
              finalPath: command.finalPath,
              limits: job.collector.limits,
              ...(options.allowFaults && command.fault ? { fault: command.fault } : {}),
            });
            post({ type: "written", requestId, ...written });
          } catch (error) {
            post({ type: "failed", requestId, ...failure(error) });
          }
          return;
        }
      }
    },
  };
}
