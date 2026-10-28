import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../../test/notation.js";
import { SnapError } from "../errors.js";
import { type CborItem, encodeItem } from "./cbor.js";
import {
  type DbSchema,
  decodeLocalStorage,
  decodeSchema,
  decodeStoreRecords,
  encodeLocalStorage,
  encodeSchema,
  encodeStoreRecord,
  encodeStoreRecords,
} from "./data-files.js";
import type { IdbKey } from "./idb-key.js";
import type { BlobRefs } from "./value-check.js";

const uint = (v: number): CborItem => ({ k: "uint", v });
const text = (v: string): CborItem => ({ k: "text", v });

function snapError(run: () => unknown): SnapError {
  try {
    run();
  } catch (error) {
    if (error instanceof SnapError) {
      return error;
    }
    throw error;
  }
  throw new Error("no error");
}

const simple = (v: boolean | null): CborItem => ({ k: "simple", v });
const num = (n: number): CborItem =>
  Number.isSafeInteger(n) && n >= 0 ? uint(n) : { k: "float", v: n };
const keyPath = (p: string | string[] | null): CborItem =>
  p === null ? simple(null) : typeof p === "string" ? text(p) : { k: "array", v: p.map(text) };

/** The envelope of section 7.2 built by hand, so a test can write what encodeSchema refuses to write. */
function rawSchema(s: DbSchema, extra: [string, CborItem][] = []): Uint8Array {
  const stores = s.stores.map(
    (st): CborItem => ({
      k: "map",
      v: [
        ["name", text(st.name)],
        ["keyPath", keyPath(st.keyPath)],
        ["autoIncrement", simple(st.autoIncrement)],
        ["keyGenerator", st.keyGenerator === null ? simple(null) : num(st.keyGenerator)],
        [
          "indexes",
          {
            k: "array",
            v: st.indexes.map(
              (ix): CborItem => ({
                k: "map",
                v: [
                  ["name", text(ix.name)],
                  ["keyPath", keyPath(ix.keyPath)],
                  ["unique", simple(ix.unique)],
                  ["multiEntry", simple(ix.multiEntry)],
                ],
              }),
            ),
          },
        ],
        ["records", num(st.records)],
      ],
    }),
  );
  return encodeItem({
    k: "map",
    v: [
      ["name", text(s.name)],
      ["version", num(s.version)],
      ["stores", { k: "array", v: stores }],
      ...extra,
    ],
  });
}

// The progress-lab IDBFS shape (snapshot-format.md section 10, valid-idbfs).
const idbfs: DbSchema = {
  name: "/home/web_user",
  version: 21,
  stores: [
    {
      name: "FILE_DATA",
      keyPath: null,
      autoIncrement: false,
      keyGenerator: null,
      indexes: [{ name: "timestamp", keyPath: "timestamp", unique: false, multiEntry: false }],
      records: 3,
    },
  ],
};

describe("local-storage.cbor (section 7.1)", () => {
  it("writes [key, value] pairs sorted by code-unit order", () => {
    // Hand-written: 82 (pair) 61 61 ("a") 61 31 ("1").
    expect(bytesToHex(encodeLocalStorage([["a", "1"]]) as Uint8Array)).toBe("8261616131");
    // U+10000 (d800 dc00) sorts before U+FFFF in code-unit order.
    const bytes = encodeLocalStorage([
      ["￿", "x"],
      ["\u{10000}", "\ud800"],
      ["", ""],
    ]);
    expect(decodeLocalStorage(bytes as Uint8Array)).toEqual([
      ["", ""],
      ["\u{10000}", "\ud800"],
      ["￿", "x"],
    ]);
  });

  it("writes no file for an empty localStorage and refuses duplicate keys", () => {
    expect(encodeLocalStorage([])).toBeNull();
    expect(() =>
      encodeLocalStorage([
        ["a", "1"],
        ["a", "2"],
      ]),
    ).toThrow(TypeError);
  });

  it.each([
    ["an empty file (it must be absent)", ""],
    ["unsorted keys", "82616261318261616131"],
    ["a duplicate key", "82616161318261616132"],
    ["a pair of three", "83616161316131"],
    ["a non-string value", "82616101"],
    ["a non-array item", "6161"],
  ])("refuses %s", (_name, hex) => {
    expect(snapError(() => decodeLocalStorage(hexToBytes(hex))).code).toBe("SNAP_RECORD_INVALID");
  });
});

