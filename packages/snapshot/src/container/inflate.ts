// The container stage of the reader (snapshot-format.md sections 2 and 8): compressed bytes through the frame walker
// into Node's zstd decompressor, with the size and ratio limits checked continuously. Async throughout, so the
// snapshot worker stays responsive; backpressure keeps at most a few chunks in memory.
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
 * The decompressed tar stream.
 *
 * Compressed side: `SNAP_FILE_TOO_LARGE` and the frame walker's codes (`SNAP_ZSTD_INVALID`, `SNAP_ZSTD_NO_CHECKSUM`,
 * `SNAP_TRUNCATED`, `SNAP_TRAILING_DATA`). Such a verdict is deferred: reading stops at the bad byte, the bytes before
 * it are still decompressed and yielded, and the verdict is thrown where the stream would have ended. So a defect in
 * the frame content (which the tar reader finds) is reported before a later container defect, independently of
 * chunking and read-ahead, and a cut file never reaches the tar reader as a clean end: it is `SNAP_TRUNCATED`.
 * Decompressor errors (corrupt data, checksum mismatch) are `SNAP_ZSTD_INVALID`.
 *
 * Uncompressed side: `SNAP_RATIO_EXCEEDED` once past `ratioFloorBytes`, then `SNAP_TOTAL_TOO_LARGE`.
 */
export async function* inflate(
  source: AsyncIterable<Uint8Array>,
  limits: Readonly<Limits>,
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
        const allowed = Math.min(chunk.length, limits.maxFileBytes - counters.compressed);
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
          verdict = new SnapError("SNAP_FILE_TOO_LARGE", "the snapshot file is too large");
          return;
        }
      }
      try {
        walker.end();
      } catch (error) {
        verdict = error as SnapError;
      }
    } finally {
      if (!finished) {
        await iterator.return?.();
      }
    }
  }

  const input = Readable.from(frameBytes(), { objectMode: false });
  const decompressor = createZstdDecompress({
    params: { [constants.ZSTD_d_windowLogMax]: 27 },
  });
  input.on("error", (error) => decompressor.destroy(error));
  input.pipe(decompressor);
  try {
    for await (const out of decompressor as AsyncIterable<Buffer>) {
      counters.uncompressed += out.length;
      if (
        counters.uncompressed > limits.ratioFloorBytes &&
        counters.uncompressed / counters.compressed > limits.maxRatio
      ) {
        throw new SnapError("SNAP_RATIO_EXCEEDED", "the compression ratio is above maxRatio");
      }
      if (counters.uncompressed > limits.maxTotalBytes) {
        throw new SnapError("SNAP_TOTAL_TOO_LARGE", "the uncompressed archive is too large");
      }
      yield new Uint8Array(out.buffer, out.byteOffset, out.length);
    }
  } catch (error) {
    if (error instanceof SourceError) {
      throw error.original;
    }
    if (error instanceof SnapError) {
      throw error;
    }
    // A complete frame (the walker saw its end) is the decompressor's to judge; on a frame the walker cut short, the
    // walker's verdict wins, because the decompressor only saw a prefix.
    if (verdict !== undefined && verdict.code !== "SNAP_TRAILING_DATA") {
      throw verdict;
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
