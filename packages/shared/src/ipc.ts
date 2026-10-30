// The launcher IPC contract of architecture.md section 6: one zod schema per request and response. Main validates
// every request with these schemas after its sender check; the renderer only uses the types. Every object is a
// `z.strictObject` (unknown keys are rejected, plan M7), ids are lowercase UUIDv7, and no request carries a file
// path or a URL to open.

import { z } from "zod";
import { ERROR_CODES, type ErrorCode } from "./errors.js";
import { isUuidV7 } from "./ids.js";
import type { Result } from "./result.js";

/** A request whose JSON form is larger than this is refused before it is parsed. */
export const MAX_IPC_PAYLOAD_BYTES = 64 * 1024;

/** Titles: 1 to 200 characters (code points) after trimming (architecture.md section 12). */
export const MAX_TITLE_CHARS = 200;

export const gameIdSchema = z.string().refine(isUuidV7, "not a lowercase UUIDv7");

export const titleSchema = z
  .string()
  .trim()
  .refine((title) => {
    const chars = [...title].length;
    return chars >= 1 && chars <= MAX_TITLE_CHARS;
  }, `must be 1 to ${MAX_TITLE_CHARS} characters after trimming`);

/** The states of architecture.md section 4; `exited` and `crashed` are reported until the next launch. */
export const GAME_STATES = [
  "idle",
  "launching",
  "running",
  "closing",
  "exited",
  "crashed",
] as const;
export const gameStateSchema = z.enum(GAME_STATES);

/** The badges of architecture.md section 11, as `badgesFor` decides them. */
export const badgeSchema = z.discriminatedUnion("id", [
  z.strictObject({ id: z.literal("by-link") }),
  z.strictObject({ id: z.literal("needs-internet") }),
  z.strictObject({ id: z.literal("local-data"), checkedAt: z.int() }),
  z.strictObject({ id: z.literal("export-verified") }),
  z.strictObject({ id: z.literal("compat-not-verified") }),
]);

export const cardSchema = z.strictObject({
  gameId: gameIdSchema,
  title: z.string(),
  /** Shown as text only; the renderer never puts it into `href` or `src` (security.md section 6). */
  url: z.string(),
  /** `app://launcher/covers/<name>`, or null when the game has no cover. */
  coverUrl: z.string().nullable(),
  badges: z.array(badgeSchema),
  /** Unix milliseconds; null until recorded. */
  lastLaunchedAt: z.int().nullable(),
  playtimeMs: z.int().min(0),
  state: gameStateSchema,
  needsRecovery: z.boolean(),
});

export const orphanSchema = z.strictObject({
  gameId: gameIdSchema,
  title: z.string(),
  url: z.string(),
  removedAt: z.int(),
});

/** No setting is allowlisted yet (Phase 1 Task 9): the object is empty and every key is refused. */
export const settingsSchema = z.strictObject({});

const empty = z.strictObject({});
const byId = z.strictObject({ gameId: gameIdSchema });

/** A storage key (snapshot-format.md section 4) as the UI names a frame; main checks it against the game's frames. */
export const storageKeyRefSchema = z.strictObject({
  origin: z.string().max(2048),
  topLevelSite: z.string().max(2048).nullable(),
});

const component = z.strictObject({ id: z.string(), version: z.string() });

/** One origin of a snapshot and the origin of this game its storage goes to (save-transfer.md section 2). */
export const keyMappingSchema = z.strictObject({
  from: z.string().max(2048),
  to: z.string().max(2048),
});

const taskId = z.strictObject({ taskId: gameIdSchema });

const count = z.int().min(0);

/**
 * A frame key of a game outside its game keys, as the export dialog lists it (save-transfer.md section 6, "Export"):
 * counts and usage numbers only, never key names, database names or values. `indexedDbBytes` is Chromium's
 * `usageDetails.indexedDB`, null where it is not reported.
 */
