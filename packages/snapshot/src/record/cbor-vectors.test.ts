// Hand-written CBOR vectors (plan M11): test-vectors/cbor-v1.json. Every hex value was written by hand from RFC 8949
// (head = major type in the top 3 bits, additional information in the low 5 bits: 0-23 inline, 24/25/26/27 = 1/2/4/8
// argument bytes) and the tags of snapshot-format.md section 6.3, never by running the encoder. Float bit patterns
// and ASCII bytes were cross-checked with DataView and `xxd`, which are independent of this codec.
//
// Integers (major 0 = 0x00, major 1 = 0x20; a negative n is encoded as -1 - n):
//   uint-0 00 | uint-23 17 (inline) | uint-24 18 18 | uint-255 18 ff | uint-256 19 0100 | uint-65535 19 ffff
//   uint-65536 1a 00010000 | uint-2p32 1b 0000000100000000 | uint-max-safe 1b 001fffffffffffff (2^53 - 1)
//   nint-1 20 (arg 0) | nint-24 37 (arg 23) | nint-25 38 18 (arg 24) | nint-min-safe 3b 001ffffffffffffe (arg 2^53 - 2)
// Floats (major 7: f9 = binary16, fa = binary32, fb = binary64; shortest exact width):
//   float-neg-zero f9 8000 (sign bit only) | float-nan f9 7e00 (the one NaN) | float-1.5 f9 3e00 (exp 01111, mant 1000000000)
//   float-inf f9 7c00 | float-neg-inf f9 fc00 | float-f16-min-subnormal f9 0001 (2^-24)
//   float-f16-1023.5 f9 63ff (exp 9 + 15 = 11000, mant 1111111111)
//   float-f32-100000.5 fa 47c35040 (18 significant bits: too many for binary16, exact in binary32; 100000 is 47c35000,
//     plus 0.5 = 2^6 ulps at exponent 16 = 0x40) | float-f32-2p53 fa 5a000000 (2^53 is not a safe integer: a float)
//   float-f32-2pm25 fa 33000000 (2^-25 is below the binary16 subnormals) | float-f64-0.1 fb 3fb999999999999a
// Simple values: simple-false f4 | simple-true f5 | simple-null f6 | simple-undefined f7
// Text (major 3 = 0x60 + byte length):
//   text-empty 60 | text-a 61 61 | text-u-umlaut 62 c3bc | text-bom 63 efbbbf (U+FEFF is kept, never stripped)
//   text-emoji 64 f09f9880 (U+1F600) | text-24-bytes 78 18 then 24 x 61
// Lone surrogates (tag 33102 = 0x814e, head d9 814e; content a byte string of UTF-16LE code units):
//   str16-lone-high d9 814e 42 00d8 | str16-reversed-pair d9 814e 44 00dc 00d8 (U+DC00 then U+D800)
// BigInt (tag 33105 = d9 8151, text): bigint-0 d9 8151 61 30 | bigint-neg d9 8151 64 2d313233 ("-123")
//   bigint-2p64 d9 8151 74 (20 bytes) 3138343436373434303733373039353531363136 ("18446744073709551616")
// Arrays (major 4 = 0x80 + count): array-empty 80 | array-two 82 01 6161 | array-nested 81 80 | array-undefined 81 f7
// Plain objects (tag 33101 = d9 814d, array of key, value, ...):
//   object-empty d9 814d 80 | object-a d9 814d 82 6161 01
//   object-index-first d9 814d 84 6131 02 6162 01 (index keys enumerate first: "1" then "b")
//   object-proto-key d9 814d 82 69 5f5f70726f746f5f5f 01 ("__proto__" as an own property)
// Sparse arrays (tag 33103 = d9 814f, array [length, key, value, ...]):
//   sparse-hole d9 814f 83 03 6130 01 ([1, , ,]) | sparse-extra d9 814f 85 01 6130 01 6178 02 ([1] with x = 2)
//   sparse-empty-length-2 d9 814f 81 02 (new Array(2))
// Dates (tag 33104 = d9 8150, time value): date-0 d9 8150 00 | date-neg d9 8150 20 | date-invalid d9 8150 f9 7e00
// Map (tag 33106 = d9 8152): map-one d9 8152 82 01 6161 | map-empty d9 8152 80
// Set (tag 33107 = d9 8153): set-one d9 8153 81 01 | set-insertion-order d9 8153 82 6162 6161
// Boxed (tag 33108 = d9 8154, array [primitive]): boxed-false d9 8154 81 f4 | boxed-neg-zero d9 8154 81 f9 8000
//   boxed-string d9 8154 81 6161 | boxed-bigint d9 8154 81 d9 8151 6131
// RegExp (tag 21066 = d9 524a, array [source, flags]): regexp-g d9 524a 82 6161 6167
//   regexp-empty d9 524a 82 64 283f3a29 60 (source "(?:)", flags "")
// ArrayBuffer (major 2 = 0x40 + length): bytes-empty 40 | bytes-three 43 010203
// Typed arrays (RFC 8746 tags, d8 + one byte; content the little-endian bytes):
//   view-uint8 d8 40 42 0102 | view-uint8-empty d8 40 40 | view-uint8-clamped d8 44 41 ff | view-int8 d8 48 41 ff
//   view-uint16 d8 45 42 0100 (1) | view-int16 d8 4d 42 feff (-2) | view-uint32 d8 46 44 01000000
//   view-int32 d8 4e 44 ffffffff | view-biguint64 d8 47 48 0100000000000000 | view-bigint64 d8 4f 48 ffffffffffffffff
//   view-float16 d8 54 42 003e | view-float32 d8 55 44 0000c03f | view-float64 d8 56 48 000000000000f83f (all 1.5)
//   view-dataview d9 8155 42 abcd (tag 33109)
// Partial views (tag 33110 = d9 8156, array [viewTag, bufferBytes, byteOffset, length]):
//   view-partial-uint8 d9 8156 84 1840 (64) 44 01020304 01 02
//   view-partial-uint16 d9 8156 84 1845 (69) 44 00000100 02 01 (one element at byte 2)
//   view-partial-dataview d9 8156 84 19 8155 (33109) 42 0102 01 01
// Blob (tag 33111 = d9 8157, [type, size, sha256]) and File (tag 33112 = d9 8158, [name, lastModified, type, size,
// sha256]); the hash is a 64-character text string, head 78 40:
//   blob-empty d9 8157 83 60 00 7840 "e3b0c442...b855" (SHA-256 of no bytes)
//   blob-text-hi d9 8157 83 6a 746578742f706c61696e ("text/plain") 02 7840 "8f434346...7aa4" (SHA-256 of "hi")
//   file-empty d9 8158 85 65 612e747874 ("a.txt") 00 60 00 7840 "e3b0c442...b855"
// Invalid (each is rejected by the decoder or by the value check with SNAP_RECORD_INVALID):
//   inv-head-23-in-1-byte 18 17 and inv-head-255-in-2-bytes 19 00ff: argument not in its shortest head
//   inv-length-not-shortest 58 01 61: byte-string length 1 in a 1-byte argument | inv-tag-not-shortest d9 0040 40
//   inv-f32-fits-f16 fa 3fc00000 (1.5) | inv-f64-fits-f32 fb 40f86a0800000000 (100000.5)
//   inv-f16-integer-1 f9 3c00 | inv-f64-integer-2 fb 4000000000000000 | inv-f64-max-safe-integer fb 433fffffffffffff
//   inv-nan-payload f9 7e01 | inv-nan-negative f9 fe00 | inv-nan-f32 fa 7fc00000 | inv-nan-f64 fb 7ff8000000000000
//   inv-uint-2p53 1b 0020000000000000 | inv-nint-minus-2p53 3b 001fffffffffffff (-2^53): above 2^53 - 1
//   inv-reserved-info 1c (info 28) | inv-indefinite-array 9f ff | inv-indefinite-bytes 5f ff | inv-break ff
//   inv-simple-16 f0 | inv-simple-32 f8 20 | inv-truncated-bytes 42 01 | inv-truncated-head 19 01
//   inv-utf8-invalid-byte 61 ff | inv-utf8-surrogate 63 eda080 (U+D800 in UTF-8) | inv-utf8-overlong 62 c0af
//   inv-map-unsorted a2 6162 01 6161 01 | inv-map-duplicate-key a2 6161 01 6161 02 | inv-map-integer-key a1 01 01
//   inv-map-as-value a0 (maps only in envelopes) | inv-tag-33199 d9 81af 00 | inv-tag-0 c0 6161
//   inv-tag-in-tag d9 814d d9 814d 80 | inv-str16-well-formed d9 814e 42 6100 ("a") | inv-str16-odd-length d9 814e 41 00
//   inv-bigint-leading-zero d9 8151 62 3031 | inv-bigint-minus-zero d9 8151 62 2d30 | inv-bigint-plus d9 8151 62 2b31
//   inv-date-fraction d9 8150 f9 3e00 | inv-date-out-of-range d9 8150 1b 001eb208c2dc0001 (8.64e15 + 1)
//   inv-object-key-order d9 814d 84 6162 01 6131 02 ("b" before "1") | inv-object-duplicate-key d9 814d 84 6161 01 6161 02
//   inv-object-odd-items d9 814d 81 6161 | inv-object-integer-key d9 814d 82 01 01
//   inv-sparse-dense d9 814f 83 01 6130 01 (a dense [1]) | inv-sparse-index-out-of-range d9 814f 83 01 6131 01
//   inv-sparse-length-key d9 814f 83 01 66 6c656e677468 01 | inv-set-neg-zero d9 8153 81 f9 8000 (a Set holds +0)
//   inv-set-duplicate d9 8153 82 01 01 | inv-map-value-duplicate-key d9 8152 84 01 01 01 02 | inv-boxed-null d9 8154 81 f6
//   inv-regexp-flag-order d9 524a 82 6161 62 6967 ("ig") | inv-regexp-duplicate-flag d9 524a 82 6161 62 6767 ("gg")
//   inv-regexp-flags-u-and-v d9 524a 82 6161 62 7576 ("uv"); the source is never checked (engine-neutral)
//   inv-typed-array-misaligned d8 46 42 0100 (2 bytes of Uint32Array)
//   inv-view-whole-as-partial d9 8156 84 1840 42 0102 00 02 | inv-view-out-of-range d9 8156 84 1840 42 0102 01 02
//   inv-view-misaligned-offset d9 8156 84 1845 44 00000000 01 01 | inv-view-unknown-view-tag d9 8156 84 1841 42 0102 00 01
//   inv-blob-bad-hash d9 8157 83 60 00 6161 | inv-blob-uppercase-type d9 8157 83 6141 ("A") 00 7840 "e3b0...b855"
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  hexToBytes,
  itemToNotation,
  type Notation,
  notationToItem,
  notationToValue,
} from "../../test/notation.js";
import { SnapError } from "../errors.js";
import { type CborItem, decodeSequence, encodeItem } from "./cbor.js";
import { fromItem } from "./value-build.js";
import { checkValueItem } from "./value-check.js";
import { toItem } from "./value-export.js";

