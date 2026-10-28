// The generic exporter, import side (save-transfer.md section 4, import steps 1 to 4). Every entry is decoded and every
// value built once before the first write, so a record this engine cannot rebuild (Ruling R7) fails the import with
// nothing written. Then localStorage, then each database in bounded put transactions, then the key generators.
import {
  type DbSchema,
  decodeLocalStorage,
  decodeSchema,
  decodeStoreRecords,
  fromItem,
  type StoreRecord,
  type StoreSchema,
} from "@wg-launcher/snapshot";
import { at, errorName, FrameFailure, isQuotaError, within } from "./errors.js";
import { done } from "./idb.js";
import { isEmpty } from "./inventory.js";
import { generatorAfter, raiseKeyGenerator } from "./key-generator.js";
import { blobPath, localStoragePath, parseFramePath, schemaPath, storePath } from "./paths.js";
import { selectsDatabase, selectsKey } from "./scope.js";
import type {
  DatabaseSummary,
  EntrySource,
  FrameEnv,
  FrameErrorDetail,
  FrameImportPlan,
  FrameSummary,
} from "./types.js";

/** Records per read-write transaction (import step 3). */
export const WRITE_CHUNK = 256;

interface DatabaseFiles {
  schema?: Uint8Array;
  stores: Map<number, Uint8Array>;
}

interface Received {
  blobs: Map<string, Uint8Array>;
  localStorage: Uint8Array | null;
  databases: Map<number, DatabaseFiles>;
}

interface PlannedDatabase {
  d: number;
  schema: DbSchema;
  /** Store files in schema order. */
  stores: Uint8Array[];
}

type Blobs = (sha256: string) => Blob;

function invalid(message: string, detail: FrameErrorDetail = {}): never {
  throw new FrameFailure("IMP_RECORD_INVALID", message, detail);
}

async function receive(source: EntrySource, k: number): Promise<Received> {
  const received: Received = { blobs: new Map(), localStorage: null, databases: new Map() };
  for await (const { path, bytes } of source) {
    const kind = parseFramePath(path, k) ?? invalid("not an entry of this frame", { entry: path });
    let twice: boolean;
    if (kind.kind === "blob") {
      twice = received.blobs.has(kind.sha256);
      received.blobs.set(kind.sha256, bytes);
    } else if (kind.kind === "localStorage") {
      twice = received.localStorage !== null;
      received.localStorage = bytes;
    } else {
      const files: DatabaseFiles = received.databases.get(kind.db) ?? { stores: new Map() };
      received.databases.set(kind.db, files);
      twice = kind.kind === "schema" ? files.schema !== undefined : files.stores.has(kind.store);
      if (kind.kind === "schema") {
        files.schema = bytes;
      } else {
        files.stores.set(kind.store, bytes);
      }
    }
    if (twice) {
      invalid("the same entry twice", { entry: path });
    }
  }
  return received;
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** Blob bytes by hash, each checked against its name (defense in depth: the worker checked every entry hash). */
async function blobSource(env: FrameEnv, received: Map<string, Uint8Array>): Promise<Blobs> {
  const blobs = new Map<string, Blob>();
  for (const [sha256, bytes] of received) {
    const data = bytes as Uint8Array<ArrayBuffer>;
    if (hex(await env.crypto.subtle.digest("SHA-256", data)) !== sha256) {
      invalid("blob bytes do not match their name", { entry: blobPath(sha256) });
    }
    blobs.set(sha256, new Blob([data]));
  }
  return (sha256) => blobs.get(sha256) ?? invalid("a referenced blob is missing");
}

function buildValue(record: StoreRecord, blobs: Blobs, where: FrameErrorDetail): unknown {
  return at({ ...where, recordKey: record.key }, () => fromItem(record.value, blobs));
}

/** Checks the structure and the selection, decodes every file and builds every value once; writes nothing. */
function check(received: Received, plan: FrameImportPlan, blobs: Blobs) {
  const k = plan.keyIndex;
  const lsEntry = { entry: localStoragePath(k) };
  const items =
    received.localStorage === null
      ? []
      : at(lsEntry, () => decodeLocalStorage(received.localStorage as Uint8Array));
  if (items.some(([key]) => !selectsKey(plan.scope.localStorage, key))) {
    invalid("a localStorage key outside the selection", lsEntry);
  }
  const databases: PlannedDatabase[] = [];
  const numbers = [...received.databases.keys()].sort((a, b) => a - b);
  for (const [i, d] of numbers.entries()) {
    const files = received.databases.get(d) as DatabaseFiles;
    const entry = schemaPath(k, d);
    if (d !== i || files.schema === undefined) {
      invalid("databases are not numbered 0 to n - 1 with a schema each", { entry });
    }
    const schema = at({ entry }, () => decodeSchema(files.schema as Uint8Array));
    const where = { database: schema.name, entry };
    const previous = databases.at(-1)?.schema.name;
    if (previous !== undefined && !(previous < schema.name)) {
      invalid("database names are not strictly ascending", where);
    }
    if (!selectsDatabase(plan.scope.indexedDB, schema.name)) {
      invalid("a database outside the selection", where);
    }
    if ([...files.stores.keys()].some((s) => s >= schema.stores.length)) {
      invalid("a store file without a store in the schema", where);
    }
    const stores = schema.stores.map((store, s) => {
      const storeWhere = { database: schema.name, store: store.name, entry: storePath(k, d, s) };
      const bytes = files.stores.get(s) ?? invalid("a store file is missing", storeWhere);
      const records = at(storeWhere, () => decodeStoreRecords(bytes, new Map()));
      if (records.length !== store.records) {
        invalid("the record count differs from the schema", storeWhere);
      }
      for (const record of records) {
        buildValue(record, blobs, storeWhere);
      }
      return bytes;
    });
    databases.push({ d, schema, stores });
  }
  return { items, databases };
}

function writeLocalStorage(env: FrameEnv, items: [string, string][]): void {
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
    open.onupgradeneeded = (event) => {
      const db = open.result;
      if (event.oldVersion !== 0) {
        existed = true;
        open.transaction?.abort();
        return;
      }
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
      if (existed || errorName(open.error) === "VersionError") {
        reject(notEmpty());
      } else if (isQuotaError(open.error)) {
        reject(new FrameFailure("IMP_QUOTA_EXCEEDED", "IndexedDB is full"));
      } else {
        reject(open.error);
      }
    };
  });
}

