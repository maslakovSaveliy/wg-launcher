// The worker's end of one quiescent frame's port (save-transfer.md section 5, step 10): typed commands with a fresh
// 128-bit nonce each (`crypto.randomBytes`, QW-4), every reply validated with `FrameReply`. Anything unexpected (an
// invalid reply, another nonce, an entry in answer to an inventory) aborts the command and closes the port; a closed
// port fails it; a frame silent for `silenceMs` is `EXP_TIMEOUT` (section 3: a missing reply).
import { randomBytes } from "node:crypto";
import {
  type FrameExportRequest,
  type FrameInventory,
  FrameReply,
  type FrameSummary,
} from "@wg-launcher/exporters/wire";
import { ERROR_CODES, type ErrorCode } from "@wg-launcher/shared";
import type { EntryChunk } from "./collector.js";

/** The parts of a port the client uses (the worker adapts Electron's `MessagePortMain`). */
export interface WorkerPort {
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: () => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

export class FrameCommandError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "FrameCommandError";
    this.code = code;
  }
}

export interface CommandOptions {
  /** A frame that sends nothing for this long fails the command (Assumed: 30 s; the job's watchdog bounds the rest). */
  silenceMs?: number;
}

const SILENCE_MS = 30_000;

type Reply = ReturnType<typeof FrameReply.parse>;

/**
 * Sends `command` with a fresh nonce and feeds every reply to `onReply` until it returns a result (or throws a
 * FrameCommandError). One command at a time per port.
 */
function run<T>(
  port: WorkerPort,
  command: Record<string, unknown>,
  onReply: (reply: Reply) => { done: T } | undefined,
  options: CommandOptions,
): Promise<T> {
  const nonce = randomBytes(16).toString("hex");
  const silenceMs = options.silenceMs ?? SILENCE_MS;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: { value: T } | { error: FrameCommandError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const abort = (code: ErrorCode, message: string) => {
      finish({ error: new FrameCommandError(code, message) });
      port.close();
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort("EXP_TIMEOUT", "the frame did not answer"), silenceMs);
    };
    port.onClose(() =>
      finish({ error: new FrameCommandError("INTERNAL", "the frame closed its port") }),
    );
    port.onMessage((data) => {
      if (settled) return;
      const parsed = FrameReply.safeParse(data);
      if (!parsed.success || parsed.data.nonce !== nonce) {
        abort("INTERNAL", "the frame sent an unexpected message");
        return;
      }
      arm();
      try {
        const result = onReply(parsed.data);
        if (result !== undefined) finish({ value: result.done });
      } catch (error) {
        // A FrameCommandError, or a limit the collector found (a SnapError with its code); anything else is
        // INTERNAL. Never rethrown: this runs in a message listener.
        const code = (error as { code?: unknown } | null)?.code;
        const known = (ERROR_CODES as readonly unknown[]).includes(code);
        abort(
          known ? (code as ErrorCode) : "INTERNAL",
          known && error instanceof Error
            ? error.message
            : "the frame's reply could not be handled",
        );
      }
    });
    arm();
    port.postMessage({ ...command, nonce });
  });
}

const fromError = (reply: Reply) => {
  if (reply.type === "error") throw new FrameCommandError(reply.code, reply.message);
  throw new FrameCommandError("INTERNAL", "the frame sent an unexpected message");
};

export function frameInventory(
  port: WorkerPort,
  options: CommandOptions = {},
): Promise<FrameInventory> {
  return run(
    port,
    { type: "inventory" },
    (reply) => (reply.type === "inventory" ? { done: reply.inventory } : fromError(reply)),
    options,
  );
}

/** Exports one frame; every entry chunk goes to `onChunk` (which may throw a FrameCommandError to stop). */
export function frameExport(
  port: WorkerPort,
  request: FrameExportRequest,
  onChunk: (chunk: EntryChunk) => void,
  options: CommandOptions = {},
): Promise<FrameSummary> {
  const { keyIndex, storageKey, scope } = request;
  return run(
    port,
    { type: "export", keyIndex, storageKey, scope },
    (reply) => {
      if (reply.type === "entry") {
        onChunk(reply);
        return undefined;
      }
      return reply.type === "summary" ? { done: reply.summary } : fromError(reply);
    },
    options,
  );
}
