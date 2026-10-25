// The `.wgsnap` validator and the restore's second pass (snapshot-format.md sections 2 to 8, save-transfer.md R1 and
// R6). Order: container (inflate) → entry rules 1 to 14 (readTar) → manifest checks in section 4 order → contentHash →
// each entry's size and SHA-256 while streaming → records decoded and checked → schema and blob cross-checks. The
// first failure ends validation. Nothing here has a sink: the validator reads and returns counts, never data values.
import { createHash } from "node:crypto";
import { SnapError } from "../errors.js";
import { type CborItem, TAG } from "../record/cbor.js";
import {
  type DbSchema,
  decodeLocalStorage,
  decodeSchema,
  decodeStoreRecords,
} from "../record/data-files.js";
import { type BlobRefs, stringOf } from "../record/value.js";
import { type Counters, inflate } from "./inflate.js";
import { type Limits, resolveLimits } from "./limits.js";
import { type Manifest, parseManifest } from "./manifest.js";
import { blobPath, type DataPath, isDataDirectory, parseDataPath, storePath } from "./paths.js";
import { readTar, type TarHeader } from "./ustar.js";

export interface StorageKeySummary {
  /** Items in `local-storage.cbor` (0 when the file is absent). */
  localStorageItems: number;
  /** Databases in index order, each with its stores in index order. */
  databases: { stores: { records: number }[] }[];
}

/** What a successful validation returns: the manifest and counts, never data values. */
export interface ValidatedSnapshot {
  manifest: Manifest;
  compressedBytes: number;
  /** Uncompressed tar bytes. */
  tarBytes: number;
  /** One summary per `manifest.storageKeys` item, in the same order. */
  storageKeys: StorageKeySummary[];
  blobs: { count: number; bytes: number };
}

/** How to read a source: its exact size in compressed bytes (from `stat` of the private copy) and limit overrides. */
export interface ReadOptions {
  compressedSize: number;
  /** Overrides single values of DEFAULT_LIMITS (tests and golden vectors). */
  limits?: Partial<Limits>;
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Rethrows a record-layer error with the entry path, which the record layer does not know. */
function inEntry<T>(path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SnapError && error.path === undefined) {
      throw new SnapError(error.code, error.message, path);
    }
    throw error;
  }
}

const recordInvalid = (message: string, path: string): never => {
  throw new SnapError("SNAP_RECORD_INVALID", message, path);
};

/** Ruling R7: every RegExp source must compile in this engine before anything is written. */
function compileRegExps(item: CborItem): void {
  if (item.k === "array") {
    item.v.forEach(compileRegExps);
  } else if (item.k === "tag") {
    if (item.tag === TAG.regexp && item.v.k === "array") {
      const [source, flags] = item.v.v;
      try {
        new RegExp(stringOf(source) ?? "", flags?.k === "text" ? flags.v : "");
      } catch {
        throw new SnapError("SNAP_RECORD_INVALID", "a RegExp source does not compile");
      }
      return;
    }
    compileRegExps(item.v);
  }
}

/** The checks both passes share: header checks against the manifest, entry hashes, missing entries. */
class EntryPass {
  manifest: Manifest | undefined;
  readonly #limits: Readonly<Limits>;
  readonly #listed = new Map<string, { size: number; sha256: string }>();
  readonly #seen = new Set<string>();
  readonly #earlyDirectories: string[] = [];

  constructor(limits: Readonly<Limits>) {
    this.#limits = limits;
  }

  /** After entry rules 1 to 14, before the data is read. */
  onHeader(header: TarHeader): void {
    if (header.type === "directory") {
      if (header.size > 0) {
        throw new SnapError("SNAP_UNEXPECTED_ENTRY", "a directory entry with data", header.path);
      }
      if (this.manifest === undefined) {
        this.#earlyDirectories.push(header.path);
      } else {
        this.#checkDirectory(header.path);
      }
      return;
    }
    if (this.manifest === undefined) {
      // Rule 14 made this manifest.json.
      if (header.size > this.#limits.maxManifestBytes) {
        throw new SnapError("SNAP_MANIFEST_TOO_LARGE", "manifest.json is too large", header.path);
      }
      return;
    }
    const listed = this.#listed.get(header.path);
    if (
      parseDataPath(header.path, this.manifest.storageKeys.length) === null ||
      listed === undefined
    ) {
      throw new SnapError(
        "SNAP_UNEXPECTED_ENTRY",
        "a file that the manifest does not list",
        header.path,
      );
    }
    if (header.size !== listed.size) {
      throw new SnapError(
        "SNAP_SIZE_MISMATCH",
        "the entry size differs from the manifest",
        header.path,
      );
    }
  }

