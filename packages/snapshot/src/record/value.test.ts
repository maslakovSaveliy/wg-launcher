import { describe, expect, it } from "vitest";
import { bytesToHex, sha256Hex } from "../../test/notation.js";
import { ExportError, SnapError } from "../errors.js";
import { type CborItem, decodeSequence, encodeItem } from "./cbor.js";
import { type BlobRefs, checkValueItem, fromItem, toItem } from "./value.js";

interface Exported {
  item: CborItem;
  bytes: Uint8Array;
  blobs: Map<string, Uint8Array>;
  calls: string[];
}

async function exportValue(value: unknown, maxDepth?: number): Promise<Exported> {
  const blobs = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const onBlob = (sha256: string, bytes: Uint8Array) => {
    calls.push(sha256);
    blobs.set(sha256, bytes);
  };
  const item = await toItem(value, maxDepth === undefined ? { onBlob } : { onBlob, maxDepth });
  return { item, bytes: encodeItem(item), blobs, calls };
}

async function roundTrip(
  value: unknown,
): Promise<{ value: unknown; refs: BlobRefs; exported: Exported }> {
  const exported = await exportValue(value);
  const [decoded] = decodeSequence(exported.bytes);
  const refs: BlobRefs = new Map();
  checkValueItem(decoded as CborItem, refs);
  const back = fromItem(
    decoded as CborItem,
    (sha) => new Blob([exported.blobs.get(sha) ?? new Uint8Array()]),
  );
  // Re-exporting the decoded value gives the same bytes: the encoding is unique.
  expect(bytesToHex((await exportValue(back)).bytes)).toBe(bytesToHex(exported.bytes));
  return { value: back, refs, exported };
}

async function exportError(value: unknown, maxDepth?: number): Promise<ExportError> {
  try {
    await exportValue(value, maxDepth);
  } catch (error) {
    if (error instanceof ExportError) {
      return error;
    }
    throw error;
  }
  throw new Error("exported without error");
}

function nest(levels: number): unknown[] {
  let value: unknown[] = [];
  for (let i = 1; i < levels; i++) {
    value = [value];
  }
  return value;
}

