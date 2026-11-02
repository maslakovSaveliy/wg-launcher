// The generic exporter, export side (save-transfer.md section 4, export steps 1 to 6), and the exporter object of one
// frame. Reads localStorage and IndexedDB only; never `document.cookie`, `cookieStore`, Cache Storage contents,
// `navigator.credentials` or service worker scripts.

import {
  compareIdbKeys,
  type DbSchema,
  encodeLocalStorage,
  encodeSchema,
  encodeStoreRecord,
  type IdbKey,
  type IndexSchema,
  type StoreSchema,
  toItem,
} from "@wg-launcher/snapshot";
import type { FrameEnv } from "./env.js";
import { FrameFailure, settle, within } from "./errors.js";
import { importFrame } from "./frame-importer.js";
import { keyPathOf, openExisting, request } from "./idb.js";
import { listDatabases, localStorageKeys, notExported, readInventory } from "./inventory.js";
import { probeKeyGenerator } from "./key-generator.js";
import { blobPath, localStoragePath, schemaPath, storePath } from "./paths.js";
import {
  type DatabaseSummary,
  type EntrySink,
  type FrameExporter,
  type FrameExportRequest,
  type FrameSummary,
  GENERIC_EXPORTER,
} from "./types.js";
import { wipeSelected } from "./wipe.js";

/** Records read per read-only transaction, so that memory stays bounded (export step 2). */
export const READ_CHUNK = 256;

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

class BlobWriter {
  private readonly written = new Set<string>();

  constructor(private readonly out: EntrySink) {}

  get count(): number {
    return this.written.size;
  }

  /** Each distinct blob is sent once (export step 4). */
  async write(sha256: string, bytes: Uint8Array): Promise<void> {
    if (!this.written.has(sha256)) {
      this.written.add(sha256);
      await this.out.write(blobPath(sha256), bytes);
    }
  }
}

function readSchemaShape(
  db: IDBDatabase,
  names: string[],
): Omit<StoreSchema, "keyGenerator" | "records">[] {
  if (names.length === 0) {
    return [];
  }
  const tx = db.transaction(names, "readonly");
  return names.map((name) => {
    const store = tx.objectStore(name);
    const indexes = [...store.indexNames].sort(byCodeUnits).map((indexName): IndexSchema => {
      const index = store.index(indexName);
      return {
        name: indexName,
        keyPath: keyPathOf(index.keyPath) as string | string[],
        unique: index.unique,
        multiEntry: index.multiEntry,
      };
    });
    return { name, keyPath: keyPathOf(store.keyPath), autoIncrement: store.autoIncrement, indexes };
  });
}

/** Every record of one store in key order, in chunks of READ_CHUNK records; returns the file bytes and the count. */
async function readStore(
  db: IDBDatabase,
  store: string,
  blobs: BlobWriter,
): Promise<{ bytes: Uint8Array; records: number }> {
  const parts: Uint8Array[] = [];
  let size = 0;
  let last: IdbKey | undefined;
  for (;;) {
    const range = last === undefined ? undefined : IDBKeyRange.lowerBound(last, true);
    const objectStore = db.transaction(store, "readonly").objectStore(store);
    const [keys, values] = await Promise.all([
      request(objectStore.getAllKeys(range, READ_CHUNK)),
      request(objectStore.getAll(range, READ_CHUNK)),
    ]);
    if (keys.length !== values.length) {
      throw new FrameFailure("INTERNAL", "keys and values of a chunk differ in number");
    }
    for (const [i, key] of (keys as IdbKey[]).entries()) {
      // A store file must be strictly ascending in the codec's key order (snapshot-format.md section 7.3).
      if (last !== undefined && compareIdbKeys(last, key) >= 0) {
        throw new FrameFailure("INTERNAL", "IndexedDB returned keys out of order");
      }
      const item = await within({ recordKey: key }, () =>
        toItem(values[i], { onBlob: (sha256, bytes) => blobs.write(sha256, bytes) }),
      );
      const record = encodeStoreRecord(key, item);
      parts.push(record);
      size += record.length;
      last = key;
    }
    if (keys.length < READ_CHUNK) {
      break;
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, records: parts.length };
}

async function exportDatabase(
  db: IDBDatabase,
  target: { keyIndex: number; d: number },
  out: EntrySink,
  blobs: BlobWriter,
): Promise<DatabaseSummary> {
  const names = [...db.objectStoreNames].sort(byCodeUnits);
  const shapes = readSchemaShape(db, names);
  const stores: StoreSchema[] = [];
  for (const [s, shape] of shapes.entries()) {
    const store = await within({ store: shape.name }, async () => {
      const { bytes, records } = await readStore(db, shape.name, blobs);
      // The probe is the only write an export makes, and it is aborted (export step 3).
      const keyGenerator = shape.autoIncrement ? await probeKeyGenerator(db, shape.name) : null;
      await out.write(storePath(target.keyIndex, target.d, s), bytes);
      return { ...shape, keyGenerator, records };
    });
    stores.push(store);
  }
  const schema: DbSchema = { name: db.name, version: db.version, stores };
  await out.write(schemaPath(target.keyIndex, target.d), encodeSchema(schema));
  return {
    name: db.name,
    version: db.version,
    stores: stores.length,
    records: stores.reduce((n, s) => n + s.records, 0),
  };
}

export async function exportFrame(
  env: FrameEnv,
  { keyIndex, storageKey, scope }: FrameExportRequest,
  out: EntrySink,
): Promise<FrameSummary> {
  return within({ storageKey }, async () => {
    const blobs = new BlobWriter(out);
    const keys = localStorageKeys(env, scope.localStorage);
    const items = keys.map((key): [string, string] => {
      const value = env.localStorage.getItem(key);
      if (value === null) {
        // Listed but gone when read: something wrote to the frame during the export. Never export a changed value.
        throw new FrameFailure(
          "EXP_QUIESCENCE_VIOLATION",
          "a localStorage item vanished while it was read",
        );
      }
      return [key, value];
    });
    const localStorageBytes = encodeLocalStorage(items);
    if (localStorageBytes !== null) {
      await out.write(localStoragePath(keyIndex), localStorageBytes);
    }
    const databases: DatabaseSummary[] = [];
    for (const { name } of await listDatabases(env, scope.indexedDB)) {
      const summary = await within({ database: name }, async () => {
        const db = await openExisting(env.indexedDB, name);
        if (db === null) {
          return null; // deleted after the listing: skipped
        }
        try {
          return await exportDatabase(db, { keyIndex, d: databases.length }, out, blobs);
        } finally {
          db.close();
        }
      });
      if (summary !== null) {
        databases.push(summary);
      }
    }
    return {
      localStorageItems: items.length,
      databases,
      blobs: blobs.count,
      notExported: await notExported(env),
    };
  });
}

/** The generic exporter of one frame. Every method returns an error value instead of throwing. */
export function createFrameExporter(env: FrameEnv): FrameExporter {
  return {
    info: GENERIC_EXPORTER,
    inventory: () => settle(() => readInventory(env)),
    exportFrame: (req, out) => settle(() => exportFrame(env, req, out)),
    importFrame: (source, plan) => settle(() => importFrame(env, source, plan), "import"),
    wipeSelected: (scope) => settle(() => wipeSelected(env, scope), "import"),
  };
}
