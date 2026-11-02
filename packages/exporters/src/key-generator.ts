// Key generators of `autoIncrement` stores (snapshot-format.md section 7.5, save-transfer.md section 4): the export
// probe and the import raise.
import { errorName, FrameFailure, isQuotaError } from "./errors.js";
import { done } from "./idb.js";

/** The largest current number a generator can have (snapshot-format.md section 7.2). */
const MAX_GENERATOR = 2 ** 53;

/** A value the store accepts as a placeholder: `null` without a key path, else an object holding `key` at the path. */
function placeholder(keyPath: string | string[] | null, key?: number): unknown {
  if (keyPath === null) {
    return null;
  }
  // An autoIncrement store has a string key path (IndexedDB refuses an array one); without `key` it is injected.
  const value: Record<string, unknown> = {};
  if (key !== undefined && typeof keyPath === "string") {
    const names = keyPath.split(".");
    let at = value;
    for (const name of names.slice(0, -1)) {
      const next: Record<string, unknown> = {};
      at[name] = next;
      at = next;
    }
    at[names.at(-1) as string] = key;
  }
  return value;
}

/**
 * The generator's current number, read by adding a placeholder in a read-write transaction that is then aborted, so
 * nothing is stored. Chromium reverts the generator on abort (open check 2; browser/key-generator.spec.ts). A
 * `ConstraintError` means the generator is exhausted.
 */
export function probeKeyGenerator(db: IDBDatabase, storeName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    let generated: unknown;
    const add = store.add(placeholder(store.keyPath));
    add.onsuccess = () => {
      generated = add.result;
      tx.abort(); // inside the success handler, before the transaction can commit
    };
    add.onerror = (event) => {
      event.preventDefault();
      tx.abort();
    };
    tx.oncomplete = () => reject(new FrameFailure("INTERNAL", "the key-generator probe committed"));
    tx.onabort = () => {
      if (typeof generated === "number" && Number.isInteger(generated) && generated >= 1) {
        resolve(generated);
      } else if (add.error?.name === "ConstraintError") {
        reject(new FrameFailure("EXP_KEY_GENERATOR_EXHAUSTED", "the key generator is exhausted"));
      } else {
        reject(add.error ?? new FrameFailure("INTERNAL", "the key-generator probe failed"));
      }
    };
  });
}

/** The generator's current number after explicit keys were put: the highest numeric key plus 1, at least 1. */
export function generatorAfter(keys: Iterable<unknown>): number {
  let current = 1;
  for (const key of keys) {
    if (typeof key === "number" && key >= current) {
      current = Math.min(Math.floor(key) + 1, MAX_GENERATOR + 1);
    }
  }
  return current;
}

/**
 * Raises the generator to `keyGenerator` when it is above `current`: a placeholder with the explicit key
 * `keyGenerator − 1` is put and deleted in one transaction. Explicit numeric keys move the generator up and deletes
 * never move it down (save-transfer.md section 4, import step 4).
 */
export async function raiseKeyGenerator(
  db: IDBDatabase,
  storeName: string,
  keyGenerator: number,
  current: number,
): Promise<void> {
  if (keyGenerator <= current) {
    return;
  }
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  const key = keyGenerator - 1;
  if (store.keyPath === null) {
    store.put(placeholder(null), key);
  } else {
    store.put(placeholder(store.keyPath, key));
  }
  store.delete(key);
  try {
    await done(tx);
  } catch (error) {
    if (isQuotaError(error)) {
      throw new FrameFailure("IMP_QUOTA_EXCEEDED", "IndexedDB is full");
    }
    const reason = errorName(error);
    throw new FrameFailure("INTERNAL", "raising the key generator failed", {
      ...(reason === undefined ? {} : { reason }),
    });
  }
}
