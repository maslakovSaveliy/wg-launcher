import { Transform } from "node:stream";
import { describe, expect, it } from "vitest";
import { chunks, codeOfAsync, concat, zstd } from "../../test/wgsnap.js";
import { type Decompressor, inflate, zstdDecompressor } from "./inflate.js";
import { resolveLimits } from "./limits.js";

// The rule of snapshot-format.md section 2: the code must not depend on the zstd library. Node 24.13.0 ends a cut
// frame silently, Node 24.22.1 fails it with "unexpected end of file"; a later Rust codec may fail even earlier. These
// fakes pin both extremes, so the precedence rule is tested on any Node version.

/** Wraps a Transform with zlib's mid-stream `flush`: an empty write that calls back once all earlier bytes are done. */
function asDecompressor(transform: Transform): Decompressor {
  return Object.assign(transform, {
    flush(callback: () => void) {
      transform.write(new Uint8Array(0), () => callback());
    },
  });
}

/** A decompressor that rejects a prefix: it fails once it has seen more than `after` bytes, and at the end. */
const rejecting = (after: number) => (): Decompressor => {
  let seen = 0;
  const fail = () => new Error("unexpected end of file");
  return asDecompressor(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;
        callback(seen > after ? fail() : null);
      },
      flush(callback) {
        callback(fail());
      },
    }),
  );
};

/** A decompressor that never fails and never emits: it just waits for more input. */
const silent = (): Decompressor =>
  asDecompressor(
    new Transform({
      transform(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );

/** A stand-in for a library that fails a cut frame at its end: it echoes its input, then fails when ended. */
const echoingThenRejecting = (): Decompressor =>
  asDecompressor(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        callback(null, chunk);
      },
      flush(callback) {
        callback(new Error("unexpected end of file"));
      },
    }),
  );

const frame = zstd(new Uint8Array(20_000).map((_, i) => (i * 7919) % 251));
const noChecksum = zstd(frame, false);
const decompressors = {
  "Node's own": zstdDecompressor,
  "rejecting at the first byte": rejecting(0),
  "rejecting halfway": rejecting(frame.length >> 1),
  silent,
};

async function codeOfInflate(
  bytes: Uint8Array,
  size: number,
  createDecompressor: () => Decompressor,
  compressedSize = bytes.length,
) {
  const counters = { compressed: 0, uncompressed: 0 };
  return codeOfAsync(async () => {
    for await (const _ of inflate(
      chunks(bytes, size),
      resolveLimits({}),
      compressedSize,
      counters,
      createDecompressor,
    )) {
      // Only the verdict matters here.
    }
  });
}

describe("inflate: frame-walker verdicts win over decompressor errors", () => {
  const descriptor = (bits: number) => {
    const bytes = frame.slice();
    bytes[4] = (bytes[4] as number) | bits;
    return bytes;
  };
  const cases: [string, Uint8Array, number, string][] = [
    ["cut by one byte", frame.subarray(0, frame.length - 1), frame.length - 1, "SNAP_TRUNCATED"],
    ["cut to one byte", frame.subarray(0, 1), 1, "SNAP_TRUNCATED"],
    ["without the checksum flag", noChecksum, noChecksum.length, "SNAP_ZSTD_NO_CHECKSUM"],
    ["with a dictionary id flag", descriptor(0x01), frame.length, "SNAP_ZSTD_INVALID"],
    ["followed by a byte", concat(frame, Uint8Array.of(1)), frame.length + 1, "SNAP_TRAILING_DATA"],
    ["followed by a second frame", concat(frame, frame), 2 * frame.length, "SNAP_TRAILING_DATA"],
    ["longer than declared", frame, frame.length - 1, "SNAP_FILE_TOO_LARGE"],
    ["shorter than declared", frame, frame.length + 10, "SNAP_TRUNCATED"],
  ];

  for (const [name, create] of Object.entries(decompressors)) {
    it.each(cases)(
      `a frame %s gives the walker's code with ${name} decompressor`,
      async (_, bytes, declared, code) => {
        for (const size of [1, 64, Number.MAX_SAFE_INTEGER]) {
          expect(await codeOfInflate(bytes, size, create, declared), `${size}-byte chunks`).toBe(
            code,
          );
        }
      },
    );
  }

  it("reports SNAP_ZSTD_INVALID only when the walker saw a complete, valid frame", async () => {
    for (const size of [1, 64, Number.MAX_SAFE_INTEGER]) {
      expect(await codeOfInflate(frame, size, rejecting(0))).toBe("SNAP_ZSTD_INVALID");
      expect(await codeOfInflate(frame, size, rejecting(frame.length >> 1))).toBe(
        "SNAP_ZSTD_INVALID",
      );
      // At the end of a complete frame, a failure of the decompressor (here a wrong checksum) decides.
      expect(await codeOfInflate(frame, size, rejecting(frame.length))).toBe("SNAP_ZSTD_INVALID");
      expect(await codeOfInflate(frame, size, zstdDecompressor)).toBeUndefined();
    }
  });

  it("yields every byte before the walker's verdict, even from a library that fails a cut frame at its end", async () => {
    // Deferral rule D1: the tar reader must see all of them. A slow consumer leaves output buffered in the stream,
    // which ending (instead of flushing) the decompressor would discard when the library fails the prefix.
    for (const size of [1, 64, Number.MAX_SAFE_INTEGER]) {
      const cut = frame.subarray(0, frame.length - 1);
      const counters = { compressed: 0, uncompressed: 0 };
      let yielded = 0;
      const code = await codeOfAsync(async () => {
        for await (const out of inflate(
          chunks(cut, size),
          resolveLimits({}),
          cut.length,
          counters,
          echoingThenRejecting,
        )) {
          yielded += out.length;
          await new Promise((resolve) => setImmediate(resolve));
        }
      });
      expect(code, `${size}-byte chunks`).toBe("SNAP_TRUNCATED");
      expect(yielded, `${size}-byte chunks`).toBe(cut.length);
    }
  });

  it("keeps reading the source after the decompressor failed, and passes a source error through", async () => {
    const counters = { compressed: 0, uncompressed: 0 };
    const failure = new Error("disk gone");
    async function* failingSource() {
      yield frame.subarray(0, 100);
      throw failure;
    }
    await expect(
      (async () => {
        for await (const _ of inflate(
          failingSource(),
          resolveLimits({}),
          frame.length,
          counters,
          rejecting(0),
        )) {
          // Nothing comes out of a rejecting decompressor.
        }
      })(),
    ).rejects.toBe(failure);
  });
});
