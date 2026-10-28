// ONE-TIME generator of the frozen golden vectors in `test-vectors/v1/` (snapshot-format.md section 10). The vectors are
// a cross-language contract: they were generated once and committed, and change only with a new formatVersion or a
// reviewed correction. Never regenerate them to make a test pass. Run (Node 24, from the repository root):
//
//   pnpm --filter @wg-launcher/snapshot exec node --experimental-transform-types scripts/generate-vectors.ts [--out <dir>] [--overwrite]
//
// Without `--out` it writes `packages/snapshot/test-vectors/v1/` and refuses to touch an existing directory unless
// `--overwrite` is given (which deletes it first). `--out <dir>` writes elsewhere, for example to check determinism.
//
// Valid vectors are written by the real `writeSnapshot` from their `content.json` (test/content.ts); invalid vectors are
// raw bytes built with test/wgsnap.ts from a valid base with exactly one change. Before anything is written, every
// vector is validated: a valid one must decode back to its content, an invalid one must fail with exactly its code
// (whole file and one-byte chunks), and its base must pass, so each fails for its own reason and no earlier one.
//
// Node strips the types but does not map the `.js` import specifiers of this code base to their `.ts` files, so a
// resolve hook does that, and the project modules are imported only after it is registered.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { zstdDecompressSync } from "node:zlib";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relativeJs = /^\.\.?\//.test(specifier) && specifier.endsWith(".js");
      if (relativeJs && (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

const { validateSnapshot, readEntries } = await import("../src/container/index.js");
const { encodeLocalStorage, encodeSchema, encodeStoreRecords } = await import(
  "../src/record/data-files.js"
);
const { hexToBytes, sha256Hex, bytesToHex } = await import("../test/notation.js");
const content = await import("../test/content.js");
const w = await import("../test/wgsnap.js");

type Content = import("../test/content.js").Content;
type Notation = import("../test/notation.js").Notation;
type Limits = import("../src/container/limits.js").Limits;
type SnapFile = import("../test/wgsnap.js").SnapFile;
type SnapshotOptions = import("../test/wgsnap.js").SnapshotOptions;
type TarFile = import("../test/wgsnap.js").TarFile;

const { values: args } = parseArgs({
  options: { out: { type: "string" }, overwrite: { type: "boolean", default: false } },
});
const DEFAULT_OUT = fileURLToPath(new URL("../test-vectors/v1/", import.meta.url));
const out = args.out ?? DEFAULT_OUT;
if (existsSync(out)) {
  if (!args.overwrite) {
    console.error(
      `${out} exists. The golden vectors are frozen: regenerate only with a new formatVersion or a reviewed ` +
        "correction, and then pass --overwrite.",
    );
    process.exit(1);
  }
  rmSync(out, { recursive: true });
}

// --- valid vectors -------------------------------------------------------------------------------------------------

const FIRST_PARTY = { origin: "http://localhost:4417", topLevelSite: null, role: "top" } as const;
const TIME = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00.000Z
const date = (ms: number): Notation => ({ $: "date", v: ms });
const f64 = (hex: string): Notation => ({ $: "f64", hex });
const object = (...entries: [Notation, Notation][]): Notation => ({ $: "object", entries });
const view = (type: string, hex: string): Notation => ({ $: "view", type, hex });
const range = (n: number, at = 0) => bytesToHex(Uint8Array.from({ length: n }, (_, i) => at + i));
const NAN = "7ff8000000000000";

interface ValidVector {
  id: string;
  description: string;
  content: Content;
}

const minimal: Content = {
  storageKeys: [
    {
      ...FIRST_PARTY,
      localStorage: [
        ["best", "2048"],
        ["theme", "dark"],
      ],
      indexedDB: [],
    },
  ],
};

// The blob and the file are the first two data entries of the tar (`blobs/` sorts before `data/`); both are longer
// than 100 bytes, so invalid-truncated-tar can cut 100 bytes into the second entry whichever hash sorts first.
const fileBytes = new TextEncoder().encode(
  "PLAB golden vector file content: deterministic bytes of a File value, longer than one hundred bytes.\n",
);
const binaryTypes: Content = {
  storageKeys: [
    {
      ...FIRST_PARTY,
      localStorage: [],
      indexedDB: [
        {
          name: "binary",
          version: 1,
          stores: [
            {
              name: "values",
              keyPath: null,
              autoIncrement: false,
              keyGenerator: null,
              indexes: [],
              records: [
                [1, date(TIME + 123)],
                [date(TIME), "a Date key"],
                ["arraybuffer", { $: "bytes", hex: "00010203fffe" }],
                ["blob", { $: "blob", type: "image/svg+xml", hex: range(256) }],
                ["dataview", view("DataView", "0a0b0c")],
                [
                  "file",
                  {
                    $: "file",
                    name: "slot1.dat",
                    lastModified: TIME,
                    type: "application/octet-stream",
                    hex: bytesToHex(fileBytes),
                  },
                ],
                [
                  "partial-view",
                  {
                    $: "view",
                    type: "Uint16Array",
                    hex: "02030405",
                    bufferHex: "0001020304050607",
                    byteOffset: 2,
                    length: 2,
                  },
                ],
                [
                  "typed-arrays",
                  object(
                    ["BigInt64Array", view("BigInt64Array", "ffffffffffffffff")],
                    ["BigUint64Array", view("BigUint64Array", "0100000000000000")],
                    ["Float16Array", view("Float16Array", "003c")],
                    ["Float32Array", view("Float32Array", "0000803f")],
                    ["Float64Array", view("Float64Array", "000000000000f03f")],
                    ["Int16Array", view("Int16Array", "0080ffff")],
                    ["Int32Array", view("Int32Array", "ffffffff")],
                    ["Int8Array", view("Int8Array", "80ff")],
                    ["Uint16Array", view("Uint16Array", "0100ffff")],
                    ["Uint32Array", view("Uint32Array", "01000000")],
                    ["Uint8Array", view("Uint8Array", "00ff")],
                    ["Uint8ClampedArray", view("Uint8ClampedArray", "00ff")],
                  ),
                ],
                [{ $: "bytes", hex: "00ff" }, "a binary key"],
                [["slot", 1, date(TIME), { $: "bytes", hex: "01" }], "an array key"],
              ],
            },
          ],
        },
      ],
    },
  ],
};

const specialValues: Content = {
  storageKeys: [
    {
      ...FIRST_PARTY,
      localStorage: [["surrogate", { $: "str16", hex: "6100" + "00d8" }]],
      indexedDB: [
        {
          name: "special",
          version: 1,
          stores: [
            {
              name: "values",
              keyPath: null,
              autoIncrement: false,
              keyGenerator: null,
              indexes: [],
              records: [
                [
                  "bigint",
                  [
                    { $: "bigint", v: "123456789012345678901234567890" },
                    { $: "bigint", v: "-1" },
                    { $: "bigint", v: "0" },
                  ],
                ],
                [
                  "boxed",
                  [
                    { $: "boxed", v: true },
                    { $: "boxed", v: 42 },
                    { $: "boxed", v: "text" },
                    { $: "boxed", v: { $: "bigint", v: "7" } },
                  ],
                ],
                [
                  "floats",
                  [
                    f64("8000000000000000"), // -0
                    f64(NAN),
                    f64("7ff0000000000000"), // Infinity
                    f64("fff0000000000000"), // -Infinity
                    f64("3fb999999999999a"), // 0.1 (binary64)
                    f64("3ff8000000000000"), // 1.5 (binary16)
                    f64("4340000000000000"), // 2^53, not a safe integer
                  ],
                ],
                ["invalid-date", { $: "date", v: f64(NAN) }],
                ["lone-surrogate", { $: "str16", hex: "6100" + "00d8" }],
                [
                  "map",
                  {
                    $: "map",
                    entries: [
                      [1, "number key"],
                      ["1", "string key"],
                      [f64(NAN), "NaN key"],
                      [object(), "object key"],
                    ],
                  },
                ],
                [
                  "missing-vs-undefined",
                  [object(["a", 1], ["b", { $: "undefined" }]), object(["a", 1])],
                ],
                [
                  "object-keys",
                  object(
                    ["2", "index key first"],
                    ["z", 1],
                    [{ $: "str16", hex: "00dc" }, "lone surrogate key"],
                  ),
                ],
                ["regexp", { $: "regexp", source: "^wg(?<n>[0-9]+)$", flags: "dgimsuy" }],
                ["set", { $: "set", items: [1, "1", f64(NAN), null, { $: "undefined" }] }],
                [
                  "sparse",
                  {
                    $: "sparse",
                    length: 5,
                    entries: [
                      ["1", "b"],
                      ["3", { $: "undefined" }],
                      ["extra", true],
                    ],
                  },
                ],
                ["undefined", { $: "undefined" }],
              ],
            },
          ],
        },
      ],
    },
  ],
};

const STATE = '{"level":1,"coins":10,"inventory":[],"steps":1}';
const partitionedIframe: Content = {
  storageKeys: [
    {
      origin: "http://127.0.0.1:4417",
      topLevelSite: "http://localhost",
      role: "frame",
      localStorage: [
        ["progress-lab:format", "1"],
        ["progress-lab:state", STATE],
      ],
      indexedDB: [
        {
          name: "progress-lab",
          version: 1,
          stores: [
            {
              name: "profile",
              keyPath: "id",
              autoIncrement: false,
              keyGenerator: null,
              indexes: [{ name: "by-level", keyPath: "level", unique: false, multiEntry: false }],
              records: [
                [
                  "player",
                  object(
                    ["id", "player"],
                    ["level", 1],
                    ["coins", 10],
                    ["inventory", []],
                    ["updatedAt", date(TIME + 60_123)],
                  ),
                ],
              ],
            },
          ],
        },
      ],
    },
    { ...FIRST_PARTY, localStorage: [["iframe-host:loaded", "1"]], indexedDB: [] },
  ],
};

// progress-lab's slot1.dat layout: "PLAB", layout byte 1, level, coins, steps, inventory size (uint32 LE), SHA-256.
const u32 = (n: number) => bytesToHex(new Uint8Array(new Uint32Array([n]).buffer));
const slot = `504c414201${u32(2)}${u32(60)}${u32(6)}${u32(2)}${sha256Hex(new TextEncoder().encode(STATE))}`;
const idbfs: Content = {
  storageKeys: [
    {
      ...FIRST_PARTY,
      localStorage: [],
      indexedDB: [
        {
          name: "/home/web_user",
          version: 21,
          stores: [
            {
              name: "FILE_DATA",
              keyPath: null,
              autoIncrement: false,
              keyGenerator: null,
              indexes: [
                { name: "timestamp", keyPath: "timestamp", unique: false, multiEntry: false },
              ],
              records: [
                ["/home/web_user", object(["timestamp", date(TIME + 123)], ["mode", 16877])],
                [
                  "/home/web_user/save",
                  object(["timestamp", date(TIME + 360_123)], ["mode", 16877]),
                ],
                [
                  "/home/web_user/save/slot1.dat",
                  object(
                    ["timestamp", date(TIME + 360_123)],
                    ["mode", 33206],
                    ["contents", view("Uint8Array", slot)],
                  ),
                ],
              ],
            },
          ],
        },
      ],
    },
  ],
};

const keyGenerator: Content = {
  storageKeys: [
    {
      ...FIRST_PARTY,
      localStorage: [],
      indexedDB: [
        {
          name: "progress-lab",
          version: 1,
          stores: [
            {
              name: "inline",
              keyPath: "id",
              autoIncrement: true,
              keyGenerator: 4,
              indexes: [],
              records: [[3, object(["id", 3])]],
            },
            {
              name: "stepLog",
              keyPath: null,
              autoIncrement: true,
              keyGenerator: 9,
              indexes: [],
              records: [
                [1, object(["step", 1], ["coinsGained", 10])],
                [2, object(["step", 2], ["coinsGained", 10])],
                [5, object(["step", 5], ["coinsGained", 10])],
              ],
            },
          ],
        },
      ],
    },
  ],
};

const validVectors: ValidVector[] = [
  {
    id: "valid-minimal",
    description: "One first-party storage key with two localStorage items",
    content: minimal,
  },
  {
    id: "valid-binary-types",
    description:
      "IndexedDB records with a Date, an ArrayBuffer, every typed array, a DataView, a partial view, a Blob and a " +
      "File (both above 100 bytes), and number, Date, string, binary and array keys",
    content: binaryTypes,
  },
  {
    id: "valid-special-values",
    description:
      "-0, NaN, +-Infinity, other floats, undefined beside a missing property, BigInt, a sparse array with holes and " +
      "an extra property, Map, Set, boxed values, RegExp, an invalid Date and lone surrogates (value, object key, " +
      "localStorage value)",
    content: specialValues,
  },
  {
    id: "valid-partitioned-iframe",
    description:
      "A partitioned key (http://127.0.0.1:4417 under http://localhost, role frame) with localStorage and " +
      "IndexedDB, and a first-party key, like progress-lab variant c",
    content: partitionedIframe,
  },
  {
    id: "valid-idbfs",
    description:
      "The progress-lab IDBFS shape: database /home/web_user version 21, store FILE_DATA without a key path, index " +
      "timestamp, two directories and one 53-byte file",
    content: idbfs,
  },
  {
    id: "valid-key-generator",
    description:
      "autoIncrement stores whose keyGenerator is above the highest key: stepLog (keys 1, 2, 5, generator 9) and " +
      "inline with key path id (key 3, generator 4)",
    content: keyGenerator,
  },
  {
    id: "valid-empty",
    description: "No storage keys and no data files (a backup of an empty partition)",
    content: { storageKeys: [] },
  },
];

// --- invalid vectors -----------------------------------------------------------------------------------------------

interface InvalidVector {
  id: string;
  description: string;
  limits: Partial<Limits>;
  error: string;
  bytes: Uint8Array;
  /** The valid input this vector changes in one place, and the limits under which it passes. */
  base: Uint8Array;
  baseLimits: Partial<Limits>;
}

const ascii = w.ascii;
/** The manifest fields of the valid vectors, set before contentHash is computed. */
const fixed = (m: Record<string, unknown>) => {
  Object.assign(m, structuredClone(content.VECTOR_FIELDS));
};
const withFixed = (options: SnapshotOptions = {}): SnapshotOptions => ({
  ...options,
  edit: (m) => {
    fixed(m);
    options.edit?.(m);
  },
});
const snap = (files: SnapFile[], options: SnapshotOptions = {}) =>
  w.snapshot(files, withFixed(options));
const snapTar = (files: SnapFile[], options: SnapshotOptions = {}) =>
  w.snapshotTar(files, withFixed(options));

/** The valid base of most invalid vectors: valid-minimal's data (one first-party key, two localStorage items). */
const BASE_FILES: SnapFile[] = [
  {
    path: "data/0/local-storage.cbor",
    data: encodeLocalStorage([
      ["best", "2048"],
      ["theme", "dark"],
    ]) as Uint8Array,
  },
];
const BASE_TAR = snapTar(BASE_FILES);
const BASE = w.zstd(BASE_TAR);
/** The base with `extra` tar entries right after the manifest. */
const withExtra = (extra: TarFile[]) =>
  snap(BASE_FILES, { layout: (m, rest) => [m, ...extra, ...rest] });

/** A pax record `<length> <key>=<value>\n`, where the length counts the whole record. */
function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) {
    length++;
  }
  return ascii(`${length}${body}`);
}