describe("value model round trip (snapshot-format.md section 6.3)", () => {
  it("keeps primitives exactly, -0, NaN and lone surrogates included", async () => {
    const values = [
      undefined,
      null,
      true,
      false,
      0,
      -0,
      Number.NaN,
      Infinity,
      -Infinity,
      1.5,
      2 ** 53,
      -(2 ** 60),
    ];
    for (const v of values) {
      expect(Object.is((await roundTrip(v)).value, v), String(v)).toBe(true);
    }
    for (const s of ["", "plain", "﻿bom", "\ud800", "a\udc00b"]) {
      expect((await roundTrip(s)).value).toBe(s);
    }
    expect((await roundTrip(-(2n ** 70n) + 1n)).value).toBe(-(2n ** 70n) + 1n);
  });

  it("keeps valid and invalid Dates", async () => {
    const date = (await roundTrip(new Date(1_700_000_000_123))).value as Date;
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).toBe(1_700_000_000_123);
    expect(Number.isNaN(((await roundTrip(new Date(Number.NaN))).value as Date).getTime())).toBe(
      true,
    );
  });

  it("keeps Map and Set insertion order and key types", async () => {
    const map = new Map<unknown, unknown>([
      ["b", 1],
      [2, "two"],
      [{ k: 1 }, null],
      ["a", 3],
    ]);
    const back = (await roundTrip(map)).value as Map<unknown, unknown>;
    expect([...back.keys()]).toEqual(["b", 2, { k: 1 }, "a"]);
    expect([...back.values()]).toEqual([1, "two", null, 3]);
    const set = (await roundTrip(new Set(["z", 1, Number.NaN, "a"]))).value as Set<unknown>;
    expect([...set]).toEqual(["z", 1, Number.NaN, "a"]);
  });

  it("keeps holes, length and extra properties of a sparse array", async () => {
    const sparse: unknown[] & { extra?: string } = [1, 2, 3];
    delete sparse[1];
    sparse.length = 5;
    sparse.extra = "x";
    const back = (await roundTrip(sparse)).value as unknown[] & { extra?: string };
    expect(Array.isArray(back)).toBe(true);
    expect(back.length).toBe(5);
    expect(1 in back).toBe(false);
    expect(Object.keys(back)).toEqual(["0", "2", "extra"]);
    expect(back.extra).toBe("x");
    // A dense array with undefined is not sparse.
    const dense = (await roundTrip([undefined, 1])).exported.item;
    expect(dense.k).toBe("array");
  });

  it("keeps plain objects in enumeration order, __proto__ as an own key, and ignores symbols", async () => {
    const source: Record<string | symbol, unknown> = { b: 1, 2: "x", a: { nested: [1] } };
    Object.defineProperty(source, "__proto__", { value: 7, enumerable: true });
    Object.defineProperty(source, "hidden", { value: 1, enumerable: false });
    source[Symbol("s")] = 1; // structured clone copies only string-keyed own enumerable properties
    const back = (await roundTrip(source)).value as Record<string, unknown>;
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.keys(back)).toEqual(["2", "b", "a", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(back, "__proto__")?.value).toBe(7);
    expect(Object.getOwnPropertySymbols(back)).toEqual([]);
    expect((await roundTrip(Object.assign(Object.create(null), { a: 1 }))).value).toEqual({ a: 1 });
  });

  it("keeps boxed primitives", async () => {
    const boxed = [new Boolean(false), new Number(-0), new String("\ud800"), Object(5n)];
    for (const original of boxed) {
      const back = (await roundTrip(original)).value as { valueOf(): unknown };
      expect(typeof back).toBe("object");
      expect(Object.getPrototypeOf(back)).toBe(Object.getPrototypeOf(original));
      expect(Object.is(back.valueOf(), original.valueOf())).toBe(true);
    }
  });

  it("keeps RegExp source and every flag, not lastIndex", async () => {
    for (const re of [/a\/b.c/dgimsy, /x/v, /(?:)/]) {
      re.lastIndex = 3;
      const back = (await roundTrip(re)).value as RegExp;
      expect([back.source, back.flags, back.lastIndex]).toEqual([re.source, re.flags, 0]);
    }
  });

  it("keeps ArrayBuffer, every typed array and DataView", async () => {
    const buffer = (await roundTrip(new Uint8Array([1, 2, 3]).buffer)).value;
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buffer as ArrayBuffer)]).toEqual([1, 2, 3]);
    const views = [
      new Uint8Array([0, 255]),
      new Uint8ClampedArray([7, 255]),
      new Int8Array([-128, 127]),
      new Uint16Array([65535, 1]),
      new Int16Array([-32768]),
      new Uint32Array([4294967295]),
      new Int32Array([-1, 2]),
      new BigUint64Array([2n ** 64n - 1n]),
      new BigInt64Array([-(2n ** 63n)]),
      new Float16Array([1.5, -0]),
      new Float32Array([0.1]),
      new Float64Array([Math.PI, Number.NaN]),
    ];
    for (const view of views) {
      const back = (await roundTrip(view)).value as typeof view;
      expect(Object.getPrototypeOf(back)).toBe(Object.getPrototypeOf(view));
      expect(bytesToHex(new Uint8Array(back.buffer))).toBe(bytesToHex(new Uint8Array(view.buffer)));
    }
    const dataView = (await roundTrip(new DataView(new Uint8Array([9, 8]).buffer)))
      .value as DataView;
    expect([dataView.getUint8(0), dataView.byteLength]).toEqual([9, 2]);
  });

  it("keeps a partial view with its whole buffer, offset and length", async () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const int16 = (await roundTrip(new Int16Array(buffer, 2, 2))).value as Int16Array;
    expect([int16.byteOffset, int16.length, int16.buffer.byteLength]).toEqual([2, 2, 8]);
    expect(bytesToHex(new Uint8Array(int16.buffer))).toBe("0102030405060708");
    const view = (await roundTrip(new DataView(buffer, 3))).value as DataView;
    expect([view.byteOffset, view.byteLength, view.buffer.byteLength]).toEqual([3, 5, 8]);
  });

  it("hands Blob and File bytes to onBlob by SHA-256 and records the references", async () => {
    const bytes = new TextEncoder().encode("save data");
    const sha = sha256Hex(bytes);
    const value = {
      blob: new Blob([bytes], { type: "application/octet-stream" }),
      file: new File([bytes], "slot1.sav", { type: "", lastModified: 1_700_000_000_000 }),
    };
    const { value: back, refs, exported } = await roundTrip(value);
    // onBlob is called once per Blob or File value; deduplicating equal hashes is the caller's job.
    expect(exported.calls).toEqual([sha, sha]);
    expect(refs).toEqual(new Map([[sha, bytes.length]]));
    const { blob, file } = back as { blob: Blob; file: File };
    expect(Object.getPrototypeOf(blob)).toBe(Blob.prototype);
    expect([blob.type, blob.size, await blob.text()]).toEqual([
      "application/octet-stream",
      9,
      "save data",
    ]);
    expect(file).toBeInstanceOf(File);
    expect([file.name, file.type, file.lastModified, await file.text()]).toEqual([
      "slot1.sav",
      "",
      1_700_000_000_000,
      "save data",
    ]);
  });
});

