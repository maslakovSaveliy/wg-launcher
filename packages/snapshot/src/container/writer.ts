// The `.wgsnap` writer (snapshot-format.md section 2): `manifest.json` (JCS) first, then the data files sorted by path,
// two zero blocks, all in one zstd frame with the content checksum. Everything is checked before the first byte is
// written, so a refused input leaves `out` untouched.
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress } from "node:zlib";
import { SnapError } from "../errors.js";
import { type DbSchema, decodeSchema } from "../record/data-files.js";
import { computeContentHash } from "./content-hash.js";
import { canonicalJson } from "./jcs.js";
import { type Limits, resolveLimits } from "./limits.js";
import { type Manifest, manifestSchema } from "./manifest.js";
import { type DataPath, parseDataPath } from "./paths.js";
import { BLOCK, encodeHeader } from "./ustar.js";

export interface SnapshotFile {
  /** A regular-file path of section 3.2 (not `manifest.json`). */
  path: string;
  bytes: Uint8Array;
}

/** The manifest fields the caller chooses, plus the data files; `entries` and `contentHash` are computed. */
export type SnapshotInput = Omit<Manifest, "entries" | "contentHash"> & {
  files: readonly SnapshotFile[];
};

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** The record-level bounds the reader checks on a path or a schema (sections 7.2 and 8), with its code. */
function checkRecordBounds(file: SnapshotFile, kind: DataPath, limits: Readonly<Limits>): void {
  const invalid = (message: string) => {
    throw new SnapError("SNAP_RECORD_INVALID", message, file.path);
  };
  if (kind.kind === "schema") {
    if (kind.db >= limits.maxDatabasesPerKey) {
      invalid("more databases than maxDatabasesPerKey");
    }
    let schema: DbSchema;
    try {
      schema = decodeSchema(file.bytes, { maxDepth: limits.maxDepth });
    } catch (error) {
      throw error instanceof SnapError
        ? new SnapError(error.code, error.message, file.path)
        : error;
    }
    if (schema.stores.length > limits.maxStoresPerDatabase) {
      invalid("more stores than maxStoresPerDatabase");
    }
    if (schema.stores.some((store) => store.indexes.length > limits.maxIndexesPerStore)) {
      invalid("more indexes than maxIndexesPerStore");
    }
  } else if (kind.kind === "store" && kind.store >= limits.maxStoresPerDatabase) {
    invalid("more stores than maxStoresPerDatabase");
  }
}

/**
 * Writes the snapshot to `out` and ends it. Resolves with the contentHash and the number of bytes written. Every check
 * runs before the first byte: path grammar, duplicates, the record bounds of section 8, the manifest schema, entry
 * count, entry, manifest and total sizes, each refused with the code the reader would give, so `out` stays untouched.
 * `limits` overrides DEFAULT_LIMITS (tests); the file must still validate with the reader's limits.
 */
export async function writeSnapshot(
  input: SnapshotInput,
  out: Writable,
  limits: Partial<Limits> = {},
): Promise<{ contentHash: string; sizeBytes: number }> {
  const resolved = resolveLimits(limits);
  const { files, ...fields } = input;
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  sorted.forEach((file, i) => {
    const kind = parseDataPath(file.path, fields.storageKeys.length);
    if (kind === null) {
      throw new SnapError(
        "SNAP_UNEXPECTED_ENTRY",
        "not a data file path of formatVersion 1",
        file.path,
      );
    }
    if (sorted[i - 1]?.path === file.path) {
      throw new SnapError("SNAP_DUPLICATE_PATH", "the same path twice", file.path);
    }
    checkRecordBounds(file, kind, resolved);
  });

  const entries = sorted.map((file) => ({
    path: file.path,
    size: file.bytes.length,
    sha256: sha256Hex(file.bytes),
  }));
  const draft = {
    ...fields,
    entries,
    contentHash: computeContentHash({ entries, storageKeys: fields.storageKeys }),
  };
  const parsed = manifestSchema(resolved).safeParse(draft);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") ?? "";
    throw new SnapError(
      "SNAP_MANIFEST_INVALID",
      `the manifest breaks the schema at ${where || "the top level"}`,
    );
  }
  // The parsed manifest has only known fields; an absent optional field is left out, not written as undefined.
  const known = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  );
  const manifestBytes = new TextEncoder().encode(canonicalJson(known));

  // The archive as the reader will meet it: each header's entry rules, then the bytes up to maxTotalBytes.
  const all = [{ path: "manifest.json", bytes: manifestBytes }, ...sorted];
  const blocks: Uint8Array[] = [];
  let tarBytes = 0;
  const total = (bytes: number, path?: string) => {
    tarBytes += bytes;
    if (tarBytes > resolved.maxTotalBytes) {
      throw new SnapError("SNAP_TOTAL_TOO_LARGE", "the uncompressed archive is too large", path);
    }
  };
  all.forEach((file, i) => {
    total(BLOCK, file.path);
    if (i + 1 > resolved.maxEntries) {
      throw new SnapError("SNAP_TOO_MANY_ENTRIES", "too many entries", file.path);
    }
    if (file.bytes.length > resolved.maxEntryBytes) {
      throw new SnapError("SNAP_ENTRY_TOO_LARGE", "entry above maxEntryBytes", file.path);
    }
    if (i === 0 && file.bytes.length > resolved.maxManifestBytes) {
      throw new SnapError("SNAP_MANIFEST_TOO_LARGE", "manifest.json is too large", file.path);
    }
    total(file.bytes.length + padding(file.bytes.length).length, file.path);
    // Bounded indexes keep every path far below the 100-byte name field; encoding here keeps any RangeError before
    // the first byte is written.
    blocks.push(encodeHeader(file.path, file.bytes.length), file.bytes, padding(file.bytes.length));
  });
  total(2 * BLOCK);
  blocks.push(new Uint8Array(2 * BLOCK));

  let sizeBytes = 0;
  const compressor = createZstdCompress({ params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const done = pipeline(
    compressor,
    async function* count(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        sizeBytes += chunk.length;
        yield chunk;
      }
    },
    out,
  );
  // Marks the rejection as handled while the loop runs; `await done` below still throws it.
  done.catch(() => {});
  try {
    // Each chunk is processed before `end()`. Node's zlib gives a chunk that is still queued at `end()` the finish
    // flag, and its `_flush` then sends another finish, which zstd answers with a second, empty frame (MEMORY.md).
    for (const chunk of blocks) {
      if (chunk.length > 0) {
        await new Promise<void>((resolve, reject) =>
          compressor.write(chunk, (error) => (error ? reject(error) : resolve())),
        );
      }
    }
    compressor.end();
  } catch (error) {
    compressor.destroy(error as Error);
  }
  await done;
  return { contentHash: parsed.data.contentHash, sizeBytes };
}
