// Registers one `ipcMain.handle` per channel of the contract (architecture.md section 6). Every call goes through the
// same steps before its handler runs: the sender check, exactly one payload of plain data (no Map, Set, ArrayBuffer,
// Date or class instance, which structured clone would carry; arrays only short and dense, inside the request
// object), the 64 KiB limit on its JSON form, and
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

/** Requests nest one level today; anything deeper than this is not a request (and a cycle ends here). */
const MAX_PAYLOAD_DEPTH = 8;

/**
 * At most this many values are visited (Assumed: a real request has fewer than ten). Structured clone keeps shared
 * references, so a graph whose 8 levels each hold k keys pointing at one next object is tiny to send but would take
 * about k^7 visits without a budget.
 */
const MAX_PAYLOAD_NODES = 4096;

/**
 * Arrays inside a request hold at most this many items (Assumed: the longest list a request carries is
 * `snapshot:export`'s `frameKeys`, at most `maxStorageKeys`, 32, of snapshot-format.md section 8).
 */
export const MAX_PAYLOAD_ARRAY_LENGTH = 32;

/** A dense array of at most MAX_PAYLOAD_ARRAY_LENGTH items with no own property but its indexes and `length`. */
function isPlainArray(item: unknown[]): boolean {
  if (Object.getPrototypeOf(item) !== Array.prototype) return false;
  // The length is checked first, so a sparse array of length 2^32 - 1 is refused before anything walks it.
  if (item.length > MAX_PAYLOAD_ARRAY_LENGTH) return false;
  if (Reflect.ownKeys(item).length !== item.length + 1) return false;
  for (let i = 0; i < item.length; i++) if (!Object.hasOwn(item, i)) return false;
  return true;
}

/**
 * True when `value` is a request of plain data: an object whose prototype is `Object.prototype` or null, holding
 * strings, numbers, booleans, null, undefined, such objects and dense arrays of at most MAX_PAYLOAD_ARRAY_LENGTH
 * items, at most `MAX_PAYLOAD_DEPTH` deep and `MAX_PAYLOAD_NODES` values in all (array items count). Electron IPC
 * uses the structured clone algorithm, so a `Map`, `Set`, `ArrayBuffer`, typed array, `Date` or class instance
 * arrives intact; `JSON.stringify` measures most of them as `{}` and `z.strictObject({})` accepts them (no own
 * enumerable keys), so they would pass both later checks at any size. A sparse array of length 2^32 - 1 is cheap to
 * send but kept `JSON.stringify` busy for about 54 s in a unit test, so an array must be short and dense, without
 * holes or other own properties, and the whole payload is never an array. Never throws: a throwing getter or a
 * revoked Proxy (possible only in process, never over IPC) is not plain data.
 */
export function isPlainData(value: unknown): boolean {
  let budget = MAX_PAYLOAD_NODES;
  const walk = (item: unknown, depth: number): boolean => {
    budget -= 1;
    if (budget < 0) return false;
    if (item === null || item === undefined) return true;
    const type = typeof item;
    if (type === "string" || type === "number" || type === "boolean") return true;
    if (type !== "object" || depth >= MAX_PAYLOAD_DEPTH) return false;
    if (Array.isArray(item)) {
      return depth > 0 && isPlainArray(item) && item.every((child) => walk(child, depth + 1));
    }
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(item as object).every((child) => walk(child, depth + 1));
  };
  try {
    return walk(value, 0);
  } catch {
    return false;
  }
}

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
      const bytes = args.length === 1 && isPlainData(args[0]) ? jsonBytes(args[0]) : null;
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