interface Vector {
  id: string;
  value?: Notation;
  hex: string;
  ok: boolean;
  error?: string;
}

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL("../../test-vectors/cbor-v1.json", import.meta.url), "utf8"),
);
const valid = vectors.filter((v) => v.ok);
const invalid = vectors.filter((v) => !v.ok);
const blobBytes = new Map<string, Uint8Array>();
const onBlob = (sha256: string, bytes: Uint8Array) => {
  blobBytes.set(sha256, bytes);
};
const blobOf = (sha256: string): Blob => new Blob([blobBytes.get(sha256) ?? new Uint8Array()]);
const bytesOf = (sha256: string): Uint8Array => {
  const bytes = blobBytes.get(sha256);
  if (bytes === undefined) {
    throw new Error(`no blob ${sha256}`);
  }
  return bytes;
};

function decodeOne(hex: string): CborItem {
  const items = decodeSequence(hexToBytes(hex));
  expect(items).toHaveLength(1);
  const item = items[0] as CborItem;
  checkValueItem(item, new Map());
  return item;
}

describe("cbor-v1.json hand vectors", () => {
  it("has unique ids and the minimum set of the plan", () => {
    const ids = vectors.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hexOf = (id: string) => vectors.find((v) => v.id === id)?.hex;
    expect(hexOf("float-neg-zero")).toBe("f98000");
    expect(hexOf("float-nan")).toBe("f97e00");
    expect(hexOf("float-1.5")).toBe("f93e00");
    expect(hexOf("uint-max-safe")).toBe("1b001fffffffffffff");
    expect(hexOf("object-a")).toBe("d9814d82616101");
    expect(hexOf("view-uint8")).toBe("d840420102");
    expect(hexOf("inv-head-23-in-1-byte")).toBe("1817");
    expect(hexOf("inv-f32-fits-f16")).toBe("fa3fc00000");
    expect(hexOf("inv-f16-integer-1")).toBe("f93c00");
    expect(hexOf("inv-map-unsorted")).toBe("a2616201616101");
    expect(hexOf("inv-tag-33199")?.startsWith("d981af")).toBe(true);
  });

  describe.each(valid)("valid $id", (vector) => {
    const value = vector.value as Notation;

    it("JS value -> item -> bytes gives the hex", async () => {
      const item = await toItem(notationToValue(value), { onBlob });
      expect(bytesToHex(encodeItem(item))).toBe(vector.hex);
    });

    it("notation item -> bytes gives the hex", () => {
      expect(bytesToHex(encodeItem(notationToItem(value)))).toBe(vector.hex);
    });

    it("bytes -> item passes the value check and reads back as the notation", async () => {
      await toItem(notationToValue(value), { onBlob });
      expect(itemToNotation(decodeOne(vector.hex), bytesOf)).toEqual(value);
    });

    it("bytes -> JS value -> bytes is the identity", async () => {
      await toItem(notationToValue(value), { onBlob });
      const again = await toItem(fromItem(decodeOne(vector.hex), blobOf), { onBlob });
      expect(bytesToHex(encodeItem(again))).toBe(vector.hex);
    });
  });

  it.each(invalid)("invalid $id is SNAP_RECORD_INVALID", (vector) => {
    expect(vector.error).toBe("SNAP_RECORD_INVALID");
    let thrown: unknown;
    try {
      decodeOne(vector.hex);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SnapError);
    expect((thrown as SnapError).code).toBe("SNAP_RECORD_INVALID");
  });
});