/** A localStorage file of one item whose value is `n` characters long. */
const bigLocalStorage = (n: number): SnapFile[] => [
  {
    path: "data/0/local-storage.cbor",
    data: encodeLocalStorage([["big", "x".repeat(n)]]) as Uint8Array,
  },
];

/** A database `game` with one store `records` holding the record file `store` (one record). */
const recordFiles = (store: Uint8Array): SnapFile[] => [
  ...BASE_FILES,
  {
    path: "data/0/idb/0/schema.cbor",
    data: encodeSchema({
      name: "game",
      version: 1,
      stores: [
        {
          name: "records",
          keyPath: null,
          autoIncrement: false,
          keyGenerator: null,
          indexes: [],
          records: 1,
        },
      ],
    }),
  },
  { path: "data/0/idb/0/store-0.cbor", data: store },
];

async function invalidVectors(binaryTypesInput: Uint8Array): Promise<InvalidVector[]> {
  const vectors: InvalidVector[] = [];
  const add = (
    id: string,
    error: string,
    description: string,
    bytes: Uint8Array,
    base: Uint8Array = BASE,
    limits: Partial<Limits> = {},
    baseLimits: Partial<Limits> = limits,
  ) => vectors.push({ id, error, description, bytes, base, limits, baseLimits });

  // M6 (Phase 1 plan): the first floor(length / 2) bytes of valid-binary-types.
  const half = Math.floor(binaryTypesInput.length / 2);
  add(
    "invalid-truncated",
    "SNAP_TRUNCATED",
    `The input.wgsnap of valid-binary-types (${binaryTypesInput.length} bytes) cut to its first ` +
      `floor(${binaryTypesInput.length} / 2) = ${half} bytes: the file ends inside the zstd frame`,
    binaryTypesInput.slice(0, half),
    binaryTypesInput,
  );

  // M6 (Phase 1 plan): a complete checksummed frame whose tar ends 100 bytes into the data of the second entry.
  const binaryTar = new Uint8Array(zstdDecompressSync(binaryTypesInput));
  const second = w.listTar(binaryTar)[1];
  if (second === undefined || second.size < 100) {
    throw new Error("the second entry of valid-binary-types must hold at least 100 bytes");
  }
  const cut = second.dataAt + 100;
  add(
    "invalid-truncated-tar",
    "SNAP_TRUNCATED",
    `A complete checksummed zstd frame holding the tar of valid-binary-types cut to its first ${cut} bytes: the ` +
      `manifest, the header of the second entry ${second.path} (${second.size} bytes of data) and only the first ` +
      "100 bytes of its data",
    w.zstd(binaryTar.slice(0, cut)),
    binaryTypesInput,
  );

  add(
    "invalid-not-zstd",
    "SNAP_ZSTD_INVALID",
    "The uncompressed tar of a valid snapshot, not wrapped in zstd: the file starts with the bytes of " +
      "manifest.json instead of the magic 28 b5 2f fd",
    BASE_TAR,
  );
  add(
    "invalid-no-checksum",
    "SNAP_ZSTD_NO_CHECKSUM",
    "A valid snapshot's tar in a zstd frame without the content checksum flag",
    w.zstd(BASE_TAR, false),
  );

  const escapeData = ascii("escape\n");
  // Built from its code point, so no editor or formatter can normalize the decomposed path in this source file.
  const ACUTE = String.fromCodePoint(0x0301);
  add(
    "invalid-traversal",
    "SNAP_PATH_TRAVERSAL",
    "A regular file named ../escape.txt after the manifest",
    withExtra([{ path: "../escape.txt", data: escapeData }]),
  );
  add(
    "invalid-absolute",
    "SNAP_ABSOLUTE_PATH",
    "A regular file named /etc/escape after the manifest",
    withExtra([{ path: "/etc/escape", data: escapeData }]),
  );
  add(
    "invalid-symlink",
    "SNAP_SYMLINK",
    "A symbolic link entry data/0/link pointing to /etc/passwd after the manifest",
    withExtra([{ path: "data/0/link", header: { typeflag: "2", linkname: "/etc/passwd" } }]),
  );
  add(
    "invalid-hardlink",
    "SNAP_HARDLINK",
    "A hard link entry data/0/link to manifest.json after the manifest",
    withExtra([{ path: "data/0/link", header: { typeflag: "1", linkname: "manifest.json" } }]),
  );
  add(
    "invalid-device",
    "SNAP_DEVICE",
    "A character device entry data/0/tty after the manifest",
    withExtra([{ path: "data/0/tty", header: { typeflag: "3" } }]),
  );
  add(
    "invalid-pax",
    "SNAP_UNSUPPORTED_ENTRY_TYPE",
    "A pax extended header (typeflag x) for data/0/local-storage.cbor between the manifest and that file",
    withExtra([
      {
        path: "PaxHeaders/local-storage.cbor",
        data: paxRecord("path", "data/0/local-storage.cbor"),
        header: { typeflag: "x" },
      },
    ]),
  );
  add(
    "invalid-non-nfc",
    "SNAP_NON_NFC_PATH",
    "A regular file data/0/cafe<U+0301>.cbor (e followed by U+0301 COMBINING ACUTE ACCENT, not NFC) after the manifest",
    withExtra([{ path: `data/0/cafe${ACUTE}.cbor`, data: escapeData }]),
  );
  add(
    "invalid-duplicate-path",
    "SNAP_DUPLICATE_PATH",
    "data/0/local-storage.cbor twice, with the same bytes, after the manifest",
    snap(BASE_FILES, { layout: (m, rest) => [m, ...rest, ...rest] }),
  );

  // 10 storage keys with one localStorage file each: 11 entries, valid with the default maxEntries.
  const tenKeys = Array.from({ length: 10 }, (_, i) => ({
    origin: `http://localhost:${4401 + i}`,
    topLevelSite: null,
    role: "top",
  }));
  const tenFiles = tenKeys.map((_, i) => ({
    path: `data/${i}/local-storage.cbor`,
    data: encodeLocalStorage([["slot", String(i)]]) as Uint8Array,
  }));
  const eleven = snap(tenFiles, { storageKeys: tenKeys });
  add(
    "invalid-too-many-entries",
    "SNAP_TOO_MANY_ENTRIES",
    "11 entries (manifest.json and the localStorage files of 10 storage keys) with maxEntries 10; valid with the " +
      "default limits",
    eleven,
    eleven,
    { maxEntries: 10 },
    {},
  );

  const big = bigLocalStorage(1500);
  const bigBytes = snap(big);
  const bigSize = (big[0] as SnapFile).data.length;
  add(
    "invalid-oversize-file",
    "SNAP_ENTRY_TOO_LARGE",
    `data/0/local-storage.cbor has ${bigSize} bytes in its header with maxEntryBytes 1024 (manifest.json is ` +
      "smaller); valid with the default limits",
    bigBytes,
    bigBytes,
    { maxEntryBytes: 1024 },
    {},
  );
  const bigTarLength = snapTar(big).length;
  add(
    "invalid-total-oversize",
    "SNAP_TOTAL_TOO_LARGE",
    `A tar stream of ${bigTarLength} bytes (manifest.json and a ${bigSize}-byte data/0/local-storage.cbor) with ` +
      "maxTotalBytes 2048, which the localStorage file crosses; valid with the default limits",
    bigBytes,
    bigBytes,
    { maxTotalBytes: 2048 },
    {},
  );

  // R11: the tar may hold at most max(ratioFloorBytes, maxRatio x compressedSize) bytes.
  const zeros = new Uint8Array(256 * 1024);
  const bombStore = encodeStoreRecords([[1, { k: "bytes", v: zeros }]]);
  const bomb = snap(recordFiles(bombStore));
  const floor = 65536;
  const bound = Math.max(floor, 200 * bomb.length);
  const bombTar = snapTar(recordFiles(bombStore)).length;
  if (bombTar <= bound) {
    throw new Error("the ratio bomb does not cross its bound");
  }
  add(
    "invalid-ratio-bomb",
    "SNAP_RATIO_EXCEEDED",
    `A record holding ${zeros.length} zero bytes: ${bomb.length} compressed bytes expand to a ` +
      `${bombTar}-byte tar, above max(ratioFloorBytes ${floor}, maxRatio 200 x ${bomb.length} = ${200 * bomb.length}); ` +
      "valid with the default limits",
    bomb,
    bomb,
    { ratioFloorBytes: floor },
    {},
  );

  add(
    "invalid-missing-manifest",
    "SNAP_MISSING_MANIFEST",
    "The first regular file is data/0/local-storage.cbor; manifest.json comes after it",
    snap(BASE_FILES, { layout: (m, rest) => [...rest, m] }),
  );
  add(
    "invalid-manifest-not-canonical",
    "SNAP_MANIFEST_INVALID",
    "manifest.json with the same members, serialized with two-space indentation instead of JCS",
    snap(BASE_FILES, { manifestText: (t) => JSON.stringify(JSON.parse(t), null, 2) }),
  );
  add(
    "invalid-unknown-version",
    "SNAP_UNSUPPORTED_VERSION",
    "formatVersion 2 in an otherwise unchanged manifest",
    snap(BASE_FILES, {
      edit: (m) => {
        m.formatVersion = 2;
      },
    }),
  );
  let changedDigit = "";
  const badContentHash = snap(BASE_FILES, {
    manifestText: (t) =>
      t.replace(/"contentHash":"([0-9a-f])/, (_, digit: string) => {
        const other = digit === "0" ? "1" : "0";
        changedDigit = `${digit} to ${other}`;
        return `"contentHash":"${other}`;
      }),
  });
  add(
    "invalid-bad-content-hash",
    "SNAP_CONTENT_HASH_MISMATCH",
    `The first hex digit of contentHash changed from ${changedDigit}; the manifest is still canonical`,
    badContentHash,
  );

  const local = w.listTar(BASE_TAR)[1] as { dataAt: number; size: number };
  const flipped = BASE_TAR.slice();
  const at = local.dataAt + local.size - 1;
  flipped[at] = (flipped[at] as number) ^ 0x20; // "dark" becomes "darK": still valid CBOR text
  add(
    "invalid-bad-hash",
    "SNAP_ENTRY_HASH_MISMATCH",
    "The last byte of data/0/local-storage.cbor changed (k to K in the value dark); the manifest is unchanged",
    w.zstd(flipped),
  );
  add(
    "invalid-unexpected-entry",
    "SNAP_UNEXPECTED_ENTRY",
    "A regular file data/0/extra.bin after the manifest that the manifest does not list",
    withExtra([{ path: "data/0/extra.bin", data: ascii("extra") }]),
  );

  const recordBase = snap(recordFiles(hexToBytes("820101")));
  add(
    "invalid-noncanonical-record",
    "SNAP_RECORD_INVALID",
    "data/0/idb/0/store-0.cbor holds the record [1, 1] with the value written as the float f9 3c00 (1.0) instead " +
      "of the integer 01 (bytes 82 01 f9 3c 00); the manifest hashes match the bytes",
    snap(recordFiles(hexToBytes("8201f93c00"))),
    recordBase,
  );
  add(
    "invalid-unknown-tag",
    "SNAP_RECORD_INVALID",
    "data/0/idb/0/store-0.cbor holds the record [1, 33199(1)]: tag 33199 is not in the value model (bytes 82 01 d9 " +
      "81 af 01); the manifest hashes match the bytes",
    snap(recordFiles(hexToBytes("8201d981af01"))),
    recordBase,
  );
  add(
    "invalid-trailing-data",
    "SNAP_TRAILING_DATA",
    "One 512-byte block starting with the text trailing data after the two tar end blocks, inside the zstd frame",
    snap(BASE_FILES, { after: w.padded(ascii("trailing data")) }),
  );
  return vectors;
}

