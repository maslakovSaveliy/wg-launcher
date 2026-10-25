// The `.wgsnap` writer (snapshot-format.md section 2): `manifest.json` (JCS) first, then the data files sorted by path,
// two zero blocks, all in one zstd frame with the content checksum. Everything is checked before the first byte is
// written, so a refused input leaves `out` untouched.
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress } from "node:zlib";
import { SnapError } from "../errors.js";
import { computeContentHash } from "./content-hash.js";
import { canonicalJson } from "./jcs.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { type Manifest, ManifestSchema } from "./manifest.js";
import { parseDataPath } from "./paths.js";
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

/** Writes the snapshot to `out` and ends it. Resolves with the contentHash and the number of bytes written. */
export async function writeSnapshot(
  input: SnapshotInput,
  out: Writable,
): Promise<{ contentHash: string; sizeBytes: number }> {
  const { files, ...fields } = input;
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  sorted.forEach((file, i) => {
    if (parseDataPath(file.path, fields.storageKeys.length) === null) {
      throw new SnapError(
        "SNAP_UNEXPECTED_ENTRY",
        "not a data file path of formatVersion 1",
        file.path,
      );
    }
    if (sorted[i - 1]?.path === file.path) {
      throw new SnapError("SNAP_DUPLICATE_PATH", "the same path twice", file.path);
    }
    if (file.bytes.length > DEFAULT_LIMITS.maxEntryBytes) {
      throw new SnapError("SNAP_ENTRY_TOO_LARGE", "entry above maxEntryBytes", file.path);
    }
  });
  if (sorted.length + 1 > DEFAULT_LIMITS.maxEntries) {
    throw new SnapError("SNAP_TOO_MANY_ENTRIES", "too many entries");
  }

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
  const parsed = ManifestSchema.safeParse(draft);
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
  if (manifestBytes.length > DEFAULT_LIMITS.maxManifestBytes) {
    throw new SnapError("SNAP_MANIFEST_TOO_LARGE", "manifest.json is too large", "manifest.json");
  }

  function* archive(): Generator<Uint8Array> {
    for (const file of [{ path: "manifest.json", bytes: manifestBytes }, ...sorted]) {
      yield encodeHeader(file.path, file.bytes.length);
      yield file.bytes;
      yield padding(file.bytes.length);
    }
    yield new Uint8Array(2 * BLOCK);
  }

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
    for (const chunk of archive()) {
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