describe("export errors (snapshot-format.md section 6.3)", () => {
  class GameState {
    level = 1;
  }

  it.each([
    ["Error", new Error("x"), "[object Error]"],
    ["class instance", new GameState(), "[object Object]"],
    ["function", () => 1, "[object Function]"],
    ["symbol", Symbol("s"), "[object Symbol]"],
    ["Symbol object", Object(Symbol("s")), "[object Symbol]"],
    ["resizable ArrayBuffer", new ArrayBuffer(4, { maxByteLength: 8 }), "[object ArrayBuffer]"],
    [
      "view over a resizable buffer",
      new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 })),
      "[object Uint8Array]",
    ],
    ["SharedArrayBuffer", new SharedArrayBuffer(4), "[object SharedArrayBuffer]"],
    ["WeakMap", new WeakMap(), "[object WeakMap]"],
    ["Promise", Promise.resolve(1), "[object Promise]"],
    ["Array subclass", new (class extends Array {})(), "[object Array]"],
    ["fake Date", Object.create(Date.prototype), "[object Object]"],
  ])("%s is EXP_UNSUPPORTED_VALUE with its path and type", async (_name, bad, type) => {
    const error = await exportError({ inventory: [0, 1, 2, { name: bad }] });
    expect(error.code).toBe("EXP_UNSUPPORTED_VALUE");
    expect(error.detail.path).toEqual(["inventory", 3, "name"]);
    expect(error.detail.type).toBe(type);
  });

  it.each([
    ["-0", -0],
    ["2^60", 2 ** 60],
  ])(
    "refuses a File whose lastModified is %s (not a safe integer)",
    async (_name, lastModified) => {
      const file = new File(["x"], "a", { lastModified });
      expect(Object.is(file.lastModified, lastModified)).toBe(true);
      const error = await exportError({ slots: [file] });
      expect([error.code, error.detail.path, error.detail.type]).toEqual([
        "EXP_UNSUPPORTED_VALUE",
        ["slots", 0],
        "[object File]",
      ]);
      expect(error.message).toMatch(/lastModified/);
    },
  );

  it("writes only Files the value check accepts", async () => {
    for (const lastModified of [0, -5, 1_700_000_000_000, 2 ** 53 - 1, -(2 ** 53 - 1)]) {
      const { item } = await exportValue(new File(["x"], "a", { lastModified }));
      expect(() => checkValueItem(item, new Map()), String(lastModified)).not.toThrow();
    }
  });

  it("refuses a shared reference and a cycle with EXP_SHARED_REFERENCE", async () => {
    const shared = { hp: 1 };
    const sharedError = await exportError({ a: shared, b: [shared] });
    expect([sharedError.code, sharedError.detail.path]).toEqual(["EXP_SHARED_REFERENCE", ["b", 0]]);
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const cycleError = await exportError(cyclic);
    expect([cycleError.code, cycleError.detail.path]).toEqual(["EXP_SHARED_REFERENCE", ["self"]]);
    const map = new Map<string, unknown>();
    map.set("me", map);
    expect((await exportError(map)).detail.path).toEqual([0, "value"]);
  });

  it("refuses two views of one buffer, which structured clone would keep shared", async () => {
    const bytes = new Uint8Array(4);
    const error = await exportError({ view: bytes, raw: bytes.buffer });
    expect([error.code, error.detail.path]).toEqual(["EXP_SHARED_REFERENCE", ["raw"]]);
  });

  it("allows maxDepth (256) nesting and refuses one level more with EXP_TOO_DEEP", async () => {
    // The value root sits at depth 1, inside its [key, value] record, so 256 nested arrays reach depth 256.
    const ok = await exportValue(nest(256));
    const record = encodeItem({ k: "array", v: [{ k: "uint", v: 1 }, ok.item] });
    expect(decodeSequence(record)).toHaveLength(1);
    const error = await exportError(nest(257));
    expect(error.code).toBe("EXP_TOO_DEEP");
    expect(error.detail.path).toHaveLength(256);
    expect((await exportError({ a: { b: 1 } }, 2)).detail.path).toEqual(["a", "b"]);
    // Fixed-shape children count too: a RegExp at the deepest level has its [source, flags] one deeper.
    expect((await exportError([/a/], 2)).code).toBe("EXP_TOO_DEEP");
  });
});

