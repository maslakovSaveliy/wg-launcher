import { constants, zstdCompressSync } from "node:zlib";
import type { SnapCode } from "@wg-launcher/shared";
import { describe, expect, it } from "vitest";
import { SnapError } from "../errors.js";
import { ZstdFrameWalker } from "./zstd-frame.js";

// Real frames from Node's zstd (RFC 8878 section 3.1.1). `zstdCompressSync` writes a single-segment frame with the
// content size; the streaming compressor writes a window descriptor instead (both shapes are walked below).
const content = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 251);
const withChecksum = new Uint8Array(
  zstdCompressSync(content, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
);
const withoutChecksum = new Uint8Array(zstdCompressSync(content));

/** Feeds `bytes` in chunks of `size` and ends the input; returns the bytes the walker passed through. */
function walk(bytes: Uint8Array, size = bytes.length || 1): Uint8Array {
  const walker = new ZstdFrameWalker();
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    parts.push(walker.push(bytes.subarray(at, at + size)));
  }
  walker.end();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function codeOf(run: () => unknown): SnapCode | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof SnapError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A frame header descriptor byte replaced, the rest of the frame unchanged. */
function withDescriptor(frame: Uint8Array, fhd: number): Uint8Array {
  const out = frame.slice();
  out[4] = fhd;
  return out;
}

describe("ZstdFrameWalker", () => {
  it("passes a whole checksummed frame through unchanged, in any chunking", () => {
    expect(walk(withChecksum)).toEqual(withChecksum);
    expect(walk(withChecksum, 1)).toEqual(withChecksum);
    expect(walk(withChecksum, 7)).toEqual(withChecksum);
  });

  it("walks a streaming frame that carries a window descriptor (no content size)", () => {
    // 28b52ffd, descriptor 0x04 (checksum only), window descriptor 0x58 (2^21), then blocks: hand-built from one Raw
    // last block of 3 bytes and a 4-byte checksum. The walker checks structure only; the checksum value is zstd's.
    const frame = Uint8Array.from([
      0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58, 0x19, 0x00, 0x00, 0x61, 0x62, 0x63, 1, 2, 3, 4,
    ]);
    expect(walk(frame)).toEqual(frame);
  });

  it("walks RLE blocks as one content byte", () => {
    // Block header 0x000a03: last block, type RLE (1), size 1: bits 0 = 1, bits 1-2 = 01, size 1 << 3.
    const frame = Uint8Array.from([
      0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58, 0x0b, 0x00, 0x00, 0x7a, 9, 9, 9, 9,
    ]);
    expect(walk(frame)).toEqual(frame);
  });

  it("refuses a frame without the content checksum flag", () => {
    expect(codeOf(() => walk(withoutChecksum))).toBe("SNAP_ZSTD_NO_CHECKSUM");
  });

  it.each([
    ["1 byte", 1],
    ["half", Math.floor(withChecksum.length / 2)],
    ["length - 1 bytes", withChecksum.length - 1],
    ["the header only", 6],
    ["everything but the checksum", withChecksum.length - 4],
  ])("reports SNAP_TRUNCATED for a frame cut to %s", (_, length) => {
    expect(codeOf(() => walk(withChecksum.subarray(0, length)))).toBe("SNAP_TRUNCATED");
    expect(codeOf(() => walk(withChecksum.subarray(0, length), 3))).toBe("SNAP_TRUNCATED");
  });

  it("reports SNAP_TRUNCATED for empty input", () => {
    expect(codeOf(() => walk(new Uint8Array(0)))).toBe("SNAP_TRUNCATED");
  });

  it("refuses bytes that are not a zstd frame as soon as the magic differs", () => {
    const walker = new ZstdFrameWalker();
    expect(codeOf(() => walker.push(Uint8Array.from([0x28, 0xb5, 0x00])))).toBe(
      "SNAP_ZSTD_INVALID",
    );
    expect(codeOf(() => walk(new TextEncoder().encode("not zstd at all")))).toBe(
      "SNAP_ZSTD_INVALID",
    );
  });

  it("refuses a skippable frame first, for all 16 magic numbers", () => {
    for (let nibble = 0; nibble < 16; nibble++) {
      const skippable = Uint8Array.from([0x50 + nibble, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
      expect(codeOf(() => walk(concat(skippable, withChecksum)))).toBe("SNAP_ZSTD_INVALID");
    }
  });

  it("refuses a second frame and a byte appended after the frame", () => {
    expect(codeOf(() => walk(concat(withChecksum, withChecksum)))).toBe("SNAP_TRAILING_DATA");
    expect(codeOf(() => walk(concat(withChecksum, Uint8Array.of(0))))).toBe("SNAP_TRAILING_DATA");
    expect(codeOf(() => walk(concat(withChecksum, Uint8Array.of(0)), 1))).toBe(
      "SNAP_TRAILING_DATA",
    );
  });

  it("refuses the reserved descriptor bit and a dictionary id", () => {
    const fhd = withChecksum[4] as number;
    expect(codeOf(() => walk(withDescriptor(withChecksum, fhd | 0x08)))).toBe("SNAP_ZSTD_INVALID");
    for (const flag of [1, 2, 3]) {
      expect(codeOf(() => walk(withDescriptor(withChecksum, fhd | flag)))).toBe(
        "SNAP_ZSTD_INVALID",
      );
    }
  });

  it("checks the reserved bit, then the dictionary id, then the checksum flag", () => {
    // 0x08 reserved set, dictionary flag 1, no checksum: the reserved bit wins; then dictionary over no checksum.
    expect(codeOf(() => walk(withDescriptor(withChecksum, 0x09)))).toBe("SNAP_ZSTD_INVALID");
    expect(codeOf(() => walk(withDescriptor(withChecksum, 0x01)))).toBe("SNAP_ZSTD_INVALID");
  });

  it("refuses a window above 2^27 and accepts exactly 2^27", () => {
    const frame = (windowDescriptor: number) =>
      Uint8Array.from([
        0x28,
        0xb5,
        0x2f,
        0xfd,
        0x04,
        windowDescriptor,
        0x19,
        0x00,
        0x00,
        0x61,
        0x62,
        0x63,
        1,
        2,
        3,
        4,
      ]);
    // windowLog = 10 + exponent (bits 7-3); 0x88 = exponent 17, mantissa 0: 2^27. 0x89 adds an eighth.
    expect(walk(frame(0x88))).toHaveLength(16);
    expect(codeOf(() => walk(frame(0x89)))).toBe("SNAP_ZSTD_INVALID");
    expect(codeOf(() => walk(frame(0x90)))).toBe("SNAP_ZSTD_INVALID");
  });

  it("refuses a single-segment frame whose content size, which is its window, is above 2^27", () => {
    // Descriptor 0xa4: content size flag 2 (4 bytes), single segment, checksum. 2^27 + 1 little endian.
    const frame = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0xa4, 0x01, 0x00, 0x00, 0x08]);
    expect(codeOf(() => walk(frame))).toBe("SNAP_ZSTD_INVALID");
  });

  it("refuses the reserved block type and a block above 128 KiB", () => {
    const head = [0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58];
    // Block header bits 1-2 = 3 (reserved): 0x07.
    expect(codeOf(() => walk(Uint8Array.from([...head, 0x07, 0x00, 0x00])))).toBe(
      "SNAP_ZSTD_INVALID",
    );
    // Raw block of 2^17 + 1 bytes: size << 3 = 0x100008, little endian 08 00 10.
    expect(codeOf(() => walk(Uint8Array.from([...head, 0x08, 0x00, 0x10])))).toBe(
      "SNAP_ZSTD_INVALID",
    );
  });

  it("tells how many bytes of the failing chunk came before the bad byte", () => {
    const walker = new ZstdFrameWalker();
    expect(codeOf(() => walker.push(concat(withChecksum, Uint8Array.of(9, 9))))).toBe(
      "SNAP_TRAILING_DATA",
    );
    expect(walker.accepted).toBe(withChecksum.length);
    const reserved = new ZstdFrameWalker();
    expect(codeOf(() => reserved.push(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x0c])))).toBe(
      "SNAP_ZSTD_INVALID",
    );
    expect(reserved.accepted).toBe(4);
  });

  it("keeps refusing after a failure and refuses input after end()", () => {
    const walker = new ZstdFrameWalker();
    walker.push(withChecksum);
    walker.end();
    expect(walker.done).toBe(true);
    expect(codeOf(() => walker.push(Uint8Array.of(1)))).toBe("SNAP_TRAILING_DATA");
  });
});
