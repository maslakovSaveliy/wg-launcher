// The launcher IPC contract of architecture.md section 6: one zod schema per request and response. Main validates
// every request with these schemas after its sender check; the renderer only uses the types. Every object is a
// `z.strictObject` (unknown keys are rejected, plan M7), ids are lowercase UUIDv7, and no request carries a file
// path or a URL to open. Channels of later tasks (snapshots, deleting data) are added with those tasks.

import { z } from "zod";
import type { IpcCode } from "./errors.js";
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

export const IPC_CONTRACT = {
  "library:list": {
    request: empty,
    // A database written by a newer app is read-only: the UI shows the reason instead of a library.
    response: z.discriminatedUnion("library", [
      z.strictObject({ library: z.literal("ready"), cards: z.array(cardSchema) }),
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
  "game:launch": {
    request: byId,
    response: z.strictObject({
      window: z.enum(["opened", "focused", "closing"]),
      state: gameStateSchema,
    }),
  },
  "game:focus": { request: byId, response: empty },
  // The save dialog runs in main: no path crosses IPC (architecture.md section 8).
  "shortcut:create": { request: byId, response: z.strictObject({ created: z.boolean() }) },
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
export type IpcResult<C extends IpcChannel> = Result<IpcData<C>, IpcCode>;

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