export const frameSummarySchema = z.strictObject({
  origin: z.string(),
  topLevelSite: z.string().nullable(),
  /** The remembered choice (`storage_targets.in_export`). */
  inExport: z.boolean(),
  localStorageItems: count,
  databases: count,
  indexedDbBytes: count.nullable(),
});

/** A stored snapshot as the UI sees it (architecture.md section 7): the row's fields, never its file path. */
export const snapshotRowSchema = z.strictObject({
  revisionId: gameIdSchema,
  /** The library entry the row belongs to; may be another game's for its base revision (plan M8). */
  gameId: gameIdSchema,
  kind: z.enum(["export", "backup", "imported"]),
  /** The manifest's display string; never used for ordering. */
  createdAt: z.string(),
  parentRevisionId: gameIdSchema.nullable(),
  exporter: component,
  adapter: component.nullable(),
  contentHash: z.string(),
  sizeBytes: z.int().min(0),
  /** `unconfirmed` is shown as "flush unconfirmed", never as a save point (save-transfer.md section 7). */
  flushState: z.enum(["confirmed", "unconfirmed"]),
  verifiedAt: z.int().nullable(),
  addedAt: z.int(),
});

export const IPC_CONTRACT = {
  "library:list": {
    request: empty,
    // A database written by a newer app is read-only: the UI shows the reason instead of a library.
    response: z.discriminatedUnion("library", [
      z.strictObject({
        library: z.literal("ready"),
        cards: z.array(cardSchema),
        // Whether "Create shortcut" can work on this system (macOS and Windows), so the UI never offers a control
        // that always fails.
        canCreateShortcuts: z.boolean(),
      }),
      z.strictObject({ library: z.literal("read-only"), reason: z.string() }),
    ]),
  },
  "library:add": {
    request: z.strictObject({ url: z.string(), title: titleSchema.optional() }),
    response: cardSchema,
  },
  "library:update": {
    request: z
      .strictObject({
        gameId: gameIdSchema,
        title: titleSchema.optional(),
        // `pick` opens the file dialog in main; no path crosses IPC.
        cover: z.enum(["pick", "remove"]).optional(),
      })
      .refine((r) => r.title !== undefined || r.cover !== undefined, "nothing to change"),
    response: cardSchema,
  },
  "library:remove": { request: byId, response: empty },
  "library:orphans": {
    request: empty,
    response: z.strictObject({ orphans: z.array(orphanSchema) }),
  },
  // "Delete local saves" for a removed game's data (architecture.md section 12): backup first.
  "library:deleteOrphanData": { request: byId, response: taskId },
  "game:launch": {
    request: byId,
    response: z.strictObject({
      window: z.enum(["opened", "focused", "closing"]),
      state: gameStateSchema,
    }),
  },
  "game:focus": { request: byId, response: empty },
  // Both ask in a native dialog first; the cache is cleared at once, the saves through a task with a backup first.
  "game:clearCache": { request: byId, response: empty },
  "game:deleteSaves": { request: byId, response: taskId },
  // The save dialog runs in main: no path crosses IPC (architecture.md section 8).
  "shortcut:create": { request: byId, response: z.strictObject({ created: z.boolean() }) },
  // Reads what each frame outside the game keys holds, in a quiescent window, for the export dialog.
  "snapshot:frames": {
    request: byId,
    response: z.strictObject({ frames: z.array(frameSummarySchema) }),
  },
  // Answers once the game's lock is held; progress and the outcome follow as `task:progress` events.
  "snapshot:export": {
    request: z.strictObject({
      gameId: gameIdSchema,
      frameKeys: z.array(storageKeyRefSchema).max(32).optional(),
    }),
    response: z.strictObject({ taskId: gameIdSchema }),
  },
  // `"file"` opens the file dialog in main; the mapping is confirmed again in a native dialog main writes.
  "snapshot:import": {
    request: z.strictObject({
      gameId: gameIdSchema,
      source: z.union([z.strictObject({ revisionId: gameIdSchema }), z.literal("file")]),
      mapping: z.array(keyMappingSchema).max(32).optional(),
    }),
    response: taskId,
  },
  "snapshot:verify": {
    request: z.strictObject({ gameId: gameIdSchema, revisionId: gameIdSchema }),
    response: taskId,
  },
  // "Retry recovery" of a game marked needs_recovery (save-transfer.md section 6, "Failed rollback").
  "snapshot:recover": { request: byId, response: taskId },
  "snapshot:list": {
    request: byId,
    response: z.strictObject({ snapshots: z.array(snapshotRowSchema) }),
  },
  // The save dialog runs in main.
  "snapshot:saveAs": {
    request: z.strictObject({ gameId: gameIdSchema, revisionId: gameIdSchema }),
    response: z.strictObject({ saved: z.boolean() }),
  },
  "settings:get": { request: empty, response: settingsSchema },
  "settings:set": { request: settingsSchema, response: settingsSchema },
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type IpcChannel = keyof typeof IPC_CONTRACT;
export const IPC_CHANNELS = Object.keys(IPC_CONTRACT) as IpcChannel[];

/** What the renderer sends (before trimming). */
export type IpcRequest<C extends IpcChannel> = z.input<(typeof IPC_CONTRACT)[C]["request"]>;
/** What a handler receives after validation (titles trimmed). */
export type IpcParsedRequest<C extends IpcChannel> = z.output<(typeof IPC_CONTRACT)[C]["request"]>;
export type IpcData<C extends IpcChannel> = z.output<(typeof IPC_CONTRACT)[C]["response"]>;
/** Any result code of the specs can come back: the IPC codes and the SNAP_*, EXP_* and IMP_* ones (section 6). */
export type IpcResult<C extends IpcChannel> = Result<IpcData<C>, ErrorCode>;

export type GameState = z.output<typeof gameStateSchema>;
export type Card = z.output<typeof cardSchema>;
export type CardBadge = z.output<typeof badgeSchema>;
export type OrphanEntry = z.output<typeof orphanSchema>;

/** Main to the launcher renderer only, on `GAME_STATE_CHANNEL` (bridge.ts). */
export const gameStateEventSchema = z.strictObject({
  gameId: gameIdSchema,
  state: gameStateSchema,
  at: z.int(),
});
export type GameStateEvent = z.output<typeof gameStateEventSchema>;

export type SnapshotRow = z.output<typeof snapshotRowSchema>;
export type FrameSummary = z.output<typeof frameSummarySchema>;
export type StorageKeyRef = z.output<typeof storageKeyRefSchema>;
export type KeyMappingRef = z.output<typeof keyMappingSchema>;

/**
 * Main to the launcher renderer only, on `TASK_PROGRESS_CHANNEL` (bridge.ts): one event per real step of a task and
 * per measured byte count; `bytesTotal` only when it is known, so a percentage is never invented (AGENTS.md honesty
 * rule 1). A failed task carries its code and a short message without paths or values.
 */
export const taskProgressEventSchema = z.strictObject({
  taskId: gameIdSchema,
  gameId: gameIdSchema,
  kind: z.enum(["export", "import", "verify", "delete-saves", "recover"]),
  step: z.enum([
    "lock",
    "read",
    "write",
    "validate",
    "plan",
    "backup",
    "wipe",
    "import",
    "verify",
    "commit",
    "rollback-wipe",
    "rollback-import",
    "rollback-verify",
  ]),
  status: z.enum(["running", "done", "failed"]),
  bytesDone: z.int().min(0).optional(),
  bytesTotal: z.int().min(0).optional(),
  code: z.enum(ERROR_CODES).optional(),
  message: z.string().max(512).optional(),
});
export type TaskProgressEvent = z.output<typeof taskProgressEventSchema>;