  acceptManifest(manifest: Manifest): void {
    this.manifest = manifest;
    for (const entry of manifest.entries) {
      this.#listed.set(entry.path, { size: entry.size, sha256: entry.sha256 });
    }
    for (const path of this.#earlyDirectories) {
      this.#checkDirectory(path);
    }
  }

  /** The data of a listed file: its hash, then its place in the grammar. */
  checkData(path: string, data: Uint8Array): DataPath {
    const listed = this.#listed.get(path) as { size: number; sha256: string };
    if (sha256Hex(data) !== listed.sha256) {
      throw new SnapError(
        "SNAP_ENTRY_HASH_MISMATCH",
        "the entry hash differs from the manifest",
        path,
      );
    }
    this.#seen.add(path);
    return parseDataPath(path, (this.manifest as Manifest).storageKeys.length) as DataPath;
  }

  /** At the end of the archive: every listed entry appeared (first missing one in manifest order). */
  finish(): Manifest {
    const manifest = this.manifest as Manifest;
    for (const entry of manifest.entries) {
      if (!this.#seen.has(entry.path)) {
        throw new SnapError("SNAP_MISSING_ENTRY", "a listed entry is missing", entry.path);
      }
    }
    return manifest;
  }

  #checkDirectory(path: string): void {
    if (!isDataDirectory(path, (this.manifest as Manifest).storageKeys.length)) {
      throw new SnapError("SNAP_UNEXPECTED_ENTRY", "a directory outside the path grammar", path);
    }
  }
}

/** Records, schemas and blobs of the first pass, cross-checked at the end (sections 7.2 to 7.4 and 8). */
class RecordChecks {
  readonly #limits: Readonly<Limits>;
  readonly #refs: BlobRefs = new Map();
  readonly #localStorage = new Map<number, number>();
  readonly #schemas = new Map<string, DbSchema>();
  readonly #stores = new Map<string, number>();
  readonly #blobs = new Map<string, number>();

  constructor(limits: Readonly<Limits>) {
    this.#limits = limits;
  }

