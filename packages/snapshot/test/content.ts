// Test-only: the `content.json` notation of snapshot-format.md section 10 (a whole snapshot's storage in test notation),
// turned into the data files of a `.wgsnap` through the real record encoders, and back through the real decoders.
// Shared by the golden-vector generator (scripts/generate-vectors.ts) and the runner (src/vectors.test.ts). Node-only.
import { Writable } from "node:stream";
import type { Limits } from "../src/container/limits.js";
import { blobPath, localStoragePath, schemaPath, storePath } from "../src/container/paths.js";
import type { SnapshotFile, SnapshotInput } from "../src/container/writer.js";
import { writeSnapshot } from "../src/container/writer.js";
import { type CborItem, encodeItem } from "../src/record/cbor.js";
import {
  decodeLocalStorage,
  decodeSchema,
  decodeStoreRecords,
  encodeLocalStorage,
  encodeSchema,
  encodeStoreRecords,
  type KeyPath,
} from "../src/record/data-files.js";
import { type IdbKey, keyToItem } from "../src/record/idb-key.js";
import { toItem } from "../src/record/value-export.js";
import {
  bytesToHex,
  itemToNotation,
  type Notation,
  notationToItem,
  notationToValue,
  stringToStr16,
} from "./notation.js";

/** A name or key-path string: a JSON string, or a `str16` object for a string with a lone surrogate. */
export type StringNotation = Notation;
export type KeyPathNotation = StringNotation | StringNotation[] | null;

export interface IndexContent {
  name: StringNotation;
  keyPath: KeyPathNotation;
  unique: boolean;
  multiEntry: boolean;
}

export interface StoreContent {
  name: StringNotation;
  keyPath: KeyPathNotation;
  autoIncrement: boolean;
  keyGenerator: number | null;
  indexes: IndexContent[];
  /** `[key, value]` pairs in IndexedDB key order. */
  records: [Notation, Notation][];
}

export interface DatabaseContent {
  name: StringNotation;
  version: number;
  /** Sorted by name (code-unit order). */
  stores: StoreContent[];
}

export interface StorageKeyContent {
  origin: string;
  topLevelSite: string | null;
  role: "top" | "frame";
  /** `[key, value]` pairs sorted by key; empty when the snapshot has no `local-storage.cbor` for this key. */
  localStorage: [StringNotation, StringNotation][];
  /** Sorted by name (code-unit order). */
  indexedDB: DatabaseContent[];
}

export interface Content {
  /** In manifest order (section 4). */
  storageKeys: StorageKeyContent[];
}

/** The manifest fields every golden vector uses, so the generator is deterministic. Not covered by contentHash. */
export const VECTOR_FIELDS = {
  format: "wgsnap",
  formatVersion: 1,
  gameId: "019b76da-a800-7000-8000-000000000001",
  revisionId: "019b76da-a800-7000-8000-000000000002",
  parentRevisionId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  deviceId: "019b76da-a800-7000-8000-000000000003",
  exporter: { id: "generic-web-storage", version: "1.0.0" },
  adapter: null,
  gameVersion: null,
  flushState: "unconfirmed",
} as const;

const codeUnitOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function stringOfNotation(n: StringNotation): string {
  const s = notationToValue(n);
  if (typeof s !== "string") {
    throw new Error("a name, key path or localStorage item must be a string or str16");
  }
  return s;
}

/** A string in test notation: JSON text when well-formed, `str16` otherwise. */
export function stringNotation(s: string): StringNotation {
  return s.isWellFormed() ? s : { $: "str16", hex: stringToStr16(s) };
}

function keyPathOf(n: KeyPathNotation): KeyPath | null {
  if (n === null) {
    return null;
  }
  return Array.isArray(n) ? n.map(stringOfNotation) : stringOfNotation(n);
}

function keyPathNotation(path: KeyPath | null): KeyPathNotation {
  if (path === null) {
    return null;
  }
  return typeof path === "string" ? stringNotation(path) : path.map(stringNotation);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b);

/**
 * The data files of `content`, built by the real encoders: values through `toItem` (the exporter's path from a JS
 * value), keys through `keyToItem`. Each value and key is also built independently by `notationToItem`, and a
 * difference throws, so a bug in either side cannot slip into a vector.
 */
