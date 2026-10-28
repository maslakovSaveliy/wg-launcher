// The messages between the main process and the snapshot worker (architecture.md section 1, a `utilityProcess`):
// `WorkerCommand` from main, `WorkerEvent` back. Both ends validate every message with these strict schemas. No
// message carries snapshot bytes: those go from each quiescent frame to the worker over its own port (frame protocol,
// `@wg-launcher/exporters`), and the worker writes the file itself. Every string and list is bounded, so no message
// here is large (Assumed bounds: paths 4 096 characters, at most `maxStorageKeys` keys).
import { ERROR_CODES, isUuidV7 } from "@wg-launcher/shared";
import { z } from "zod";

const id = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().refine(isUuidV7, "not a lowercase UUIDv7");
const text = (max: number) => z.string().max(max);
const path = z.string().min(1).max(4096);
const positive = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Overrides of the snapshot limits (snapshot-format.md section 8), test flavor only; production sends none. */
export const limitsSchema = z
  .strictObject({
    maxFileBytes: positive,
    maxEntries: positive,
    maxEntryBytes: positive,
    maxTotalBytes: positive,
    maxRatio: positive,
    ratioFloorBytes: positive,
    maxManifestBytes: positive,
  })
  .partial();

const storageKey = z.strictObject({
  origin: text(2048),
  topLevelSite: text(2048).nullable(),
});
const selection = z.union([
  z.literal("all"),
  z.strictObject({ include: z.array(text(256)).max(64), exclude: z.array(text(256)).max(64) }),
]);
const scope = z.strictObject({ localStorage: selection, indexedDB: selection });

/** The manifest fields main chooses (snapshot-format.md section 4); `entries` and `contentHash` are the worker's. */
const manifestFields = z.strictObject({
  format: z.literal("wgsnap"),
  formatVersion: z.literal(1),
  gameId: uuid,
  revisionId: uuid,
  parentRevisionId: uuid.nullable(),
  createdAt: text(32),
  deviceId: uuid,
  exporter: z.strictObject({ id: text(64), version: text(256) }),
  adapter: z.strictObject({ id: text(64), version: text(256) }).nullable(),
  gameVersion: text(128).nullable(),
  flushState: z.enum(["confirmed", "unconfirmed"]),
  storageKeys: z
    .array(z.strictObject({ ...storageKey.shape, role: z.enum(["top", "frame"]) }))
    .max(32),
  notExported: z
    .array(
      z.strictObject({
        key: z.int().min(0).max(31),
        kind: z.enum(["fileSystem", "cacheStorage", "serviceWorkers"]),
      }),
    )
    .max(96)
    .optional(),
});
export type ManifestFields = z.infer<typeof manifestFields>;

export const WorkerCommand = z.discriminatedUnion("type", [
  /** Starts a job: the limits its entries are held to. */
  z.strictObject({ type: z.literal("begin"), jobId: id, limits: limitsSchema }),
  /**
   * One frame's command, sent with that frame's port in the message's ports: `inventory`, or `export` of the
   * frame's key `keyIndex` (its entries are kept for the job's `write`).
   */
  z.strictObject({
    type: z.literal("frame"),
    jobId: id,
    requestId: id,
    op: z.discriminatedUnion("op", [
      z.strictObject({ op: z.literal("inventory") }),
      z.strictObject({
        op: z.literal("export"),
        keyIndex: z.int().min(0).max(31),
        storageKey,
        scope,
      }),
    ]),
  }),
  /**
   * Writes the job's entries as a `.wgsnap` to `partialPath` (in `tmp/`), flushes it, reads it back through the full
   * validator and renames it to `finalPath`. `fault` exists in the test flavor only.
   */
  z.strictObject({
    type: z.literal("write"),
    jobId: id,
    requestId: id,
    manifest: manifestFields,
    partialPath: path,
    finalPath: path,
    fault: z.literal("fail-write").optional(),
  }),
]);
export type WorkerCommand = z.infer<typeof WorkerCommand>;

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const code = z.enum(ERROR_CODES);

export const WorkerEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({
    type: z.literal("inventory"),
    requestId: id,
    inventory: z.strictObject({
      localStorageItems: count,
      databases: z.array(z.strictObject({ name: text(1024), version: count })).max(4096),
      usageDetails: z.record(text(64), z.number().min(0)).nullable(),
    }),
  }),
  z.strictObject({
    type: z.literal("exported"),
    requestId: id,
    /** Counts only, never names: the main process logs them. */
    summary: z.strictObject({
      localStorageItems: count,
      databases: count,
      records: count,
      blobs: count,
      notExported: z.array(z.enum(["fileSystem", "cacheStorage", "serviceWorkers"])).max(3),
    }),
  }),
  /** Entry bytes the job has received so far, measured (architecture.md section 6: real bytes only). */
  z.strictObject({ type: z.literal("received"), jobId: id, bytes: count }),
  z.strictObject({
    type: z.literal("written"),
    requestId: id,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: count,
    entries: count,
  }),
  z.strictObject({
    type: z.literal("failed"),
    requestId: id,
    code,
    /** Short English, no paths, values or names. */
    message: text(512),
  }),
]);
export type WorkerEvent = z.infer<typeof WorkerEvent>;
