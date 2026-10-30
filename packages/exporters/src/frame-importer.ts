// The generic exporter, import side (save-transfer.md section 4, import steps 1 to 4). Every entry is decoded and every
// value built once before the first write, so a record this engine cannot rebuild (a RegExp that does not compile) fails the import with
// nothing written. Then the write pass of import-write.ts: localStorage, then each database in bounded put
// transactions, then the key generators.

import {
  type BlobRefs,
  decodeLocalStorage,
  decodeSchema,
  decodeStoreRecords,
} from "@wg-launcher/snapshot";
import type { FrameEnv } from "./env.js";
import { FrameFailure } from "./errors.js";
import {
  at,
  type Blobs,
  buildValue,
  type PlannedDatabase,
  within,
  writeDatabase,
  writeLocalStorage,
} from "./import-write.js";
import { isEmpty } from "./inventory.js";
import { blobPath, localStoragePath, parseFramePath, schemaPath, storePath } from "./paths.js";
import { selectsDatabase, selectsKey } from "./scope.js";
import type {
  DatabaseSummary,
  EntrySource,
  FrameErrorDetail,
  FrameImportPlan,
  FrameSummary,
} from "./types.js";

interface DatabaseFiles {
  schema?: Uint8Array;
  stores: Map<number, Uint8Array>;
}

interface Received {
  blobs: Map<string, Uint8Array>;
  localStorage: Uint8Array | null;
  databases: Map<number, DatabaseFiles>;
}

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

/** Lets queued work run (the frame's heartbeat) between two long synchronous decodes. */
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Checks the structure and the selection, decodes every file and builds every value once; writes nothing. It yields
 * a turn after each store file, so the frame keeps sending its heartbeat while it decodes.
 */
async function check(received: Received, plan: FrameImportPlan, blobs: Blobs) {
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
  const refs: BlobRefs = new Map();
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
    const stores: Uint8Array[] = [];
    for (const [s, store] of schema.stores.entries()) {
      const storeWhere = { database: schema.name, store: store.name, entry: storePath(k, d, s) };
      const bytes = files.stores.get(s) ?? invalid("a store file is missing", storeWhere);
      const records = at(storeWhere, () => decodeStoreRecords(bytes, refs));
      if (records.length !== store.records) {
        invalid("the record count differs from the schema", storeWhere);
      }
      for (const record of records) {
        buildValue(record, blobs, storeWhere);
      }
      stores.push(bytes);
      await nextTurn();
    }
    databases.push({ d, schema, stores });
  }
  // Every blob entry must be referenced (snapshot-format.md section 7.4).
  for (const sha256 of received.blobs.keys()) {
    if (!refs.has(sha256)) {
      invalid("a blob entry that no record references", { entry: blobPath(sha256) });
    }
  }
  return { items, databases };
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
    const { items, databases } = await check(received, plan, blobs);
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
