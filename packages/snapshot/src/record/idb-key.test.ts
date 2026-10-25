import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../../test/notation.js";
import { ExportError, SnapError } from "../errors.js";
import { type CborItem, decodeSequence, encodeItem } from "./cbor.js";
import { compareIdbKeys, type IdbKey, keyFromItem, keyToItem } from "./idb-key.js";

const bin = (...bytes: number[]) => new Uint8Array(bytes).buffer;
const sorted = (keys: IdbKey[]) => [...keys].sort(compareIdbKeys);

describe("compareIdbKeys (W3C IndexedDB, compare two keys)", () => {
  it("orders the types number < Date < string < binary < array", () => {
    const ordered: IdbKey[] = [Infinity, new Date(-1), "", bin(), []];
    for (const shuffled of [
      [...ordered].reverse(),
      [ordered[2], ordered[0], ordered[4], ordered[1], ordered[3]],
    ]) {
      expect(sorted(shuffled as IdbKey[])).toEqual(ordered);
    }
  });

  it("orders numbers and Dates by value, -0 equal to 0", () => {
    expect(sorted([1, -Infinity, 0, -1, Infinity])).toEqual([-Infinity, -1, 0, 1, Infinity]);
    expect(compareIdbKeys(-0, 0)).toBe(0);
    expect(compareIdbKeys(new Date(5), new Date(4))).toBe(1);
    expect(compareIdbKeys(new Date(5), new Date(5))).toBe(0);
  });

  it("orders strings by UTF-16 code units, not by UTF-8 bytes", () => {
    // U+10000 is d800 dc00 in UTF-16, so it sorts before U+FFFF; in UTF-8 it would sort after.
    expect(compareIdbKeys("\u{10000}", "￿")).toBe(-1);
    expect(sorted(["b", "a", "ab", ""])).toEqual(["", "a", "ab", "b"]);
  });

  it("orders binary keys bytewise unsigned, then by length, views by their bytes", () => {
    expect(compareIdbKeys(bin(0x7f), bin(0x80))).toBe(-1);
    expect(compareIdbKeys(bin(1), bin(1, 0))).toBe(-1);
    expect(compareIdbKeys(bin(1, 0), bin(2))).toBe(-1);
    expect(compareIdbKeys(new Uint8Array([9, 1, 2]).subarray(1), bin(1, 2))).toBe(0);
  });

  it("orders arrays element by element, then by length", () => {
    expect(compareIdbKeys([1, "a"], [1, "b"])).toBe(-1);
    expect(compareIdbKeys([1], [1, 1])).toBe(-1);
    expect(compareIdbKeys([], [0])).toBe(-1);
    expect(compareIdbKeys(["a"], [1, 2])).toBe(1);
    expect(compareIdbKeys([[1]], [[1]])).toBe(0);
  });

  it("throws on values that are not keys", () => {
    for (const bad of [Number.NaN, new Date(Number.NaN), null, undefined, {}, true, [Number.NaN]]) {
      expect(() => compareIdbKeys(bad as IdbKey, bad as IdbKey), String(bad)).toThrow(TypeError);
    }
  });
});

describe("keyToItem and keyFromItem", () => {
  it("round-trips every key type through CBOR", () => {
    const keys: IdbKey[] = [
      -0.5,
      7,
      new Date(1_700_000_000_000),
      "\ud800",
      bin(1, 2),
      [1, ["x", bin()]],
    ];
    for (const key of keys) {
      const [item] = decodeSequence(encodeItem(keyToItem(key)));
      expect(compareIdbKeys(keyFromItem(item as CborItem), key)).toBe(0);
    }
    const back = keyFromItem(keyToItem(new Uint8Array([3, 4]).subarray(1)));
    expect(back).toBeInstanceOf(ArrayBuffer);
    expect(bytesToHex(new Uint8Array(back as ArrayBuffer))).toBe("04");
  });

  it("refuses a JS value that is not a key with EXP_UNSUPPORTED_VALUE and its path", () => {
    let error: unknown;
    try {
      keyToItem([1, [Number.NaN]]);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ExportError);
    expect([(error as ExportError).code, (error as ExportError).detail.path]).toEqual([
      "EXP_UNSUPPORTED_VALUE",
      [1, 0],
    ]);
  });

  it("refuses an item that is not a key with SNAP_RECORD_INVALID", () => {
    for (const hex of [
      "f97e00",
      "d98150f97e00",
      "d9814d80",
      "f6",
      "f5",
      "a0",
      "d9814f8102",
      "82f97e0001",
    ]) {
      const [item] = decodeSequence(hexToBytes(hex));
      expect(() => keyFromItem(item as CborItem), hex).toThrow(SnapError);
    }
  });
});