  add(path: string, kind: DataPath, data: Uint8Array): void {
    const options = { maxDepth: this.#limits.maxDepth };
    switch (kind.kind) {
      case "localStorage":
        this.#localStorage.set(
          kind.key,
          inEntry(path, () => decodeLocalStorage(data, options)).length,
        );
        return;
      case "schema": {
        if (kind.db >= this.#limits.maxDatabasesPerKey) {
          recordInvalid("more databases than maxDatabasesPerKey", path);
        }
        const schema = inEntry(path, () => decodeSchema(data, options));
        if (schema.stores.length > this.#limits.maxStoresPerDatabase) {
          recordInvalid("more stores than maxStoresPerDatabase", path);
        }
        if (schema.stores.some((store) => store.indexes.length > this.#limits.maxIndexesPerStore)) {
          recordInvalid("more indexes than maxIndexesPerStore", path);
        }
        this.#schemas.set(`${kind.key}/${kind.db}`, schema);
        return;
      }
      case "store": {
        if (kind.store >= this.#limits.maxStoresPerDatabase) {
          recordInvalid("more stores than maxStoresPerDatabase", path);
        }
        const records = inEntry(path, () => {
          const decoded = decodeStoreRecords(data, this.#refs, options);
          for (const record of decoded) {
            compileRegExps(record.value);
          }
          return decoded.length;
        });
        this.#stores.set(`${kind.key}/${kind.db}/${kind.store}`, records);
        return;
      }
      case "blob":
        if (sha256Hex(data) !== kind.sha256) {
          recordInvalid("a blob entry is not named by its SHA-256", path);
        }
        this.#blobs.set(kind.sha256, data.length);
        return;
    }
  }

  /** Cross-checks in manifest entry order, then blob references in hash order, so the result is deterministic. */
  finish(manifest: Manifest): StorageKeySummary[] {
    const keys = manifest.storageKeys.length;
    for (const entry of manifest.entries) {
      const kind = parseDataPath(entry.path, keys) as DataPath;
      if (kind.kind === "schema") {
        this.#checkSchema(kind.key, kind.db, entry.path);
      } else if (kind.kind === "store") {
        const schema = this.#schemas.get(`${kind.key}/${kind.db}`);
        const store = schema?.stores[kind.store];
        if (store === undefined) {
          recordInvalid("a store file without a store in its schema", entry.path);
        } else if (store.records !== this.#stores.get(`${kind.key}/${kind.db}/${kind.store}`)) {
          recordInvalid("the store does not hold exactly `records` items", entry.path);
        }
      } else if (
        kind.kind === "blob" &&
        this.#refs.get(kind.sha256) !== this.#blobs.get(kind.sha256)
      ) {
        recordInvalid("a blob entry that no value references with its size", entry.path);
      }
    }
    for (const sha256 of [...this.#refs.keys()].sort()) {
      if (!this.#blobs.has(sha256)) {
        recordInvalid("a blob reference without its blob entry", blobPath(sha256));
      }
    }
    return Array.from({ length: keys }, (_, key) => this.#summary(key));
  }

  #checkSchema(key: number, db: number, path: string): void {
    const schema = this.#schemas.get(`${key}/${db}`) as DbSchema;
    const previous = this.#schemas.get(`${key}/${db - 1}`);
    if (db > 0 && previous === undefined) {
      recordInvalid("databases are not numbered 0 to n - 1", path);
    }
    if (previous !== undefined && !(previous.name < schema.name)) {
      recordInvalid("databases are not sorted by name", path);
    }
    schema.stores.forEach((_, store) => {
      if (!this.#stores.has(`${key}/${db}/${store}`)) {
        recordInvalid("a store of the schema has no store file", storePath(key, db, store));
      }
    });
  }

  #summary(key: number): StorageKeySummary {
    const databases: StorageKeySummary["databases"] = [];
    for (let db = 0; this.#schemas.has(`${key}/${db}`); db++) {
      const schema = this.#schemas.get(`${key}/${db}`) as DbSchema;
      databases.push({ stores: schema.stores.map((store) => ({ records: store.records })) });
    }
    return { localStorageItems: this.#localStorage.get(key) ?? 0, databases };
  }

  get blobs(): { count: number; bytes: number } {
    return {
      count: this.#blobs.size,
      bytes: [...this.#blobs.values()].reduce((n, size) => n + size, 0),
    };
  }
}

/** Resolves the limits and checks the declared size first: above `maxFileBytes` fails before anything is read. */
function start(source: AsyncIterable<Uint8Array>, options: ReadOptions) {
  const limits = resolveLimits(options.limits);
  const { compressedSize } = options;
  if (!Number.isSafeInteger(compressedSize) || compressedSize < 0) {
    throw new TypeError("compressedSize must be a non-negative integer");
  }
  if (compressedSize > limits.maxFileBytes) {
    throw new SnapError("SNAP_FILE_TOO_LARGE", "the snapshot file is too large");
  }
  const counters: Counters = { compressed: 0, uncompressed: 0 };
  const pass = new EntryPass(limits);
  const tar = readTar(inflate(source, limits, compressedSize, counters), limits, (header) =>
    pass.onHeader(header),
  );
  return { limits, counters, pass, tar };
}

/**
 * Validates a whole `.wgsnap` (R1) of `options.compressedSize` bytes. Resolves with the manifest and counts, or rejects
 * with the first SnapError; an error of the source itself is passed through unchanged.
 */
export async function validateSnapshot(
  source: AsyncIterable<Uint8Array>,
  options: ReadOptions,
): Promise<ValidatedSnapshot> {
  const { limits: resolved, counters, pass, tar } = start(source, options);
  const checks = new RecordChecks(resolved);
  for await (const { header, data } of tar) {
    if (header.type === "directory") {
      continue;
    }
    if (pass.manifest === undefined) {
      pass.acceptManifest(parseManifest(data, resolved));
      continue;
    }
    checks.add(header.path, pass.checkData(header.path, data), data);
  }
  const manifest = pass.finish();
  const storageKeys = checks.finish(manifest);
  return {
    manifest,
    compressedBytes: counters.compressed,
    tarBytes: counters.uncompressed,
    storageKeys,
    blobs: checks.blobs,
  };
}

/**
 * The restore's second pass (R6): streams the file again with every container and entry check, requires its manifest
 * to have the validated `contentHash`, and yields each data entry only after its size and SHA-256 matched.
 */
export async function* readEntries(
  source: AsyncIterable<Uint8Array>,
  manifest: Manifest,
  options: ReadOptions,
): AsyncGenerator<{ path: string; bytes: Uint8Array }> {
  const { limits: resolved, pass, tar } = start(source, options);
  for await (const { header, data } of tar) {
    if (header.type === "directory") {
      continue;
    }
    if (pass.manifest === undefined) {
      const again = parseManifest(data, resolved);
      if (again.contentHash !== manifest.contentHash) {
        throw new SnapError(
          "SNAP_CONTENT_HASH_MISMATCH",
          "the file changed since it was validated",
          header.path,
        );
      }
      pass.acceptManifest(manifest);
      continue;
    }
    pass.checkData(header.path, data);
    yield { path: header.path, bytes: data };
  }
  pass.finish();
}
