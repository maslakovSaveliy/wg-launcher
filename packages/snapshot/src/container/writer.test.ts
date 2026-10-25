import { Writable } from "node:stream";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ascii, chunks, codeOfAsync, FIRST_PARTY, sha256, snapshot } from "../../test/wgsnap.js";
import type { CborItem } from "../record/cbor.js";
import { encodeLocalStorage, encodeSchema, encodeStoreRecords } from "../record/data-files.js";
import type { Limits } from "./limits.js";
import { readEntries, validateSnapshot } from "./reader.js";
import { parseHeader } from "./ustar.js";
import { type SnapshotInput, writeSnapshot } from "./writer.js";

/** A Writable that keeps what it receives. */
function sink() {
  const parts: Uint8Array[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      parts.push(new Uint8Array(chunk));
      done();
    },
  });
  const bytes = () => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  return { stream, bytes, parts };
}

const blob = ascii("bytes of a blob");
const BLOB = sha256(blob);

function input(files: SnapshotInput["files"] = defaultFiles()): SnapshotInput {
  return {
    format: "wgsnap",
    formatVersion: 1,
    gameId: "0192f0a0-0000-7000-8000-000000000001",
    revisionId: "0192f0a0-0000-7000-8000-000000000002",
    parentRevisionId: null,
    createdAt: "2026-10-25T12:00:00.000Z",
    deviceId: "0192f0a0-0000-7000-8000-000000000003",
    exporter: { id: "generic", version: "1.0.0" },
    adapter: null,
    gameVersion: null,
    flushState: "unconfirmed",
    storageKeys: [{ origin: "http://localhost:4417", topLevelSite: null, role: "top" }],
    files,
  };
}

function defaultFiles(): SnapshotInput["files"] {
  const blobItem: CborItem = {
    k: "tag",
    tag: 33111,
    v: {
      k: "array",
      v: [
        { k: "text", v: "" },
        { k: "uint", v: blob.length },
        { k: "text", v: BLOB },
      ],
    },
  };
  return [
    // Deliberately unsorted: the writer sorts.
    { path: "data/0/local-storage.cbor", bytes: encodeLocalStorage([["k", "v"]]) as Uint8Array },
    { path: `blobs/${BLOB}`, bytes: blob },
    { path: "data/0/idb/0/store-0.cbor", bytes: encodeStoreRecords([[1, blobItem]]) },
    {
      path: "data/0/idb/0/schema.cbor",
      bytes: encodeSchema({
        name: "db",
        version: 1,
        stores: [
          {
            name: "s",
            keyPath: null,
            autoIncrement: false,
            keyGenerator: null,
            indexes: [],
            records: 1,
          },
        ],
      }),
    },
  ];
}

