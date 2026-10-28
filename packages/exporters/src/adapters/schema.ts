// Declarative adapters (save-transfer.md section 8): JSON data, never code. The schema is closed: an unknown member,
// a wrong type or an over-long value makes the adapter invalid. Adapters ship with the app and are validated when
// tested and when loaded (adapters/index.ts); user-supplied adapters are not loaded.
import { z } from "zod";
import { isHttpOrigin } from "../origins.js";
import type { FrameScope } from "../scope.js";

// SemVer 2.0.0, the regular expression published at https://semver.org, as in the manifest schema.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const ID = /^[a-z0-9-]{1,64}$/;
/** The flush hook's module object, looked up as a property of `globalThis` (save-transfer.md section 7). */
export const MODULE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const text = z.string().max(256);
const list = <T extends z.ZodType>(item: T) => z.array(item).max(64);
const origin = text.refine((s) => isHttpOrigin(s), "not an http(s) origin");
const site = text.refine((s) => isHttpOrigin(s, false), "not an http(s) site");
// Key prefixes (localStorage) or exact database names (IndexedDB): plain strings, never patterns.
const selection = z.strictObject({ include: list(text), exclude: list(text) });

const AdapterSchema = z.strictObject({
  adapterFormat: z.literal(1),
  id: z.string().regex(ID),
  version: text.regex(SEMVER),
  match: z.strictObject({ origins: list(origin).min(1) }),
  storage: z.strictObject({
    frameKeys: list(z.strictObject({ origin, topLevelSite: site })),
    localStorage: selection,
    indexedDB: selection,
  }),
  flush: z.discriminatedUnion("hook", [
    z.strictObject({ hook: z.literal("none") }),
    z.strictObject({
      hook: z.literal("emscripten-idbfs"),
      module: z.string().regex(MODULE_NAME).default("Module"),
      timeoutMs: z.int().min(1).max(30_000),
    }),
  ]),
});

export type Adapter = z.infer<typeof AdapterSchema>;

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Validates an adapter; throws AdapterError naming the first offending member. */
export function parseAdapter(json: unknown): Adapter {
  const parsed = AdapterSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "the top level";
    throw new AdapterError(`invalid adapter at ${where}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** The export and restore scope an adapter declares. */
export function adapterScope(adapter: Adapter): FrameScope {
  return { localStorage: adapter.storage.localStorage, indexedDB: adapter.storage.indexedDB };
}
