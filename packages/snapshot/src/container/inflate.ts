// The container stage of the reader (snapshot-format.md sections 2 and 8): compressed bytes through the frame walker
// into Node's zstd decompressor, with the size and ratio limits. Async throughout, so the snapshot worker stays
// responsive; backpressure keeps at most a few chunks in memory. Every verdict is tied to a byte position, so the
// result does not depend on how the source is chunked or how far Node reads ahead.
import { Readable } from "node:stream";
import { constants, createZstdDecompress } from "node:zlib";
import { SnapError } from "../errors.js";
import type { Limits } from "./limits.js";
import { ZstdFrameWalker } from "./zstd-frame.js";

export interface Counters {
  /** Compressed bytes read so far. */
  compressed: number;
  /** Uncompressed (tar) bytes produced so far. */
  uncompressed: number;
}

/** An error of the source itself (for example a failed read), carried through the streams unchanged. */
class SourceError extends Error {
  constructor(readonly original: unknown) {
    super("the snapshot source failed");
  }
}

/**
 * The decompressed tar stream of a source of exactly `compressedSize` bytes (the caller checked it against
 * `maxFileBytes` already).
 *
 * Compressed side: the frame walker's codes (`SNAP_ZSTD_INVALID`, `SNAP_ZSTD_NO_CHECKSUM`, `SNAP_TRUNCATED`,
 * `SNAP_TRAILING_DATA`), `SNAP_FILE_TOO_LARGE` for a source longer than `compressedSize` and `SNAP_TRUNCATED` for a
 * shorter one. These verdicts are deferred: reading stops at the bad byte, the bytes before it are still decompressed
 * and yielded, and the verdict is thrown where the stream would have ended. So a defect in the frame content (which the
 * tar reader finds) is reported first, and a cut file never reaches the tar reader as a clean end.
 *
 * Decompressor errors are always `SNAP_ZSTD_INVALID`: Node's decompressor does not fail on a prefix of a valid frame
 * (it just ends), so an error means corrupt bytes before any deferred verdict.
 *
 * Uncompressed side, at the exact byte that crosses the limit, after the bytes before it were yielded:
 * `SNAP_RATIO_EXCEEDED` past max(`ratioFloorBytes`, `maxRatio` × `compressedSize`) bytes, `SNAP_TOTAL_TOO_LARGE` past
 * `maxTotalBytes` (the ratio wins when both limits fall on the same byte).
 */
export async function* inflate(
  source: AsyncIterable<Uint8Array>,
  limits: Readonly<Limits>,
  compressedSize: number,
  counters: Counters,
): AsyncGenerator<Uint8Array> {
  const walker = new ZstdFrameWalker();
  let verdict: SnapError | undefined;

  async function* frameBytes(): AsyncGenerator<Uint8Array> {
    const iterator = source[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        let next: IteratorResult<Uint8Array>;
        try {
          next = await iterator.next();
        } catch (error) {
          finished = true;
          throw new SourceError(error);
        }
        if (next.done) {
          finished = true;
          break;
        }
        const chunk = next.value;
        const allowed = Math.min(chunk.length, compressedSize - counters.compressed);
        try {
          walker.push(chunk.subarray(0, allowed));
        } catch (error) {
          verdict = error as SnapError;
          counters.compressed += walker.accepted;
          if (walker.accepted > 0) {
            yield chunk.subarray(0, walker.accepted);
          }
          return;
        }
        counters.compressed += allowed;
        if (allowed > 0) {
          yield chunk.subarray(0, allowed);
        }
        if (allowed < chunk.length) {
          verdict = new SnapError(
            "SNAP_FILE_TOO_LARGE",
            "the source is longer than its declared size",
          );
          return;
        }
      }
      try {
        walker.end();
      } catch (error) {
        verdict = error as SnapError;
        return;
      }
      if (counters.compressed < compressedSize) {
        verdict = new SnapError("SNAP_TRUNCATED", "the source is shorter than its declared size");
      }
    } finally {
      if (!finished) {
        await iterator.return?.();
      }
    }
  }

  const ratioLimit = Math.max(limits.ratioFloorBytes, limits.maxRatio * compressedSize);
  const limit = Math.min(ratioLimit, limits.maxTotalBytes);
  const limitError = () =>
    ratioLimit <= limits.maxTotalBytes
      ? new SnapError("SNAP_RATIO_EXCEEDED", "the compression ratio is above maxRatio")
      : new SnapError("SNAP_TOTAL_TOO_LARGE", "the uncompressed archive is too large");

  const input = Readable.from(frameBytes(), { objectMode: false });
  const decompressor = createZstdDecompress({
    params: { [constants.ZSTD_d_windowLogMax]: 27 },
  });
  input.on("error", (error) => decompressor.destroy(error));
  input.pipe(decompressor);
  try {
    for await (const out of decompressor as AsyncIterable<Buffer>) {
      const room = limit - counters.uncompressed;
      if (out.length > room) {
        // The bytes before the limit are checked first; the limit fails at its own byte.
        if (room > 0) {
          counters.uncompressed += room;
          yield new Uint8Array(out.buffer, out.byteOffset, room);
        }
        throw limitError();
      }
      counters.uncompressed += out.length;
      yield new Uint8Array(out.buffer, out.byteOffset, out.length);
    }
  } catch (error) {
    if (error instanceof SourceError) {
      throw error.original;
    }
    if (error instanceof SnapError) {
      throw error;
    }
    // zlib reports corrupt data and a wrong content checksum (`ZSTD_error_checksum_wrong`) as stream errors.
    throw new SnapError("SNAP_ZSTD_INVALID", "the zstd data is corrupt");
  } finally {
    input.destroy();
    decompressor.destroy();
  }
  if (verdict !== undefined) {
    throw verdict;
  }
}
