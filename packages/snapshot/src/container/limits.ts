// The limits of snapshot-format.md section 8. Production uses DEFAULT_LIMITS (pinned by a unit test); tests and the
// golden vectors lower single limits by name.

export interface Limits {
  /** Compressed `.wgsnap` bytes. */
  maxFileBytes: number;
  /** Tar entries, files and directories (rule 11). */
  maxEntries: number;
  /** Bytes of one entry, checked on its header (rule 12). */
  maxEntryBytes: number;
  /** Uncompressed tar stream bytes. */
  maxTotalBytes: number;
  /** Uncompressed bytes so far divided by compressed bytes so far, once past `ratioFloorBytes`. */
  maxRatio: number;
  ratioFloorBytes: number;
  maxManifestBytes: number;
  maxStorageKeys: number;
  maxDatabasesPerKey: number;
  maxStoresPerDatabase: number;
  maxIndexesPerStore: number;
  /** CBOR nesting depth (section 6.2 rule 8). */
  maxDepth: number;
}

const MiB = 2 ** 20;

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxFileBytes: 1024 * MiB,
  maxEntries: 100_000,
  maxEntryBytes: 512 * MiB,
  maxTotalBytes: 2048 * MiB,
  maxRatio: 200,
  ratioFloorBytes: 64 * MiB,
  maxManifestBytes: MiB,
  maxStorageKeys: 32,
  maxDatabasesPerKey: 256,
  maxStoresPerDatabase: 256,
  maxIndexesPerStore: 64,
  maxDepth: 256,
});

/** DEFAULT_LIMITS with the given overrides. Unknown names and non-positive or non-integer values are a TypeError. */
export function resolveLimits(overrides: Partial<Limits> = {}): Readonly<Limits> {
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) {
      throw new TypeError(`unknown snapshot limit ${name}`);
    }
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new TypeError(`snapshot limit ${name} must be a positive integer`);
    }
    limits[name as keyof Limits] = value as number;
  }
  return Object.freeze(limits);
}
