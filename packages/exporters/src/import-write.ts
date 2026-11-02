// The generic exporter, import side, write pass (save-transfer.md section 4, import steps 2 to 4): localStorage, then
// each database at its recorded version in bounded put transactions, then the key generators. The check pass in
// frame-importer.ts has decoded every entry and built every value once before this runs. A failure here can leave
// earlier writes behind; the importer does not undo them (the restore's rollback does).

import {
  type DbSchema,
  decodeStoreRecords,
  fromItem,
  type StoreRecord,
  type StoreSchema,
} from "@wg-launcher/snapshot";
import type { FrameEnv } from "./env.js";
import {
  at as atAny,
  errorName,
  FrameFailure,
  isQuotaError,
  within as withinAny,
} from "./errors.js";
import { done } from "./idb.js";
import { generatorAfter, raiseKeyGenerator } from "./key-generator.js";
import { storePath } from "./paths.js";
import type { DatabaseSummary, FrameErrorDetail } from "./types.js";

/** Records per read-write transaction (import step 3). */
export const WRITE_CHUNK = 256;

export interface PlannedDatabase {
  d: number;
  schema: DbSchema;
  /** Store files in schema order. */
  stores: Uint8Array[];
}

export type Blobs = (sha256: string) => Blob;

// Every failure on this path is an import failure: a snapshot format error becomes IMP_RECORD_INVALID.
export const at = <T>(context: FrameErrorDetail, run: () => T) => atAny(context, run, "import");
export const within = <T>(context: FrameErrorDetail, run: () => Promise<T>) =>
  withinAny(context, run, "import");

export function buildValue(record: StoreRecord, blobs: Blobs, where: FrameErrorDetail): unknown {
  return at({ ...where, recordKey: record.key }, () => fromItem(record.value, blobs));
}

export function writeLocalStorage(env: FrameEnv, items: [string, string][]): void {
  for (const [key, value] of items) {
    try {
      env.localStorage.setItem(key, value);
    } catch (error) {
      if (isQuotaError(error)) {
        throw new FrameFailure("IMP_QUOTA_EXCEEDED", "localStorage is full");
      }
      throw error;
    }
  }
}

/** Opens the database at its recorded version; the upgrade must start from nothing (oldVersion 0). */
function createDatabase(env: FrameEnv, schema: DbSchema): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = env.indexedDB.open(schema.name, schema.version);
    let created = false;
    let existed = false;
    let refused: string | undefined;
    open.onupgradeneeded = (event) => {
      const db = open.result;
      if (event.oldVersion !== 0) {
        existed = true;
        open.transaction?.abort();
        return;
      }
      try {
        for (const store of schema.stores) {
          const objectStore = db.createObjectStore(store.name, {
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
          });
          for (const index of store.indexes) {
            objectStore.createIndex(index.name, index.keyPath, {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
          }
        }
        created = true;
      } catch (error) {
        // The reader refuses what IndexedDB refuses to create; this is defense in depth.
        refused = errorName(error) ?? "Error";
        open.transaction?.abort();
      }
    };
    const notEmpty = () =>
      new FrameFailure("IMP_TARGET_NOT_EMPTY", "the database already exists in the target");
    open.onsuccess = () => {
      if (created) {
        resolve(open.result);
      } else {
        open.result.close();
        reject(notEmpty());
      }
    };
    open.onerror = (event) => {
      event.preventDefault();
      if (refused !== undefined) {
        reject(
          new FrameFailure("IMP_RECORD_INVALID", "IndexedDB refused the recorded schema", {
            reason: refused,
          }),
        );
      } else if (existed || errorName(open.error) === "VersionError") {
        reject(notEmpty());
      } else if (isQuotaError(open.error)) {
        reject(new FrameFailure("IMP_QUOTA_EXCEEDED", "IndexedDB is full"));
      } else {
        reject(open.error);
      }
    };
  });
}

