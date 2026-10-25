import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ascii,
  chunks,
  codeOfAsync,
  concat,
  errorOf,
  FIRST_PARTY,
  rawHeader,
  type SnapFile,
  sha256,
  snapshot,
  snapshotTar,
  type tar,
  zstd,
} from "../../test/wgsnap.js";
import type { CborItem } from "../record/cbor.js";
import { encodeLocalStorage, encodeSchema, encodeStoreRecords } from "../record/data-files.js";
import type { Limits } from "./limits.js";
import { readEntries, validateSnapshot } from "./reader.js";

// --- fixtures ------------------------------------------------------------------------------------------------------

const text = (v: string): CborItem => ({ k: "text", v });
const uint = (v: number): CborItem => ({ k: "uint", v });
const tagged = (tag: number, ...items: CborItem[]): CborItem => ({
  k: "tag",
  tag,
  v: { k: "array", v: items },
});

const blobBytes = ascii("blob content, never in an error message");
const BLOB = sha256(blobBytes);
const blobItem = (sha = BLOB, size = blobBytes.length) =>
  tagged(33111, text(""), uint(size), text(sha));
const regexpItem = (source: string) => tagged(21066, text(source), text("g"));

const localStorage = encodeLocalStorage([
  ["a", "1"],
  ["b", "2"],
]) as Uint8Array;

interface StoreSpec {
  name: string;
  records: number;
  indexes?: number;
}
const schema = (stores: StoreSpec[], name = "db") =>
  encodeSchema({
    name,
    version: 1,
    stores: stores.map((s) => ({
      name: s.name,
      keyPath: null,
      autoIncrement: false,
      keyGenerator: null,
      indexes: Array.from({ length: s.indexes ?? 0 }, (_, i) => ({
        name: `i${String(i).padStart(3, "0")}`,
        keyPath: "k",
        unique: false,
        multiEntry: false,
      })),
      records: s.records,
    })),
  });
const records = (n: number, value: (i: number) => CborItem = (i) => uint(i)) =>
  encodeStoreRecords(Array.from({ length: n }, (_, i) => [i, value(i)] as const));

/** One storage key with localStorage, one database with one store of two records, one referenced blob. */
const files = (): SnapFile[] => [
  { path: "data/0/local-storage.cbor", data: localStorage },
  { path: "data/0/idb/0/schema.cbor", data: schema([{ name: "s", records: 2 }]) },
  {
    path: "data/0/idb/0/store-0.cbor",
    data: records(2, (i) => (i === 0 ? blobItem() : text("x"))),
  },
  { path: `blobs/${BLOB}`, data: blobBytes },
];

const validate = (bytes: Uint8Array, limits: Partial<Limits> = {}, size?: number) =>
  validateSnapshot(chunks(bytes, size), limits);
const codeOf = (bytes: Uint8Array, limits: Partial<Limits> = {}) =>
  codeOfAsync(() => validate(bytes, limits));
/** A snapshot whose tar has `extra` inserted right after the manifest. */
const withExtra = (extra: Parameters<typeof tar>[0], base = files()) =>
  snapshot(base, { layout: (m, rest) => [m, ...extra, ...rest] });

// --- valid input ---------------------------------------------------------------------------------------------------

