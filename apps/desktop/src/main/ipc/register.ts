// Registers one `ipcMain.handle` per channel of the contract (architecture.md section 6). Every call goes through the
// same steps before its handler runs: the sender check, exactly one payload, the 64 KiB limit on its JSON form, and
// the channel's strict zod schema. A refused sender gets no detail and is logged once per call as
// `IPC_FORBIDDEN_SENDER`; an invalid payload is `INVALID_ARGUMENT`; a throwing handler is `INTERNAL`. Messages are
// short English with no paths, values or zod output.

import {
  IPC_CHANNELS,
  IPC_CONTRACT,
  type IpcChannel,
  type IpcParsedRequest,
  type IpcResult,
  MAX_IPC_PAYLOAD_BYTES,
} from "@wg-launcher/shared";
import type { Logger } from "../log/logger.js";
import { checkSender, type IpcEventLike, type LauncherContents } from "./sender-check.js";

export type Handlers = {
  [C in IpcChannel]: (request: IpcParsedRequest<C>) => Promise<IpcResult<C>>;
};

/** The part of `ipcMain` used here. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
}

export interface RegisterOptions {
  ipc: IpcMainLike;
  /** The launcher window's `webContents`, or null when there is none (every call is then refused). */
  launcher: () => LauncherContents | null;
  handlers: Handlers;
  log: Pick<Logger, "warn" | "error">;
  /** The launcher page's origin: `app://launcher`, or the dev server's origin in the dev flavor. */
  origin: string;
}

const REFUSED = { ok: false, code: "INVALID_ARGUMENT", message: "Refused." } as const;
const INVALID = {
  ok: false,
  code: "INVALID_ARGUMENT",
  message: "The request is not valid.",
} as const;
const FAILED = { ok: false, code: "INTERNAL", message: "Something went wrong." } as const;

/** UTF-8 length of the payload's JSON form, or null when it has none (undefined, BigInt, a function). */
function jsonBytes(payload: unknown): number | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return null;
  }
  return json === undefined ? null : new TextEncoder().encode(json).byteLength;
}

export function registerIpc(options: RegisterOptions): void {
  const { ipc, handlers, log } = options;
  for (const channel of IPC_CHANNELS) {
    const schema = IPC_CONTRACT[channel].request;
    const handler = handlers[channel] as (request: unknown) => Promise<IpcResult<IpcChannel>>;
    ipc.handle(channel, async (event, ...args) => {
      const launcher = options.launcher();
      if (!launcher || !checkSender(event, launcher, options.origin)) {
        log.warn("IPC_FORBIDDEN_SENDER", {
          channel,
          frameUrl: event.senderFrame?.url ?? null,
          subframe: event.senderFrame ? event.senderFrame.parent !== null : null,
        });
        return REFUSED;
      }
      const bytes = args.length === 1 ? jsonBytes(args[0]) : null;
      if (bytes === null || bytes > MAX_IPC_PAYLOAD_BYTES) {
        log.warn("ipc.invalid-payload", { channel, args: args.length, bytes });
        return INVALID;
      }
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success) {
        log.warn("ipc.invalid-argument", {
          channel,
          issues: parsed.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.map(String),
          })),
        });
        return INVALID;
      }
      try {
        return await handler(parsed.data);
      } catch (error) {
        log.error("ipc.handler-failed", { channel, error });
        return FAILED;
      }
    });
  }
}
