// Promise wrappers over IndexedDB requests and transactions.
import { FrameFailure } from "./errors.js";

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolves when the transaction commits; rejects with its error when it aborts. */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new FrameFailure("INTERNAL", "transaction aborted"));
    tx.onerror = (event) => event.preventDefault(); // the abort that follows reports it once
  });
}

/**
 * Opens an existing database without a version. An `upgradeneeded` means it no longer exists: the upgrade is aborted,
 * so nothing is created, and the result is `null` (save-transfer.md section 4, step 2).
 */
export function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name);
    let vanished = false;
    open.onupgradeneeded = () => {
      vanished = true;
      open.transaction?.abort();
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = (event) => {
      if (vanished) {
        event.preventDefault();
        resolve(null);
      } else {
        reject(open.error);
      }
    };
  });
}

/** The key path as a plain value: `null`, a string or an array of strings. */
export function keyPathOf(path: string | string[] | null): string | string[] | null {
  return path === null || typeof path === "string" ? path : Array.from(path);
}
