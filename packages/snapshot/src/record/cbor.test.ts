import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../../test/notation.js";
import { SnapError } from "../errors.js";
import { type CborItem, decodeSequence, encodeItem, MAX_DEPTH } from "./cbor.js";

const text = (v: string): CborItem => ({ k: "text", v });
const uint = (v: number): CborItem => ({ k: "uint", v });
const hex = (item: CborItem) => bytesToHex(encodeItem(item));

function nestedArrays(levels: number): Uint8Array {
  // `levels` arrays of one element, innermost empty: 81 81 ... 80.
  return new Uint8Array([...new Array<number>(levels - 1).fill(0x81), 0x80]);
}

function decodeError(bytes: Uint8Array, maxDepth?: number): SnapError {
  try {
    decodeSequence(bytes, maxDepth === undefined ? {} : { maxDepth });
  } catch (error) {
    if (error instanceof SnapError) {
      return error;
    }
    throw error;
  }
  throw new Error("decoded without error");
}

describe("encodeItem", () => {
  it("sorts map keys by their encoded bytes, so a shorter key comes first", () => {
    // "b" is 61 62 and "aa" is 62 61 61: the head (length) decides before the content.
    const item: CborItem = {
      k: "map",
      v: [
        ["aa", uint(1)],
        ["b", uint(2)],
      ],
    };
    expect(hex(item)).toBe("a2616202626161 01".replace(" ", ""));
  });

  it("refuses items that a conforming writer never produces", () => {
    const bad: CborItem[] = [
      {
        k: "map",
        v: [
          ["a", uint(1)],
          ["a", uint(2)],
        ],
      },
      { k: "float", v: 1 },
      { k: "uint", v: -1 },
      { k: "uint", v: 2 ** 53 },
      { k: "nint", v: 0 },
      { k: "nint", v: -(2 ** 53) },
      { k: "text", v: "\ud800" },
      { k: "tag", tag: 33199, v: uint(0) },
      { k: "tag", tag: 33101, v: { k: "tag", tag: 33101, v: { k: "array", v: [] } } },
    ];
    for (const item of bad) {
      expect(() => encodeItem(item), JSON.stringify(item.k)).toThrow(TypeError);
    }
  });

  it("writes the 2- and 4-byte integer heads at their boundaries", () => {
    expect(hex(uint(65535))).toBe("19ffff");
    expect(hex(uint(4294967295))).toBe("1affffffff");
    expect(hex({ k: "nint", v: -4294967297 })).toBe("3b0000000100000000");
  });
});

describe("decodeSequence", () => {
  it("reads a CBOR sequence of several items and an empty sequence", () => {
    expect(decodeSequence(hexToBytes("016161f6"))).toEqual([
      uint(1),
      text("a"),
      { k: "simple", v: null },
    ]);
    expect(decodeSequence(new Uint8Array())).toEqual([]);
  });

  it("copies byte strings out of the input", () => {
    const input = hexToBytes("420102");
    const [item] = decodeSequence(input);
    input[1] = 9;
    expect(item).toEqual({ k: "bytes", v: new Uint8Array([1, 2]) });
  });

  it("accepts a sorted map with text keys", () => {
    expect(decodeSequence(hexToBytes("a2616202626161 01".replace(" ", "")))).toEqual([
      {
        k: "map",
        v: [
          ["b", uint(2)],
          ["aa", uint(1)],
        ],
      },
    ]);
  });

  it("allows maxDepth (256) nested containers and rejects one more", () => {
    expect(MAX_DEPTH).toBe(256);
    // The outermost array is at depth 0, so 257 arrays reach depth 256.
    expect(decodeSequence(nestedArrays(257))).toHaveLength(1);
    expect(decodeError(nestedArrays(258)).code).toBe("SNAP_RECORD_INVALID");
    expect(decodeError(nestedArrays(4), 2).code).toBe("SNAP_RECORD_INVALID");
  });

  it("does not count tags as depth but refuses a tag whose content is a tag", () => {
    // 257 arrays, each wrapped in tag 33101: still depth 256.
    const wrapped: number[] = [];
    for (let i = 0; i < 256; i++) {
      wrapped.push(0xd9, 0x81, 0x4d, 0x81);
    }
    wrapped.push(0x80);
    expect(decodeSequence(new Uint8Array(wrapped))).toHaveLength(1);
    expect(decodeError(hexToBytes("d9814dd9814d80")).code).toBe("SNAP_RECORD_INVALID");
  });

  it("rejects a count that cannot fit in the remaining bytes before allocating", () => {
    expect(decodeError(hexToBytes("9b001fffffffffffff")).code).toBe("SNAP_RECORD_INVALID");
    expect(decodeError(hexToBytes("5b001fffffffffffff")).code).toBe("SNAP_RECORD_INVALID");
  });

  it("names the byte offset, never the data", () => {
    const error = decodeError(hexToBytes("6161 61ff".replace(" ", "")));
    expect(error.message).toMatch(/offset 2/);
    expect(error.message).not.toMatch(/0xff|\u00ff/);
  });
});