/** How a failed put is reported, by the DOMException name of its request error. */
function putFailure(
  name: string | undefined,
  record: StoreRecord,
  where: FrameErrorDetail,
): FrameFailure {
  const detail = {
    ...where,
    recordKey: record.key,
    ...(name === undefined ? {} : { reason: name }),
  };
  switch (name) {
    case "ConstraintError": // a unique index refuses the record
      return new FrameFailure("IMP_RECORD_INVALID", "IndexedDB refused a record", detail);
    case "QuotaExceededError":
      return new FrameFailure("IMP_QUOTA_EXCEEDED", "IndexedDB is full", detail);
    case "DataError": // the value yields no key at the key path
      return new FrameFailure(
        "IMP_KEY_MISMATCH",
        "the value yields no key at the key path",
        detail,
      );
    default:
      return new FrameFailure("INTERNAL", "a put failed", detail);
  }
}

/**
 * Puts one chunk in one transaction and checks each key IndexedDB stored against the recorded one. Any failed request
 * aborts the whole transaction (no request error is prevented) and fails the import with a named code; resolves with
 * the number of records stored, which is the chunk's length.
 */
async function putChunk(
  env: FrameEnv,
  db: IDBDatabase,
  store: StoreSchema,
  chunk: StoreRecord[],
  values: unknown[],
  where: FrameErrorDetail,
): Promise<number> {
  const tx = db.transaction(store.name, "readwrite");
  const objectStore = tx.objectStore(store.name);
  let mismatch: StoreRecord | undefined;
  let failed: { record: StoreRecord; name: string | undefined } | undefined;
  let stored = 0;
  for (const [i, record] of chunk.entries()) {
    let put: IDBRequest<IDBValidKey>;
    try {
      put =
        store.keyPath === null
          ? objectStore.put(values[i], record.key as IDBValidKey)
          : objectStore.put(values[i]);
    } catch (error) {
      tx.abort();
      throw putFailure(errorName(error), record, where);
    }
    put.onsuccess = () => {
      if (mismatch === undefined && env.indexedDB.cmp(put.result, record.key) !== 0) {
        mismatch = record;
        tx.abort();
      } else {
        stored += 1;
      }
    };
    put.onerror = () => {
      failed ??= { record, name: errorName(put.error) };
    };
  }
  try {
    await done(tx);
  } catch (error) {
    if (mismatch !== undefined) {
      throw new FrameFailure("IMP_KEY_MISMATCH", "the stored key differs from the recorded key", {
        ...where,
        recordKey: mismatch.key,
      });
    }
    if (failed !== undefined) {
      throw putFailure(failed.name, failed.record, where);
    }
    if (isQuotaError(error)) {
      throw new FrameFailure("IMP_QUOTA_EXCEEDED", "IndexedDB is full", where);
    }
    const reason = errorName(error);
    throw new FrameFailure("INTERNAL", "a write transaction aborted", {
      ...where,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  if (stored !== chunk.length) {
    throw new FrameFailure("INTERNAL", "a write transaction committed without every record", where);
  }
  return stored;
}

async function writeStore(
  env: FrameEnv,
  db: IDBDatabase,
  store: StoreSchema,
  bytes: Uint8Array,
  blobs: Blobs,
  where: FrameErrorDetail,
): Promise<number> {
  const records = decodeStoreRecords(bytes, new Map());
  let stored = 0;
  for (let i = 0; i < records.length; i += WRITE_CHUNK) {
    const chunk = records.slice(i, i + WRITE_CHUNK);
    const values = chunk.map((record) => buildValue(record, blobs, where));
    stored += await putChunk(env, db, store, chunk, values, where);
  }
  if (store.autoIncrement && store.keyGenerator !== null) {
    const current = generatorAfter(records.map((record) => record.key));
    await raiseKeyGenerator(db, store.name, store.keyGenerator, current);
  }
  return stored;
}

export async function writeDatabase(
  env: FrameEnv,
  k: number,
  planned: PlannedDatabase,
  blobs: Blobs,
): Promise<DatabaseSummary> {
  const { schema } = planned;
  const db = await createDatabase(env, schema);
  let records = 0;
  try {
    for (const [s, store] of schema.stores.entries()) {
      const where = { store: store.name, entry: storePath(k, planned.d, s) };
      records += await within(where, () =>
        writeStore(env, db, store, planned.stores[s] as Uint8Array, blobs, where),
      );
    }
  } finally {
    db.close();
  }
  // The records IndexedDB stored and acknowledged, not the schema's count.
  return { name: schema.name, version: schema.version, stores: schema.stores.length, records };
}