// --- checks and output ---------------------------------------------------------------------------------------------

const readOptions = (bytes: Uint8Array, limits: Partial<Limits>) => ({
  compressedSize: bytes.length,
  limits,
});

async function decodeContent(
  bytes: Uint8Array,
): Promise<{ content: Content; contentHash: string }> {
  const validated = await validateSnapshot(w.chunks(bytes), readOptions(bytes, {}));
  const files = new Map<string, Uint8Array>();
  for await (const entry of readEntries(
    w.chunks(bytes),
    validated.manifest,
    readOptions(bytes, {}),
  )) {
    files.set(entry.path, entry.bytes);
  }
  return {
    content: content.filesToContent(validated.manifest.storageKeys, files),
    contentHash: validated.manifest.contentHash,
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const written: { id: string; files: Record<string, string | Uint8Array> }[] = [];

let binaryTypesInput: Uint8Array | undefined;
for (const vector of validVectors) {
  const bytes = await content.writeToBytes(await content.vectorInput(vector.content));
  const decoded = await decodeContent(bytes);
  if (JSON.stringify(decoded.content) !== JSON.stringify(vector.content)) {
    throw new Error(
      `${vector.id}: the content does not decode back to itself (not in canonical order?)`,
    );
  }
  if (vector.id === "valid-binary-types") {
    binaryTypesInput = bytes;
  }
  written.push({
    id: vector.id,
    files: {
      "vector.json": json({
        vectorFormat: 1,
        id: vector.id,
        description: vector.description,
        input: "input.wgsnap",
        limits: {},
        expect: { ok: true, contentHash: decoded.contentHash, content: "content.json" },
      }),
      "input.wgsnap": bytes,
      "content.json": json(vector.content),
    },
  });
}

for (const vector of await invalidVectors(binaryTypesInput as Uint8Array)) {
  await validateSnapshot(w.chunks(vector.base), readOptions(vector.base, vector.baseLimits)).catch(
    (error: unknown) => {
      throw new Error(`${vector.id}: the base does not validate: ${String(error)}`);
    },
  );
  for (const size of [vector.bytes.length, 1]) {
    const code = await w.codeOfAsync(() =>
      validateSnapshot(w.chunks(vector.bytes, size), readOptions(vector.bytes, vector.limits)),
    );
    if (code !== vector.error) {
      throw new Error(`${vector.id}: expected ${vector.error}, got ${code} (${size}-byte chunks)`);
    }
  }
  written.push({
    id: vector.id,
    files: {
      "vector.json": json({
        vectorFormat: 1,
        id: vector.id,
        description: vector.description,
        input: "input.wgsnap",
        limits: vector.limits,
        expect: { ok: false, error: vector.error },
      }),
      "input.wgsnap": vector.bytes,
    },
  });
}

mkdirSync(out, { recursive: true });
writeFileSync(`${out}/index.json`, json(written.map((v) => v.id)));
for (const vector of written) {
  mkdirSync(`${out}/${vector.id}`);
  for (const [name, data] of Object.entries(vector.files)) {
    writeFileSync(`${out}/${vector.id}/${name}`, data);
  }
}
console.log(`wrote ${written.length} vectors to ${out}`);