describe("validateSnapshot: valid snapshots", () => {
  it("accepts a snapshot and returns the manifest and the counts the restore needs, never values", async () => {
    const bytes = snapshot(files());
    const result = await validate(bytes);
    expect(result.manifest.storageKeys).toEqual([FIRST_PARTY]);
    expect(result.manifest.entries.map((e) => e.path)).toEqual([
      `blobs/${BLOB}`,
      "data/0/idb/0/schema.cbor",
      "data/0/idb/0/store-0.cbor",
      "data/0/local-storage.cbor",
    ]);
    expect(result.storageKeys).toEqual([
      { localStorageItems: 2, databases: [{ stores: [{ records: 2 }] }] },
    ]);
    expect(result.blobs).toEqual({ count: 1, bytes: blobBytes.length });
    expect(result.compressedBytes).toBe(bytes.length);
    expect(result.tarBytes).toBe(snapshotTar(files()).length);
    expect(JSON.stringify(result)).not.toContain("blob content");
  });

  it("accepts any chunking of the input", async () => {
    for (const size of [1, 13, 512, 1 << 20]) {
      await expect(validate(snapshot(files()), {}, size)).resolves.toBeDefined();
    }
  });

  it("accepts a snapshot without storage keys", async () => {
    const result = await validate(snapshot([], { storageKeys: [] }));
    expect(result.storageKeys).toEqual([]);
  });

  it("accepts directory entries for prefixes of the grammar, before and after the manifest", async () => {
    const dirs = ["data/", "data/0/", "data/0/idb/", "data/0/idb/0/", "blobs/"].map((path) => ({
      path,
      header: { typeflag: "5" },
    }));
    const bytes = snapshot(files(), {
      layout: (m, rest) => [dirs[0] as never, m, ...dirs.slice(1), ...rest],
    });
    await expect(validate(bytes)).resolves.toBeDefined();
  });

  it("accepts entries in any order after the manifest", async () => {
    const bytes = snapshot(files(), { layout: (m, rest) => [m, ...rest.reverse()] });
    await expect(validate(bytes)).resolves.toBeDefined();
  });

  it("passes an error of the source through unchanged, not as a format error", async () => {
    const bytes = snapshot(files());
    const disk = new Error("read failed");
    async function* failing() {
      yield bytes.subarray(0, 20);
      throw disk;
    }
    await expect(validateSnapshot(failing())).rejects.toBe(disk);
  });

  it("stops reading the source after the first failure", async () => {
    // Incompressible blob bytes after an early bad entry, so the file is long in compressed bytes too.
    const noise = new Uint8Array(randomBytes(2 ** 20));
    const bytes = withExtra(
      [{ path: "../escape.txt" }],
      [...files(), { path: `blobs/${sha256(noise)}`, data: noise }],
    );
    let closed = false;
    let pulled = 0;
    async function* source() {
      try {
        for (let at = 0; at < bytes.length; at += 64) {
          pulled++;
          yield bytes.subarray(at, at + 64);
        }
      } finally {
        closed = true;
      }
    }
    expect(await codeOfAsync(() => validateSnapshot(source()))).toBe("SNAP_PATH_TRAVERSAL");
    expect(closed).toBe(true);
    expect(pulled).toBeLessThan(bytes.length / 64 / 2);
  });

  it.each([1, 64, 1 << 20])(
    "reports a defect inside the frame before a later container defect, for chunks of %i bytes",
    async (size) => {
      const bad = withExtra([{ path: "../escape.txt" }]);
      const trailing = concat(bad, Uint8Array.of(1, 2, 3));
      expect(await codeOfAsync(() => validate(trailing, {}, size))).toBe("SNAP_PATH_TRAVERSAL");
      expect(await codeOfAsync(() => validate(bad.subarray(0, bad.length - 1), {}, size))).toBe(
        "SNAP_PATH_TRAVERSAL",
      );
      expect(await codeOfAsync(() => validate(bad, { maxFileBytes: bad.length - 1 }, size))).toBe(
        "SNAP_PATH_TRAVERSAL",
      );
    },
  );

  it("validates without a sink: it takes only the source and limits, and imports no file system", () => {
    expect(validateSnapshot.length).toBe(1);
    const source = readFileSync(new URL("./reader.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:fs|node:path|createWriteStream/);
  });
});

// --- container -----------------------------------------------------------------------------------------------------

describe("validateSnapshot: container codes (snapshot-format.md section 8)", () => {
  it("SNAP_FILE_TOO_LARGE above maxFileBytes compressed bytes", async () => {
    const bytes = snapshot(files());
    expect(await codeOf(bytes, { maxFileBytes: bytes.length - 1 })).toBe("SNAP_FILE_TOO_LARGE");
    expect(await codeOf(bytes, { maxFileBytes: bytes.length })).toBeUndefined();
  });

  it("SNAP_ZSTD_INVALID for bytes that are not zstd and for a skippable frame first", async () => {
    expect(await codeOf(snapshotTar(files()))).toBe("SNAP_ZSTD_INVALID");
    const skippable = Uint8Array.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
    expect(await codeOf(concat(skippable, snapshot(files())))).toBe("SNAP_ZSTD_INVALID");
  });

  it("SNAP_ZSTD_INVALID for corrupt block data and for a checksum mismatch", async () => {
    // A well-formed frame (window 2^21, checksum) whose only block is a compressed block of garbage.
    const corrupt = Uint8Array.from([
      0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58, 0x25, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 1, 2, 3, 4,
    ]);
    expect(await codeOf(corrupt)).toBe("SNAP_ZSTD_INVALID");
    const bytes = snapshot(files());
    const wrongChecksum = bytes.slice();
    wrongChecksum[wrongChecksum.length - 1] = (wrongChecksum.at(-1) as number) ^ 0x01;
    expect(await codeOf(wrongChecksum)).toBe("SNAP_ZSTD_INVALID");
    // The frame is complete, so its checksum mismatch comes before the byte after it.
    expect(await codeOf(concat(wrongChecksum, Uint8Array.of(1)))).toBe("SNAP_ZSTD_INVALID");
  });

  it("SNAP_ZSTD_NO_CHECKSUM for a frame without the checksum flag", async () => {
    expect(await codeOf(zstd(snapshotTar(files()), false))).toBe("SNAP_ZSTD_NO_CHECKSUM");
  });

  it.each([
    ["1 byte", 1],
    ["half", 0.5],
    ["length - 1", -1],
  ])("SNAP_TRUNCATED for the file cut to %s, whatever the tar reader saw", async (_, cut) => {
    const bytes = snapshot(files());
    const length = cut === 1 ? 1 : cut === -1 ? bytes.length - 1 : Math.floor(bytes.length * cut);
    expect(await codeOf(bytes.subarray(0, length))).toBe("SNAP_TRUNCATED");
  });

  it("SNAP_TRUNCATED for a complete frame whose tar ends inside an entry", async () => {
    const whole = snapshotTar(files());
    expect(await codeOf(zstd(whole.subarray(0, 512 * 3 + 100)))).toBe("SNAP_TRUNCATED");
    expect(await codeOf(zstd(whole.subarray(0, whole.length - 1024)))).toBe("SNAP_TRUNCATED");
  });

  it("SNAP_TRAILING_DATA for a second frame, an appended byte and non-zero bytes after the tar", async () => {
    const bytes = snapshot(files());
    expect(await codeOf(concat(bytes, bytes))).toBe("SNAP_TRAILING_DATA");
    expect(await codeOf(concat(bytes, Uint8Array.of(0)))).toBe("SNAP_TRAILING_DATA");
    expect(await codeOf(snapshot(files(), { after: Uint8Array.of(0, 0, 7) }))).toBe(
      "SNAP_TRAILING_DATA",
    );
    expect(await codeOf(snapshot(files(), { after: new Uint8Array(5000) }))).toBeUndefined();
  });

  it("SNAP_RATIO_EXCEEDED only once the uncompressed stream passes ratioFloorBytes", async () => {
    const zeros = new Uint8Array(3 * 2 ** 20);
    const sha = sha256(zeros);
    const bomb: SnapFile[] = [
      { path: "data/0/idb/0/schema.cbor", data: schema([{ name: "s", records: 1 }]) },
      { path: "data/0/idb/0/store-0.cbor", data: records(1, () => blobItem(sha, zeros.length)) },
      { path: `blobs/${sha}`, data: zeros },
    ];
    const bytes = snapshot(bomb);
    expect(bytes.length * 200).toBeLessThan(zeros.length);
    expect(await codeOf(bytes)).toBeUndefined();
    expect(await codeOf(bytes, { ratioFloorBytes: 2 ** 20 })).toBe("SNAP_RATIO_EXCEEDED");
    expect(await codeOf(bytes, { ratioFloorBytes: 2 ** 20, maxRatio: 100_000 })).toBeUndefined();
  });

  it("SNAP_TOTAL_TOO_LARGE above maxTotalBytes uncompressed tar bytes", async () => {
    const whole = snapshotTar(files());
    expect(await codeOf(zstd(whole), { maxTotalBytes: whole.length - 1 })).toBe(
      "SNAP_TOTAL_TOO_LARGE",
    );
    expect(await codeOf(zstd(whole), { maxTotalBytes: whole.length })).toBeUndefined();
  });
});

// --- entry rules ---------------------------------------------------------------------------------------------------

describe("validateSnapshot: entry rules 1 to 14 through the whole pipeline", () => {
  it.each([
    ["SNAP_TAR_INVALID", { path: "data/x", header: { checksum: "bad" } }],
    ["SNAP_SYMLINK", { path: "data/x", header: { typeflag: "2" } }],
    ["SNAP_HARDLINK", { path: "data/x", header: { typeflag: "1" } }],
    ["SNAP_DEVICE", { path: "data/x", header: { typeflag: "3" } }],
    ["SNAP_UNSUPPORTED_ENTRY_TYPE", { path: "data/x", header: { typeflag: "x" } }],
    ["SNAP_BAD_PATH_ENCODING", { path: "", header: { name: Uint8Array.of(0xff) } }],
    ["SNAP_ABSOLUTE_PATH", { path: "/etc/escape" }],
    ["SNAP_PATH_TRAVERSAL", { path: "../escape.txt" }],
    ["SNAP_BAD_PATH", { path: "data//x" }],
    ["SNAP_NON_NFC_PATH", { path: "data/é" }],
    ["SNAP_DUPLICATE_PATH", { path: "manifest.json", data: ascii("{}") }],
  ] as const)("%s", async (code, entry) => {
    expect(await codeOf(withExtra([entry as never]))).toBe(code);
  });

  it("SNAP_TOO_MANY_ENTRIES above maxEntries", async () => {
    const bytes = snapshot(files());
    expect(await codeOf(bytes, { maxEntries: 4 })).toBe("SNAP_TOO_MANY_ENTRIES");
    expect(await codeOf(bytes, { maxEntries: 5 })).toBeUndefined();
  });

  it("SNAP_ENTRY_TOO_LARGE above maxEntryBytes, on the header", async () => {
    expect(await codeOf(snapshot(files()), { maxEntryBytes: blobBytes.length - 1 })).toBe(
      "SNAP_ENTRY_TOO_LARGE",
    );
  });

  it("SNAP_MISSING_MANIFEST when the first file is a data file", async () => {
    const bytes = snapshot(files(), { layout: (m, rest) => [...rest, m] });
    expect(await codeOf(bytes)).toBe("SNAP_MISSING_MANIFEST");
  });
});

// --- manifest and hashes -------------------------------------------------------------------------------------------

describe("validateSnapshot: manifest and hash codes (sections 4 and 5)", () => {
  it("SNAP_MANIFEST_TOO_LARGE on the header, before its data is read", async () => {
    const claimed = zstd(
      concat(rawHeader("manifest.json", { size: 10 * 2 ** 20 }), new Uint8Array(1024)),
    );
    expect(await codeOf(claimed)).toBe("SNAP_MANIFEST_TOO_LARGE");
  });

  it("SNAP_MANIFEST_INVALID for whitespace", async () => {
    const bytes = snapshot(files(), { manifestText: (t) => t.replace(":", ": ") });
    expect(await codeOf(bytes)).toBe("SNAP_MANIFEST_INVALID");
  });

  it("SNAP_UNKNOWN_FORMAT and SNAP_UNSUPPORTED_VERSION", async () => {
    expect(await codeOf(snapshot(files(), { edit: (m) => (m.format = "zip") }))).toBe(
      "SNAP_UNKNOWN_FORMAT",
    );
    const v2 = snapshot(files(), {
      edit: (m) => (m.formatVersion = 2),
      manifestText: (t) => `${t}\n`,
    });
    expect(await codeOf(v2)).toBe("SNAP_UNSUPPORTED_VERSION");
  });

  it("SNAP_CONTENT_HASH_MISMATCH for one changed hex digit of contentHash", async () => {
    const bytes = snapshot(files(), {
      manifestText: (t) =>
        t.replace(/"contentHash":"(.)/, (_, c) => `"contentHash":"${c === "0" ? "1" : "0"}`),
    });
    expect(await codeOf(bytes)).toBe("SNAP_CONTENT_HASH_MISMATCH");
  });

  it("SNAP_SIZE_MISMATCH when a header size differs from the manifest", async () => {
    const bytes = snapshot(files(), {
      layout: (m, rest) => [
        m,
        ...rest.map((f) =>
          f.path.startsWith("blobs/")
            ? { ...f, data: concat(f.data as Uint8Array, ascii("!")) }
            : f,
        ),
      ],
    });
    expect(await codeOf(bytes)).toBe("SNAP_SIZE_MISMATCH");
  });

  it("SNAP_ENTRY_HASH_MISMATCH when one byte of a data entry changed, with the entry path", async () => {
    const bytes = snapshot(files(), {
      layout: (m, rest) => [
        m,
        ...rest.map((f) => {
          if (!f.path.startsWith("blobs/")) {
            return f;
          }
          const data = (f.data as Uint8Array).slice();
          data[0] = (data[0] as number) ^ 1;
          return { ...f, data };
        }),
      ],
    });
    const error = await errorOf(() => validate(bytes));
    expect(error.code).toBe("SNAP_ENTRY_HASH_MISMATCH");
    expect(error.path).toBe(`blobs/${BLOB}`);
    expect(error.message).not.toContain("blob content");
  });

  it("SNAP_MISSING_ENTRY for a listed entry that never appears", async () => {
    const bytes = snapshot(files(), { layout: (m, rest) => [m, ...rest.slice(1)] });
    expect(await codeOf(bytes)).toBe("SNAP_MISSING_ENTRY");
  });

  it.each([
    ["an unlisted file outside the grammar", { path: "data/0/extra.bin", data: ascii("x") }],
    ["an unlisted file inside the grammar", { path: "data/0/idb/1/schema.cbor", data: ascii("x") }],
    [
      "a storage key index past storageKeys",
      { path: "data/1/local-storage.cbor", data: ascii("x") },
    ],
    ["a directory outside the grammar", { path: "other/", header: { typeflag: "5" } }],
    ["a directory with data", { path: "data/", data: ascii("x"), header: { typeflag: "5" } }],
  ])("SNAP_UNEXPECTED_ENTRY for %s", async (_, entry) => {
    expect(await codeOf(withExtra([entry as never]))).toBe("SNAP_UNEXPECTED_ENTRY");
  });

  it("SNAP_UNEXPECTED_ENTRY for a directory before the manifest that the manifest does not allow", async () => {
    const bytes = snapshot(files(), {
      layout: (m, rest) => [{ path: "data/7/", header: { typeflag: "5" } }, m, ...rest],
    });
    expect(await codeOf(bytes)).toBe("SNAP_UNEXPECTED_ENTRY");
  });
});

// --- records -------------------------------------------------------------------------------------------------------

/** `files()` with the file at `path` replaced (or removed with `null`), plus `extra` files. */
function variant(changes: Record<string, Uint8Array | null>, extra: SnapFile[] = []): Uint8Array {
  const base = files()
    .filter((f) => changes[f.path] !== null)
    .map((f) => (f.path in changes ? { path: f.path, data: changes[f.path] as Uint8Array } : f));
  return snapshot([...base, ...extra]);
}

describe("validateSnapshot: records, schemas and blobs (sections 6 and 7)", () => {
  it("SNAP_RECORD_INVALID with the path for a data file that does not decode", async () => {
    const error = await errorOf(() =>
      validate(variant({ "data/0/local-storage.cbor": Uint8Array.of(0xff) })),
    );
    expect(error.code).toBe("SNAP_RECORD_INVALID");
    expect(error.path).toBe("data/0/local-storage.cbor");
  });

  it("SNAP_RECORD_INVALID when a store does not hold exactly `records` items", async () => {
    expect(
      await codeOf(variant({ "data/0/idb/0/schema.cbor": schema([{ name: "s", records: 3 }]) })),
    ).toBe("SNAP_RECORD_INVALID");
    const three = records(3, (i) => (i === 0 ? blobItem() : text("x")));
    expect(await codeOf(variant({ "data/0/idb/0/store-0.cbor": three }))).toBe(
      "SNAP_RECORD_INVALID",
    );
  });

  it("SNAP_RECORD_INVALID for a store file without its schema and a schema store without its file", async () => {
    expect(await codeOf(variant({ "data/0/idb/0/schema.cbor": null }))).toBe("SNAP_RECORD_INVALID");
    const twoStores = schema([
      { name: "s", records: 2 },
      { name: "t", records: 0 },
    ]);
    expect(await codeOf(variant({ "data/0/idb/0/schema.cbor": twoStores }))).toBe(
      "SNAP_RECORD_INVALID",
    );
    const withEmpty = variant({ "data/0/idb/0/schema.cbor": twoStores }, [
      { path: "data/0/idb/0/store-1.cbor", data: new Uint8Array(0) },
    ]);
    expect(await codeOf(withEmpty)).toBeUndefined();
    expect(
      await codeOf(variant({}, [{ path: "data/0/idb/0/store-1.cbor", data: new Uint8Array(0) }])),
    ).toBe("SNAP_RECORD_INVALID");
  });

  it("SNAP_RECORD_INVALID for databases not numbered 0 to n - 1 or not sorted by name", async () => {
    const empty = schema([], "zz");
    expect(await codeOf(variant({}, [{ path: "data/0/idb/2/schema.cbor", data: empty }]))).toBe(
      "SNAP_RECORD_INVALID",
    );
    expect(
      await codeOf(variant({}, [{ path: "data/0/idb/1/schema.cbor", data: empty }])),
    ).toBeUndefined();
    expect(
      await codeOf(variant({}, [{ path: "data/0/idb/1/schema.cbor", data: schema([], "a") }])),
    ).toBe("SNAP_RECORD_INVALID");
  });

  it("SNAP_RECORD_INVALID above the database, store and index count limits", async () => {
    const second = [{ path: "data/0/idb/1/schema.cbor", data: schema([], "zz") }];
    expect(await codeOf(variant({}, second), { maxDatabasesPerKey: 1 })).toBe(
      "SNAP_RECORD_INVALID",
    );
    expect(await codeOf(variant({}, second), { maxDatabasesPerKey: 2 })).toBeUndefined();
    const twoStores = variant(
      {
        "data/0/idb/0/schema.cbor": schema([
          { name: "s", records: 2 },
          { name: "t", records: 0 },
        ]),
      },
      [{ path: "data/0/idb/0/store-1.cbor", data: new Uint8Array(0) }],
    );
    expect(await codeOf(twoStores, { maxStoresPerDatabase: 1 })).toBe("SNAP_RECORD_INVALID");
    expect(await codeOf(twoStores, { maxStoresPerDatabase: 2 })).toBeUndefined();
    const indexed = variant({
      "data/0/idb/0/schema.cbor": schema([{ name: "s", records: 2, indexes: 3 }]),
    });
    expect(await codeOf(indexed, { maxIndexesPerStore: 2 })).toBe("SNAP_RECORD_INVALID");
    expect(await codeOf(indexed, { maxIndexesPerStore: 3 })).toBeUndefined();
  });

  it("SNAP_RECORD_INVALID for a RegExp whose source does not compile here (Ruling R7)", async () => {
    const store = (source: string) =>
      records(2, (i) => (i === 0 ? blobItem() : tagged(33106, uint(1), regexpItem(source))));
    expect(await codeOf(variant({ "data/0/idb/0/store-0.cbor": store("a+") }))).toBeUndefined();
    const error = await errorOf(() =>
      validate(variant({ "data/0/idb/0/store-0.cbor": store("(") })),
    );
    expect(error.code).toBe("SNAP_RECORD_INVALID");
    expect(error.path).toBe("data/0/idb/0/store-0.cbor");
  });

  it("SNAP_RECORD_INVALID for a value deeper than maxDepth", async () => {
    let deep: CborItem = text("x");
    for (let i = 0; i < 5; i++) {
      deep = { k: "array", v: [deep] };
    }
    const bytes = variant({
      "data/0/idb/0/store-0.cbor": records(2, (i) => (i === 0 ? blobItem() : deep)),
    });
    expect(await codeOf(bytes)).toBeUndefined();
    expect(await codeOf(bytes, { maxDepth: 4 })).toBe("SNAP_RECORD_INVALID");
  });

  it("SNAP_RECORD_INVALID for a blob reference without its blob, with another size, or an unreferenced blob", async () => {
    const other = ascii("other");
    const otherSha = sha256(other);
    const storeWith = (item: CborItem) => records(2, (i) => (i === 0 ? item : text("x")));
    expect(
      await codeOf(variant({ "data/0/idb/0/store-0.cbor": storeWith(blobItem(otherSha, 5)) })),
    ).toBe("SNAP_RECORD_INVALID");
    expect(
      await codeOf(variant({ "data/0/idb/0/store-0.cbor": storeWith(blobItem(BLOB, 1)) })),
    ).toBe("SNAP_RECORD_INVALID");
    expect(await codeOf(variant({}, [{ path: `blobs/${otherSha}`, data: other }]))).toBe(
      "SNAP_RECORD_INVALID",
    );
  });

  it("SNAP_RECORD_INVALID for a blob entry not named by its SHA-256", async () => {
    const wrongName = "f".repeat(64);
    const bytes = variant(
      {
        [`blobs/${BLOB}`]: null,
        "data/0/idb/0/store-0.cbor": records(2, (i) => (i === 0 ? blobItem(wrongName) : text("x"))),
      },
      [{ path: `blobs/${wrongName}`, data: blobBytes }],
    );
    expect(await codeOf(bytes)).toBe("SNAP_RECORD_INVALID");
  });
});

// --- second pass ---------------------------------------------------------------------------------------------------

describe("readEntries: the restore's second pass (R6)", () => {
  async function collect(
    bytes: Uint8Array,
    manifest: Awaited<ReturnType<typeof validate>>["manifest"],
  ) {
    const out: { path: string; bytes: Uint8Array }[] = [];
    for await (const entry of readEntries(chunks(bytes), manifest)) {
      out.push(entry);
    }
    return out;
  }

  it("yields every data entry with its verified bytes, in archive order", async () => {
    const bytes = snapshot(files());
    const { manifest } = await validate(bytes);
    const entries = await collect(bytes, manifest);
    const expected = [...files()].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries).toEqual(expected.map((f) => ({ path: f.path, bytes: f.data })));
  });

  it("refuses a file that changed between the passes: another snapshot, or a changed entry", async () => {
    const { manifest } = await validate(snapshot(files()));
    const other = snapshot(files().slice(0, 1));
    expect(await codeOfAsync(() => collect(other, manifest))).toBe("SNAP_CONTENT_HASH_MISMATCH");

    const changed = snapshot(files(), {
      layout: (m, rest) => [
        m,
        ...rest.map((f) =>
          f.path === "data/0/local-storage.cbor"
            ? { ...f, data: (f.data as Uint8Array).slice().fill(0) }
            : f,
        ),
      ],
    });
    const yielded: string[] = [];
    const error = await errorOf(async () => {
      for await (const entry of readEntries(chunks(changed), manifest)) {
        yielded.push(entry.path);
      }
    });
    expect(error.code).toBe("SNAP_ENTRY_HASH_MISMATCH");
    expect(yielded).not.toContain("data/0/local-storage.cbor");
  });

  it("refuses a missing entry and keeps the container checks", async () => {
    const { manifest } = await validate(snapshot(files()));
    const missing = snapshot(files(), { layout: (m, rest) => [m, ...rest.slice(1)] });
    expect(await codeOfAsync(() => collect(missing, manifest))).toBe("SNAP_MISSING_ENTRY");
    const cut = snapshot(files());
    expect(await codeOfAsync(() => collect(cut.subarray(0, cut.length - 1), manifest))).toBe(
      "SNAP_TRUNCATED",
    );
  });
});
