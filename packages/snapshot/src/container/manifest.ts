// `manifest.json` (snapshot-format.md section 4): the zod schema and the reader's check order, which is size, JSON
// parse, `format`, `formatVersion`, JCS canonical form, schema, `contentHash`. The top-level object is not strict
// (unknown fields are ignored, and `contentHash` does not cover them); nested objects are strict (Phase 1 plan, M7).
import { isUuidV7 } from "@wg-launcher/shared";
import { z } from "zod";
import { SnapError } from "../errors.js";
import { computeContentHash } from "./content-hash.js";
import { canonicalJson } from "./jcs.js";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";

// SemVer 2.0.0, the regular expression published at https://semver.org (section "Is there a suggested regular
// expression"). Versions are at most 256 characters, like adapter strings (save-transfer.md section 8).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const COMPONENT_ID = /^[a-z0-9-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const uuidV7 = z.string().refine(isUuidV7, "not a lowercase UUIDv7");

/** The WHATWG serialization of an http or https origin: parsing it and serializing the origin gives it back. */
function isHttpOrigin(value: string, allowPort: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value &&
    (allowPort || url.port === "")
  );
}

const component = z.strictObject({
  id: z.string().regex(COMPONENT_ID),
  version: z.string().max(256).regex(SEMVER),
});

const storageKey = z.strictObject({
  origin: z.string().refine((s) => isHttpOrigin(s, true), "not an http(s) origin"),
  // `scheme://registrable-domain`: an origin without a port. The registrable domain itself is not checked here.
  topLevelSite: z
    .string()
    .refine((s) => isHttpOrigin(s, false), "not an http(s) site")
    .nullable(),
  role: z.enum(["top", "frame"]),
});

const entry = z.strictObject({
  path: z.string(),
  size: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(SHA256),
});

const notExported = z.strictObject({
  key: z.int().min(0),
  kind: z.enum(["fileSystem", "cacheStorage", "serviceWorkers"]),
});

type StorageKey = z.infer<typeof storageKey>;

/** Origin first, then topLevelSite with `null` first; both in code-unit order. */
function compareKeys(a: StorageKey, b: StorageKey): number {
  if (a.origin !== b.origin) {
    return a.origin < b.origin ? -1 : 1;
  }
  if (a.topLevelSite === b.topLevelSite) {
    return 0;
  }
  if (a.topLevelSite === null || b.topLevelSite === null) {
    return a.topLevelSite === null ? -1 : 1;
  }
  return a.topLevelSite < b.topLevelSite ? -1 : 1;
}

/** The manifest schema for the given limits (`maxStorageKeys`). */
export function manifestSchema(limits: Pick<Limits, "maxStorageKeys"> = DEFAULT_LIMITS) {
  return z
    .object({
      format: z.literal("wgsnap"),
      formatVersion: z.literal(1),
      gameId: uuidV7,
      revisionId: uuidV7,
      parentRevisionId: uuidV7.nullable(),
      createdAt: z
        .string()
        .regex(CREATED_AT)
        .refine((s) => {
          const time = Date.parse(s);
          return Number.isFinite(time) && new Date(time).toISOString() === s;
        }, "not a valid UTC time"),
      deviceId: uuidV7,
      exporter: component,
      adapter: component.nullable(),
      // At most 128 UTF-16 code units.
      gameVersion: z.string().max(128).nullable(),
      flushState: z.enum(["confirmed", "unconfirmed"]),
      storageKeys: z.array(storageKey).max(limits.maxStorageKeys),
      entries: z.array(entry),
      contentHash: z.string().regex(SHA256),
      notExported: z.array(notExported).optional(),
    })
    .superRefine((m, ctx) => {
      m.storageKeys.forEach((key, i) => {
        const previous = m.storageKeys[i - 1];
        if (previous !== undefined && compareKeys(previous, key) >= 0) {
          ctx.addIssue({ code: "custom", message: "storageKeys are not strictly ascending" });
        }
      });
      m.entries.forEach((item, i) => {
        const previous = m.entries[i - 1];
        if (previous !== undefined && !(previous.path < item.path)) {
          ctx.addIssue({ code: "custom", message: "entries are not strictly ascending by path" });
        }
        if (item.path === "manifest.json") {
          ctx.addIssue({ code: "custom", message: "manifest.json is not listed in entries" });
        }
      });
      for (const item of m.notExported ?? []) {
        if (item.key >= m.storageKeys.length) {
          ctx.addIssue({
            code: "custom",
            message: "notExported names a storage key that does not exist",
          });
        }
      }
    });
}

export const ManifestSchema = manifestSchema();
export type Manifest = z.infer<typeof ManifestSchema>;

// ignoreBOM keeps a leading U+FEFF, which JSON.parse then refuses: the manifest is UTF-8 without a byte-order mark.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const fail = (code: "SNAP_MANIFEST_INVALID", message: string): never => {
  throw new SnapError(code, message, "manifest.json");
};

/** The checks of section 4 in their order. Errors carry the path `manifest.json` and never its content. */
export function parseManifest(
  bytes: Uint8Array,
  limits: Readonly<Limits> = DEFAULT_LIMITS,
): Manifest {
  if (bytes.length > limits.maxManifestBytes) {
    throw new SnapError("SNAP_MANIFEST_TOO_LARGE", "manifest.json is too large", "manifest.json");
  }
  let text: string;
  let value: unknown;
  try {
    text = utf8.decode(bytes);
    value = JSON.parse(text);
  } catch {
    return fail("SNAP_MANIFEST_INVALID", "manifest.json is not UTF-8 JSON");
  }
  const object =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (object?.format !== "wgsnap") {
    throw new SnapError("SNAP_UNKNOWN_FORMAT", "not a wgsnap manifest", "manifest.json");
  }
  if (object.formatVersion !== 1) {
    throw new SnapError("SNAP_UNSUPPORTED_VERSION", "unsupported formatVersion", "manifest.json");
  }
  let canonical: string | undefined;
  try {
    canonical = canonicalJson(object);
  } catch {
    // A number outside the safe integers or a lone surrogate: no canonical form in this subset.
  }
  if (canonical !== text) {
    fail("SNAP_MANIFEST_INVALID", "manifest.json is not in JCS canonical form");
  }
  const parsed = manifestSchema(limits).safeParse(object);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") ?? "";
    return fail(
      "SNAP_MANIFEST_INVALID",
      `manifest.json breaks the schema at ${where || "the top level"}`,
    );
  }
  if (computeContentHash(parsed.data) !== parsed.data.contentHash) {
    throw new SnapError(
      "SNAP_CONTENT_HASH_MISMATCH",
      "contentHash does not match",
      "manifest.json",
    );
  }
  return parsed.data;
}
