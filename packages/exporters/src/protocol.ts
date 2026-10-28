// The typed commands between the snapshot worker and a quiescent stub frame (save-transfer.md section 5, steps 9 and
// 10). Both ends validate every message with these schemas and abort on anything unexpected. Every message carries
// the request nonce of its command: 128 random bits as 32 lowercase hex digits, never a counter (QW-4). Entry bytes
// travel as transferred ArrayBuffers, never as JSON strings (QW-7).
import { EXP_CODES, IMP_CODES } from "@wg-launcher/shared";
import { z } from "zod";
import { isHttpOrigin } from "./origins.js";

const NONCE = /^[0-9a-f]{32}$/;

export const isRequestNonce = (value: unknown): boolean =>
  typeof value === "string" && NONCE.test(value);

const nonce = z.string().regex(NONCE);
/** `maxStorageKeys` is 32 (snapshot-format.md section 8). */
const keyIndex = z.int().min(0).max(31);
const name = z.string().max(256);

const selection = z.union([
  z.literal("all"),
  z.strictObject({ include: z.array(name).max(64), exclude: z.array(name).max(64) }),
]);
const scope = z.strictObject({ localStorage: selection, indexedDB: selection });
const storageKey = z.strictObject({
  origin: z.string().refine((s) => isHttpOrigin(s), "not an http(s) origin"),
  topLevelSite: z
    .string()
    .refine((s) => isHttpOrigin(s, false), "not an http(s) site")
    .nullable(),
});
/** One whole entry: a path of snapshot-format.md section 3.2 (at most 255 bytes) and its bytes. */
const entry = { nonce, path: z.string().max(255), bytes: z.instanceof(ArrayBuffer) };

export const FrameCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("inventory"), nonce }),
  z.strictObject({ type: z.literal("export"), nonce, keyIndex, storageKey, scope }),
  // An import is followed by its `entry` messages and one `end`, all with its nonce.
  z.strictObject({ type: z.literal("import"), nonce, keyIndex, storageKey, scope }),
  z.strictObject({ type: z.literal("entry"), ...entry }),
  z.strictObject({ type: z.literal("end"), nonce }),
  z.strictObject({ type: z.literal("wipe-selected"), nonce, scope }),
]);
export type FrameCommand = z.infer<typeof FrameCommand>;

const count = z.int().min(0);
const summary = z.strictObject({
  localStorageItems: count,
  databases: z.array(
    z.strictObject({ name: z.string(), version: z.int().min(1), stores: count, records: count }),
  ),
  blobs: count,
  notExported: z.array(z.enum(["fileSystem", "cacheStorage", "serviceWorkers"])),
});
const inventory = z.strictObject({
  localStorageItems: count,
  databases: z.array(z.strictObject({ name: z.string(), version: count })),
  usageDetails: z.record(z.string(), z.number().min(0)).nullable(),
});
const detail = z.strictObject({
  storageKey: storageKey.optional(),
  database: z.string().optional(),
  store: z.string().optional(),
  // An IndexedDB key: a number, Date, string, ArrayBuffer or array of keys, as structured clone carries it.
  recordKey: z.unknown().optional(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  type: z.string().optional(),
  reason: z.string().optional(),
  entry: z.string().optional(),
});

export const FrameReply = z.discriminatedUnion("type", [
  // An export answers with its `entry` messages, then one `summary` or `error`.
  z.strictObject({ type: z.literal("entry"), ...entry }),
  z.strictObject({ type: z.literal("inventory"), nonce, inventory }),
  z.strictObject({ type: z.literal("summary"), nonce, summary }),
  z.strictObject({
    type: z.literal("wiped"),
    nonce,
    wiped: z.strictObject({ localStorageItems: count, databases: z.array(z.string()) }),
  }),
  z.strictObject({
    type: z.literal("error"),
    nonce,
    code: z.enum([...EXP_CODES, ...IMP_CODES, "INTERNAL"]),
    message: z.string().max(1024),
    detail: detail.optional(),
  }),
]);
export type FrameReply = z.infer<typeof FrameReply>;