/** Puts one chunk in one transaction and checks each key IndexedDB stored against the recorded one. */
async function putChunk(
  env: FrameEnv,
  db: IDBDatabase,
  store: StoreSchema,
  chunk: StoreRecord[],
  values: unknown[],
  where: FrameErrorDetail,
): Promise<void> {
  const tx = db.transaction(store.name, "readwrite");
  const objectStore = tx.objectStore(store.name);
  let mismatch: StoreRecord | undefined;
  const mismatchError = (record: StoreRecord) =>
    new FrameFailure("IMP_KEY_MISMATCH", "the stored key differs from the recorded key", {
      ...where,
      recordKey: record.key,
    });
  for (const [i, record] of chunk.entries()) {
    let put: IDBRequest<IDBValidKey>;
    try {
      put =
        store.keyPath === null
          ? objectStore.put(values[i], record.key as IDBValidKey)
          : objectStore.put(values[i]);
    } catch (error) {
      tx.abort();
      // DataError: the value yields no key at the key path.
      throw errorName(error) === "DataError" ? mismatchError(record) : error;
    }
    put.onsuccess = () => {
      if (mismatch === undefined && env.indexedDB.cmp(put.result, record.key) !== 0) {
        mismatch = record;
        tx.abort();
      }
    };
  }
  try {
    await done(tx);
  } catch (error) {
    if (mismatch !== undefined) {
      throw mismatchError(mismatch);
    }
    if (isQuotaError(error)) {
      throw new FrameFailure("IMP_QUOTA_EXCEEDED", "IndexedDB is full", where);
    }
    throw error;
  }
}

async function writeStore(
  env: FrameEnv,
  db: IDBDatabase,
  store: StoreSchema,
  bytes: Uint8Array,
  blobs: Blobs,
  where: FrameErrorDetail,
): Promise<void> {
  const records = decodeStoreRecords(bytes, new Map());
  for (let i = 0; i < records.length; i += WRITE_CHUNK) {
    const chunk = records.slice(i, i + WRITE_CHUNK);
    const values = chunk.map((record) => buildValue(record, blobs, where));
    await putChunk(env, db, store, chunk, values, where);
  }
  if (store.autoIncrement && store.keyGenerator !== null) {
    const current = generatorAfter(records.map((record) => record.key));
    await raiseKeyGenerator(db, store.name, store.keyGenerator, current);
  }
}

async function writeDatabase(
  env: FrameEnv,
  k: number,
  planned: PlannedDatabase,
  blobs: Blobs,
): Promise<DatabaseSummary> {
  const { schema } = planned;
  const db = await createDatabase(env, schema);
  try {
    for (const [s, store] of schema.stores.entries()) {
      const where = { store: store.name, entry: storePath(k, planned.d, s) };
      await within(where, () =>
        writeStore(env, db, store, planned.stores[s] as Uint8Array, blobs, where),
      );
    }
  } finally {
    db.close();
  }
  return {
    name: schema.name,
    version: schema.version,
    stores: schema.stores.length,
    records: schema.stores.reduce((n, store) => n + store.records, 0),
  };
}

export async function importFrame(
  env: FrameEnv,
  source: EntrySource,
  plan: FrameImportPlan,
): Promise<FrameSummary> {
  return within({ storageKey: plan.storageKey }, async () => {
    if (!(await isEmpty(env, plan.scope))) {
      throw new FrameFailure("IMP_TARGET_NOT_EMPTY", "the target frame already holds data");
    }
    const received = await receive(source, plan.keyIndex);
    const blobs = await blobSource(env, received.blobs);
    const { items, databases } = check(received, plan, blobs);
    writeLocalStorage(env, items);
    const summaries: DatabaseSummary[] = [];
    for (const planned of databases) {
      summaries.push(
        await within({ database: planned.schema.name }, () =>
          writeDatabase(env, plan.keyIndex, planned, blobs),
        ),
      );
    }
    return {
      localStorageItems: items.length,
      databases: summaries,
      blobs: received.blobs.size,
      notExported: [],
    };
  });
}
