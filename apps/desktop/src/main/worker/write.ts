// The snapshot worker's file step of an export (save-transfer.md section 6, "Export"; architecture.md section 3): the
// `.wgsnap` is written as a `.partial` file in `tmp/`, flushed, then read back through the full validator with its
// size from `stat`, and only then renamed into `snapshots/<gameId>/`. The writer itself refuses what it can know
// before writing (paths, counts, `maxEntryBytes`, `maxTotalBytes`, the manifest), but not the compression ratio or
// `maxFileBytes`; the read-back makes those fail with their SNAP_* code too (Review Focus 4). After the rename the
// directory is flushed too. Any failure removes the partial file and leaves nothing under `snapshots/` (Review Focus
// 5); a failure after the rename (the directory flush) is reported, and the caller removes the final file.
import { createReadStream } from "node:fs";
import { access, type FileHandle, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import {
  type Limits,
  SnapError,
  type SnapshotFile,
  validateSnapshot,
  writeSnapshot,
} from "@wg-launcher/snapshot/container";
import type { ManifestFields } from "./protocol.js";

/** A failure that is not a format code: the file system, mostly. `message` is short English without paths. */
export class WriteFailure extends Error {
  readonly code = "INTERNAL";
  constructor(message: string) {
    super(message);
    this.name = "WriteFailure";
  }
}

export interface WriteRequest {
  manifest: ManifestFields;
  files: readonly SnapshotFile[];
  partialPath: string;
  finalPath: string;
  limits: Partial<Limits>;
  /** Test flavor only: the file write fails after its first chunk reached the disk, as a failing disk would. */
  fault?: "fail-write";
}

export interface Written {
  contentHash: string;
  sizeBytes: number;
  entries: number;
}

const errnoOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : "unknown error";
};

/** The file handle as a stream; with `fault`, the first chunk is written and then the write fails with EIO. */
function fileSink(handle: FileHandle, fault: WriteRequest["fault"]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      handle.write(chunk).then(
        () =>
          callback(
            fault === "fail-write"
              ? Object.assign(new Error("simulated write failure"), { code: "EIO" })
              : undefined,
          ),
        (error: Error) => callback(error),
      );
    },
  });
}

/**
 * Flushes a directory, so the rename survives a crash. Windows cannot open a directory for this (Assumed: NTFS
 * journals the rename itself); there the step is skipped.
 */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export async function writeVerified(request: WriteRequest): Promise<Written> {
  const { partialPath, finalPath, limits } = request;
  let handle: FileHandle | null = null;
  try {
    handle = await open(partialPath, "wx");
    let written: { contentHash: string; sizeBytes: number };
    try {
      written = await writeSnapshot(
        { ...request.manifest, files: request.files },
        fileSink(handle, request.fault),
        limits,
      );
      await handle.sync();
    } catch (error) {
      if (error instanceof SnapError) throw error;
      throw new WriteFailure(`The snapshot file could not be written (${errnoOf(error)}).`);
    } finally {
      await handle.close().catch(() => undefined);
      handle = null;
    }
    const compressedSize = (await stat(partialPath)).size;
    const validated = await validateSnapshot(createReadStream(partialPath), {
      compressedSize,
      limits,
    });
    if (validated.manifest.contentHash !== written.contentHash) {
      throw new WriteFailure("The snapshot file read back differs from what was written.");
    }
    // A revision id is never reused; an existing file is never replaced.
    if (await exists(finalPath)) throw new WriteFailure("A snapshot with this revision exists.");
    await rename(partialPath, finalPath);
    await syncDirectory(dirname(finalPath));
    return {
      contentHash: written.contentHash,
      sizeBytes: compressedSize,
      entries: validated.manifest.entries.length,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
    if (error instanceof SnapError || error instanceof WriteFailure) {
      throw error;
    }
    throw new WriteFailure(`The snapshot file could not be written (${errnoOf(error)}).`);
  }
}