describe("schema.cbor (section 7.2)", () => {
  it("writes the envelope map with keys sorted by encoded bytes", () => {
    // Hand-written: a3, "name" 64 6e616d65 -> "db" 62 6462, "stores" 66 73746f726573 -> 80,
    // "version" 67 76657273696f6e -> 01. Shorter keys first because the head holds the length.
    expect(bytesToHex(encodeSchema({ name: "db", version: 1, stores: [] }))).toBe(
      "a3646e616d656264626673746f726573806776657273696f6e01",
    );
  });

  it("round-trips the IDBFS shape, a generator at 2^53 and array key paths", () => {
    expect(decodeSchema(encodeSchema(idbfs))).toEqual(idbfs);
    const schema: DbSchema = {
      name: "\ud800db",
      version: 2 ** 53 - 1,
      stores: [
        {
          name: "a",
          keyPath: "id",
          autoIncrement: true,
          keyGenerator: 2 ** 53,
          indexes: [{ name: "pair", keyPath: ["x", "y"], unique: true, multiEntry: false }],
          records: 0,
        },
      ],
    };
    expect(decodeSchema(encodeSchema(schema))).toEqual(schema);
  });

  it("sorts stores and indexes by name and refuses duplicate names", () => {
    const store = idbfs.stores[0] as DbSchema["stores"][number];
    const unsorted: DbSchema = {
      ...idbfs,
      stores: [
        { ...store, name: "b" },
        { ...store, name: "a" },
      ],
    };
    expect(decodeSchema(encodeSchema(unsorted)).stores.map((s) => s.name)).toEqual(["a", "b"]);
    const twice: DbSchema = { ...idbfs, stores: [store, store] };
    expect(() => encodeSchema(twice)).toThrow(TypeError);
  });

  const store = idbfs.stores[0] as DbSchema["stores"][number];
  const index = store.indexes[0] as DbSchema["stores"][number]["indexes"][number];
  it.each<[string, DbSchema]>([
    ["version 0", { ...idbfs, version: 0 }],
    ["a generator without autoIncrement", { ...idbfs, stores: [{ ...store, keyGenerator: 5 }] }],
    [
      "autoIncrement without a generator",
      { ...idbfs, stores: [{ ...store, autoIncrement: true, keyGenerator: null }] },
    ],
    [
      "a generator of 0",
      { ...idbfs, stores: [{ ...store, autoIncrement: true, keyGenerator: 0 }] },
    ],
    ["an empty key path array", { ...idbfs, stores: [{ ...store, keyPath: [] }] }],
    [
      "multiEntry with an array key path",
      {
        ...idbfs,
        stores: [{ ...store, indexes: [{ ...index, keyPath: ["a", "b"], multiEntry: true }] }],
      },
    ],
  ])("refuses %s, when encoding and when decoding", (_name, schema) => {
    expect(() => encodeSchema(schema)).toThrow(TypeError);
    expect(snapError(() => decodeSchema(rawSchema(schema))).code).toBe("SNAP_RECORD_INVALID");
  });

  it("refuses an unknown or a missing member and unsorted stores", () => {
    const unknown = rawSchema(idbfs, [["extra", uint(1)]]);
    expect(snapError(() => decodeSchema(unknown)).code).toBe("SNAP_RECORD_INVALID");
    const missing = encodeItem({
      k: "map",
      v: [
        ["name", text("db")],
        ["version", uint(1)],
      ],
    });
    expect(snapError(() => decodeSchema(missing)).code).toBe("SNAP_RECORD_INVALID");
    const unsorted = {
      ...idbfs,
      stores: [
        { ...store, name: "b" },
        { ...store, name: "a" },
      ],
    };
    expect(snapError(() => decodeSchema(rawSchema(unsorted))).code).toBe("SNAP_RECORD_INVALID");
  });

  it.each([
    ["two envelopes", "a3646e616d656264626673746f726573806776657273696f6e01".repeat(2)],
    ["no envelope", ""],
  ])("refuses %s", (_name, hex) => {
    expect(snapError(() => decodeSchema(hexToBytes(hex))).code).toBe("SNAP_RECORD_INVALID");
  });
});

