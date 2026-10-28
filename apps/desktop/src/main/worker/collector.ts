// The snapshot worker's store of one export job: the entry chunks every frame sends (frame protocol), assembled into
// whole files under the job's limits before the writer sees them. A chunk is refused, and the job fails with the
// reader's code, as soon as the limit it breaks is known: `maxEntryBytes` from the declared size before a byte is
// kept, `maxTotalBytes` (the data alone, a lower bound of the tar stream) from the declared size before the entry's
// buffer is allocated and again as entries complete, and `maxEntries`. A frame
// may write only its own key's `data/<k>/` files and blobs; a blob must be named by the SHA-256 of its bytes, and
// the same blob from two frames is kept once.
import { createHash } from "node:crypto";
import type { Limits } from "@wg-launcher/snapshot/container";
import { parseDataPath, SnapError, type SnapshotFile } from "@wg-launcher/snapshot/container";

export interface EntryChunk {
  path: string;
  offset: number;
  size: number;
  bytes: ArrayBuffer;
}

/** A broken frame protocol (not a format limit): the job fails with INTERNAL. */
export class ChunkOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkOrderError";
  }
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class EntryCollector {
  readonly #limits: Readonly<Limits>;
  readonly #files = new Map<string, Uint8Array>();
  #bytes = 0;
  #received = 0;

  constructor(limits: Readonly<Limits>) {
    this.#limits = limits;
  }

  /** The limits the job's entries are held to (the writer and the read-back use the same). */
  get limits(): Readonly<Limits> {
    return this.#limits;
  }

  /** Entry bytes received so far (chunks included, whole entries or not). */
  get received(): number {
    return this.#received;
  }

  files(): SnapshotFile[] {
    return [...this.#files].map(([path, bytes]) => ({ path, bytes }));
  }

  /** The receiver of one frame's export of storage key `keyIndex`. */
  forKey(keyIndex: number): { add(chunk: EntryChunk): void; finish(): void } {
    let current: { path: string; bytes: Uint8Array; at: number } | null = null;
    const complete = (path: string, bytes: Uint8Array) => {
      const kind = parseDataPath(path, keyIndex + 1);
      if (kind?.kind === "blob") {
        if (sha256Hex(bytes) !== kind.sha256) {
          throw new SnapError(
            "SNAP_RECORD_INVALID",
            "a blob entry is not named by its SHA-256",
            path,
          );
        }
        // The same blob from another frame (content-addressed): kept once.
        if (this.#files.has(path)) return;
      } else if (this.#files.has(path)) {
        throw new SnapError("SNAP_DUPLICATE_PATH", "the same path twice", path);
      }
      // manifest.json counts as an entry too.
      if (this.#files.size + 2 > this.#limits.maxEntries) {
        throw new SnapError("SNAP_TOO_MANY_ENTRIES", "too many entries", path);
      }
      if (this.#bytes + bytes.length > this.#limits.maxTotalBytes) {
        throw new SnapError("SNAP_TOTAL_TOO_LARGE", "the uncompressed archive is too large", path);
      }
      this.#bytes += bytes.length;
      this.#files.set(path, bytes);
    };
    return {
      add: (chunk) => {
        if (current === null) {
          const kind = parseDataPath(chunk.path, keyIndex + 1);
          if (kind === null || (kind.kind !== "blob" && kind.key !== keyIndex)) {
            throw new ChunkOrderError("an entry outside the frame's own storage key");
          }
          if (chunk.offset !== 0) throw new ChunkOrderError("an entry that does not start at 0");
          if (chunk.size > this.#limits.maxEntryBytes) {
            throw new SnapError("SNAP_ENTRY_TOO_LARGE", "entry above maxEntryBytes", chunk.path);
          }
          // Before allocating: the declared size must fit what is left of maxTotalBytes.
          if (this.#bytes + chunk.size > this.#limits.maxTotalBytes) {
            throw new SnapError(
              "SNAP_TOTAL_TOO_LARGE",
              "the uncompressed archive is too large",
              chunk.path,
            );
          }
          current = { path: chunk.path, bytes: new Uint8Array(chunk.size), at: 0 };
        }
        if (chunk.path !== current.path || chunk.size !== current.bytes.length) {
          throw new ChunkOrderError("a chunk of another entry before this one was complete");
        }
        if (chunk.offset !== current.at) throw new ChunkOrderError("a chunk out of order");
        current.bytes.set(new Uint8Array(chunk.bytes), chunk.offset);
        current.at += chunk.bytes.byteLength;
        this.#received += chunk.bytes.byteLength;
        if (current.at === current.bytes.length) {
          const done = current;
          current = null;
          complete(done.path, done.bytes);
        }
      },
      finish: () => {
        if (current !== null) throw new ChunkOrderError("the export ended inside an entry");
      },
    };
  }
}