describe("checkValueItem and fromItem", () => {
  const regexpItem = (source: string, flags: string): CborItem => ({
    k: "tag",
    tag: 21066,
    v: {
      k: "array",
      v: [
        { k: "text", v: source },
        { k: "text", v: flags },
      ],
    },
  });

  it("checks RegExp flags only, never the source (engine-neutral)", () => {
    // A source another engine may escape differently, and one that does not compile, both pass the check.
    for (const source of ["a/b", "(", ""]) {
      expect(() => checkValueItem(regexpItem(source, "dgimsuy"), new Map()), source).not.toThrow();
    }
    for (const flags of ["ig", "gg", "uv", "x", "G"]) {
      expect(() => checkValueItem(regexpItem("a", flags), new Map()), flags).toThrow(SnapError);
    }
  });

  it("refuses a RegExp that does not compile when building, with a named error", () => {
    let error: unknown;
    try {
      fromItem(regexpItem("(", ""), () => new Blob([]));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(SnapError);
    expect((error as SnapError).code).toBe("SNAP_RECORD_INVALID");
    expect((error as SnapError).message).toMatch(/RegExp does not compile/);
    expect((fromItem(regexpItem("a/b", "g"), () => new Blob([])) as RegExp).flags).toBe("g");
  });

  it("refuses a map, which only envelopes may use", () => {
    const map: CborItem = { k: "map", v: [] };
    expect(() => checkValueItem({ k: "array", v: [map] }, new Map())).toThrow(SnapError);
  });

  it("refuses one blob hash referenced with two sizes", () => {
    const sha = "0".repeat(64);
    const blob = (size: number): CborItem => ({
      k: "tag",
      tag: 33111,
      v: {
        k: "array",
        v: [
          { k: "text", v: "" },
          { k: "uint", v: size },
          { k: "text", v: sha },
        ],
      },
    });
    expect(() => checkValueItem({ k: "array", v: [blob(1), blob(2)] }, new Map())).toThrow(
      SnapError,
    );
  });

  it("checks the item before building, and refuses a blob whose bytes have another size", async () => {
    expect(() => fromItem({ k: "float", v: 1 }, () => new Blob([]))).toThrow(SnapError);
    const { item } = await exportValue(new Blob(["abc"]));
    expect(() => fromItem(item, () => new Blob(["ab"]))).toThrow(SnapError);
  });
});