describe("store-<s>.cbor (section 7.3)", () => {
  it("writes [key, value] records in IndexedDB key order", () => {
    // Hand-written: 82 01 02 ([1, 2]) then 82 61 61 01 (["a", 1]): a number key sorts before a string key.
    const bytes = encodeStoreRecords([
      ["a", uint(1)],
      [1, uint(2)],
    ]);
    expect(bytesToHex(bytes)).toBe("82010282616101");
    const records = decodeStoreRecords(bytes, new Map());
    expect(records.map((r) => r.key)).toEqual([1, "a"]);
    expect(records.map((r) => r.value)).toEqual([uint(2), uint(1)]);
    expect(encodeStoreRecords([])).toEqual(new Uint8Array());
    expect(() =>
      encodeStoreRecords([
        [1, uint(1)],
        [1, uint(2)],
      ]),
    ).toThrow(TypeError);
  });

  it("encodes one record at a time, byte-identical to the whole store in key order (Ruling R6)", () => {
    const records: [IdbKey, CborItem][] = [
      [-1.5, text("float key")],
      [3, uint(3)],
      [new Date(0), { k: "array", v: [uint(1), text("x")] }],
      ["", simple(null)],
      ["b", simple(true)],
      [new Uint8Array([0, 255]).buffer, uint(7)],
      [[1, "a"], text("array key")],
    ];
    const one = records.map(([key, value]) => encodeStoreRecord(key, value));
    expect(one.map(bytesToHex).join("")).toBe(
      bytesToHex(encodeStoreRecords([...records].reverse())),
    );
    expect(bytesToHex(encodeStoreRecord("a", uint(1)))).toBe("82616101");
  });

  it("records blob references of the values", () => {
    const sha = "a".repeat(64);
    const blob: CborItem = {
      k: "tag",
      tag: 33111,
      v: { k: "array", v: [text(""), uint(4), text(sha)] },
    };
    const refs: BlobRefs = new Map();
    decodeStoreRecords(encodeStoreRecords([[1, blob]]), refs);
    expect(refs).toEqual(new Map([[sha, 4]]));
  });

  it("allows a value nested to maxDepth and refuses one level more", () => {
    // [1, value]: the record is at depth 0, so the value root is at depth 1 and 256 nested arrays reach 256.
    const record = (levels: number) =>
      new Uint8Array([0x82, 0x01, ...new Array<number>(levels - 1).fill(0x81), 0x80]);
    expect(decodeStoreRecords(record(256), new Map())).toHaveLength(1);
    expect(snapError(() => decodeStoreRecords(record(257), new Map())).code).toBe(
      "SNAP_RECORD_INVALID",
    );
  });

  it.each([
    ["keys out of order", "82616101820102"],
    ["a duplicate key", "820101820102"],
    ["a NaN key", "82f97e0001"],
    ["a plain-object key", "82d9814d8001"],
    ["a map value", "8201a0"],
    ["a record of one item", "8101"],
    ["a record that is not an array", "01"],
  ])("refuses %s", (_name, hex) => {
    expect(snapError(() => decodeStoreRecords(hexToBytes(hex), new Map())).code).toBe(
      "SNAP_RECORD_INVALID",
    );
  });
});