describe("writeSnapshot", () => {
  it("writes a snapshot that validates, with the returned contentHash and size", async () => {
    const out = sink();
    const result = await writeSnapshot(input(), out.stream);
    const bytes = out.bytes();
    expect(result.sizeBytes).toBe(bytes.length);
    const validated = await validateSnapshot(chunks(bytes), { compressedSize: bytes.length });
    expect(validated.manifest.contentHash).toBe(result.contentHash);
    expect(validated.manifest.storageKeys).toEqual([FIRST_PARTY]);
    expect(validated.storageKeys).toEqual([
      { localStorageItems: 1, databases: [{ stores: [{ records: 1 }] }] },
    ]);
    const { files: _, ...fields } = input();
    expect(validated.manifest).toMatchObject(fields);
  });

  it("writes manifest.json first, then the entries sorted by path, then two zero blocks, in one checksummed frame", async () => {
    const out = sink();
    await writeSnapshot(input(), out.stream);
    const bytes = out.bytes();
    // Frame header descriptor: checksum flag (bit 2) set, no dictionary id.
    expect((bytes[4] as number) & 0x07).toBe(0x04);
    const archive = new Uint8Array(zstdDecompressSync(bytes));
    const paths: string[] = [];
    let at = 0;
    while (archive.subarray(at, at + 512).some((b) => b !== 0)) {
      const header = parseHeader(archive.subarray(at, at + 512));
      paths.push(header.path);
      at += 512 + Math.ceil(header.size / 512) * 512;
    }
    expect(paths).toEqual([
      "manifest.json",
      `blobs/${BLOB}`,
      "data/0/idb/0/schema.cbor",
      "data/0/idb/0/store-0.cbor",
      "data/0/local-storage.cbor",
    ]);
    expect(archive.length).toBe(at + 1024);
    const manifestSize = parseHeader(archive.subarray(0, 512)).size;
    const text = new TextDecoder().decode(archive.subarray(512, 512 + manifestSize));
    expect(text.startsWith('{"adapter":null,"contentHash":"')).toBe(true);
  });

  it("writes the same archive for the same input, whatever the file order", async () => {
    const a = sink();
    const b = sink();
    await writeSnapshot(input(), a.stream);
    await writeSnapshot(input([...defaultFiles()].reverse()), b.stream);
    expect(zstdDecompressSync(a.bytes())).toEqual(zstdDecompressSync(b.bytes()));
  });

  it("writes an empty snapshot", async () => {
    const out = sink();
    const result = await writeSnapshot({ ...input([]), storageKeys: [] }, out.stream);
    const validated = await validateSnapshot(chunks(out.bytes()), {
      compressedSize: out.bytes().length,
    });
    expect(validated.manifest.contentHash).toBe(result.contentHash);
  });

  it("round-trips through readEntries", async () => {
    const out = sink();
    await writeSnapshot(input(), out.stream);
    const size = { compressedSize: out.bytes().length };
    const { manifest } = await validateSnapshot(chunks(out.bytes()), size);
    const read: string[] = [];
    for await (const entry of readEntries(chunks(out.bytes()), manifest, size)) {
      read.push(entry.path);
    }
    expect(read).toHaveLength(4);
  });

  it.each([
    [
      "a path outside the grammar",
      [{ path: "data/0/extra.bin", bytes: ascii("x") }],
      "SNAP_UNEXPECTED_ENTRY",
    ],
    [
      "manifest.json as a data file",
      [{ path: "manifest.json", bytes: ascii("{}") }],
      "SNAP_UNEXPECTED_ENTRY",
    ],
    [
      "a storage key past storageKeys",
      [{ path: "data/1/local-storage.cbor", bytes: ascii("x") }],
      "SNAP_UNEXPECTED_ENTRY",
    ],
    [
      "the same path twice",
      [
        { path: "data/0/local-storage.cbor", bytes: ascii("x") },
        { path: "data/0/local-storage.cbor", bytes: ascii("y") },
      ],
      "SNAP_DUPLICATE_PATH",
    ],
  ] as const)("refuses %s and writes nothing", async (_, files, code) => {
    const out = sink();
    expect(await codeOfAsync(() => writeSnapshot(input([...files]), out.stream))).toBe(code);
    expect(out.parts).toHaveLength(0);
  });

  it("refuses invalid manifest fields and writes nothing", async () => {
    const out = sink();
    const bad = { ...input(), flushState: "maybe" } as unknown as SnapshotInput;
    expect(await codeOfAsync(() => writeSnapshot(bad, out.stream))).toBe("SNAP_MANIFEST_INVALID");
    const unsorted = {
      ...input([]),
      storageKeys: [
        { origin: "http://b.example", topLevelSite: null, role: "top" },
        { origin: "http://a.example", topLevelSite: null, role: "top" },
      ],
    } as SnapshotInput;
    expect(await codeOfAsync(() => writeSnapshot(unsorted, out.stream))).toBe(
      "SNAP_MANIFEST_INVALID",
    );
    expect(out.parts).toHaveLength(0);
  });

  it("does not write unknown top-level fields of its input", async () => {
    const out = sink();
    const extended = { ...input(), comment: "not in the format" } as SnapshotInput;
    await writeSnapshot(extended, out.stream);
    const archive = new TextDecoder().decode(zstdDecompressSync(out.bytes()));
    expect(archive).not.toContain("not in the format");
  });
});