export async function contentToFiles(content: Content): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  const blobs = new Map<string, Uint8Array>();
  for (const [k, key] of content.storageKeys.entries()) {
    const local = encodeLocalStorage(
      key.localStorage.map(([name, value]) => [stringOfNotation(name), stringOfNotation(value)]),
    );
    if (local !== null) {
      files.push({ path: localStoragePath(k), bytes: local });
    }
    const databases = [...key.indexedDB].sort((a, b) =>
      codeUnitOrder(stringOfNotation(a.name), stringOfNotation(b.name)),
    );
    for (const [d, db] of databases.entries()) {
      const stores = [...db.stores].sort((a, b) =>
        codeUnitOrder(stringOfNotation(a.name), stringOfNotation(b.name)),
      );
      files.push({
        path: schemaPath(k, d),
        bytes: encodeSchema({
          name: stringOfNotation(db.name),
          version: db.version,
          stores: stores.map((store) => ({
            name: stringOfNotation(store.name),
            keyPath: keyPathOf(store.keyPath),
            autoIncrement: store.autoIncrement,
            keyGenerator: store.keyGenerator,
            indexes: store.indexes.map((index) => ({
              name: stringOfNotation(index.name),
              keyPath: keyPathOf(index.keyPath) as KeyPath,
              unique: index.unique,
              multiEntry: index.multiEntry,
            })),
            records: store.records.length,
          })),
        }),
      });
      for (const [s, store] of stores.entries()) {
        const records: [IdbKey, CborItem][] = [];
        for (const [keyNotation, valueNotation] of store.records) {
          const recordKey = notationToValue(keyNotation) as IdbKey;
          if (
            !sameBytes(encodeItem(keyToItem(recordKey)), encodeItem(notationToItem(keyNotation)))
          ) {
            throw new Error(
              `keyToItem and the notation disagree on ${JSON.stringify(keyNotation)}`,
            );
          }
          const item = await toItem(notationToValue(valueNotation), {
            onBlob: (sha256, bytes) => {
              blobs.set(sha256, bytes);
            },
          });
          if (!sameBytes(encodeItem(item), encodeItem(notationToItem(valueNotation)))) {
            throw new Error(`toItem and the notation disagree on ${JSON.stringify(valueNotation)}`);
          }
          records.push([recordKey, item]);
        }
        files.push({ path: storePath(k, d, s), bytes: encodeStoreRecords(records) });
      }
    }
  }
  for (const [sha256, bytes] of blobs) {
    files.push({ path: blobPath(sha256), bytes });
  }
  return files;
}

/**
 * `content.json` of a decoded snapshot: the manifest's storage keys and its data files (path to bytes), read through
 * the real decoders. Blob and File values carry the bytes of their `blobs/<sha256>` entry.
 */
export function filesToContent(
  storageKeys: readonly { origin: string; topLevelSite: string | null; role: "top" | "frame" }[],
  files: ReadonlyMap<string, Uint8Array>,
): Content {
  const blobBytes = (sha256: string) => {
    const bytes = files.get(blobPath(sha256));
    if (bytes === undefined) {
      throw new Error(`no blob entry ${sha256}`);
    }
    return bytes;
  };
  const toNotation = (item: CborItem) => itemToNotation(item, blobBytes);
  return {
    storageKeys: storageKeys.map(({ origin, topLevelSite, role }, k) => {
      const local = files.get(localStoragePath(k));
      const indexedDB: DatabaseContent[] = [];
      for (let d = 0; files.has(schemaPath(k, d)); d++) {
        const schema = decodeSchema(files.get(schemaPath(k, d)) as Uint8Array);
        indexedDB.push({
          name: stringNotation(schema.name),
          version: schema.version,
          stores: schema.stores.map((store, s) => ({
            name: stringNotation(store.name),
            keyPath: keyPathNotation(store.keyPath),
            autoIncrement: store.autoIncrement,
            keyGenerator: store.keyGenerator,
            indexes: store.indexes.map((index) => ({
              name: stringNotation(index.name),
              keyPath: keyPathNotation(index.keyPath),
              unique: index.unique,
              multiEntry: index.multiEntry,
            })),
            records: decodeStoreRecords(
              files.get(storePath(k, d, s)) ?? new Uint8Array(0),
              new Map(),
            ).map((record): [Notation, Notation] => [
              toNotation(keyToItem(record.key)),
              toNotation(record.value),
            ]),
          })),
        });
      }
      return {
        origin,
        topLevelSite,
        role,
        localStorage:
          local === undefined
            ? []
            : decodeLocalStorage(local).map(([name, value]): [StringNotation, StringNotation] => [
                stringNotation(name),
                stringNotation(value),
              ]),
        indexedDB,
      };
    }),
  };
}

/** Runs the real writer into memory and returns the `.wgsnap` bytes. */
export async function writeToBytes(
  input: SnapshotInput,
  limits: Partial<Limits> = {},
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  await writeSnapshot(input, sink, limits);
  return new Uint8Array(Buffer.concat(chunks));
}

/** The writer input of `content` with the fixed vector fields. */
export async function vectorInput(content: Content): Promise<SnapshotInput> {
  return {
    ...VECTOR_FIELDS,
    storageKeys: content.storageKeys.map(({ origin, topLevelSite, role }) => ({
      origin,
      topLevelSite,
      role,
    })),
    files: await contentToFiles(content),
  };
}