describe("writeSnapshot refuses before writing whatever the reader would refuse (fix round 1)", () => {
  const schemaWith = (stores: number, indexes = 0) =>
    encodeSchema({
      name: "db",
      version: 1,
      stores: Array.from({ length: stores }, (_, s) => ({
        name: `s${String(s).padStart(3, "0")}`,
        keyPath: null,
        autoIncrement: false,
        keyGenerator: null,
        indexes: Array.from({ length: indexes }, (_, i) => ({
          name: `i${String(i).padStart(3, "0")}`,
          keyPath: "k",
          unique: false,
          multiEntry: false,
        })),
        records: 0,
      })),
    });
  const emptyStores = (n: number) =>
    Array.from({ length: n }, (_, s) => ({
      path: `data/0/idb/0/store-${s}.cbor`,
      bytes: new Uint8Array(0),
    }));

  /** The writer refuses with `code` and writes nothing; the reader gives the same code for the same files. */
  async function refusedLikeReader(
    files: SnapshotInput["files"],
    code: string,
    limits: Partial<Limits> = {},
  ): Promise<void> {
    const out = sink();
    expect(await codeOfAsync(() => writeSnapshot(input([...files]), out.stream, limits))).toBe(
      code,
    );
    expect(out.parts).toHaveLength(0);
    const same = snapshot(files.map((f) => ({ path: f.path, data: f.bytes })));
    expect(
      await codeOfAsync(() =>
        validateSnapshot(chunks(same), { compressedSize: same.length, limits }),
      ),
    ).toBe(code);
  }

  it("a store index at or above maxStoresPerDatabase", async () => {
    await refusedLikeReader(
      [
        { path: "data/0/idb/0/schema.cbor", bytes: schemaWith(0) },
        { path: "data/0/idb/0/store-300.cbor", bytes: new Uint8Array(0) },
      ],
      "SNAP_RECORD_INVALID",
    );
  });

  it("a database index at or above maxDatabasesPerKey, even one too long for the name field", async () => {
    await refusedLikeReader(
      [{ path: "data/0/idb/300/schema.cbor", bytes: schemaWith(0) }],
      "SNAP_RECORD_INVALID",
    );
    const out = sink();
    const long = [{ path: `data/0/idb/${"9".repeat(95)}/schema.cbor`, bytes: schemaWith(0) }];
    expect(await codeOfAsync(() => writeSnapshot(input(long), out.stream))).toBe(
      "SNAP_RECORD_INVALID",
    );
    expect(out.parts).toHaveLength(0);
  });

  it("more stores or indexes than the limits", async () => {
    const three = [{ path: "data/0/idb/0/schema.cbor", bytes: schemaWith(3) }, ...emptyStores(3)];
    await refusedLikeReader(three, "SNAP_RECORD_INVALID", { maxStoresPerDatabase: 2 });
    const indexed = [
      { path: "data/0/idb/0/schema.cbor", bytes: schemaWith(1, 3) },
      ...emptyStores(1),
    ];
    await refusedLikeReader(indexed, "SNAP_RECORD_INVALID", { maxIndexesPerStore: 2 });
  });

  it("the entry, manifest and total size limits and the entry count", async () => {
    const files = defaultFiles();
    await refusedLikeReader(files, "SNAP_TOO_MANY_ENTRIES", { maxEntries: files.length });
    await refusedLikeReader(files, "SNAP_ENTRY_TOO_LARGE", { maxEntryBytes: 10 });
    await refusedLikeReader(files, "SNAP_MANIFEST_TOO_LARGE", { maxManifestBytes: 100 });
    await refusedLikeReader(files, "SNAP_TOTAL_TOO_LARGE", { maxTotalBytes: 2048 });
  });
});
