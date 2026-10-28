// `wipe-selected` (save-transfer.md section 6, R5): for a selective (adapter) restore, removes only the selected
// localStorage keys and databases. A full restore wipes with CDP `Storage.clearDataForStorageKey` instead.
import { FrameFailure } from "./errors.js";
import { listDatabases, localStorageKeys } from "./inventory.js";
import type { FrameScope } from "./scope.js";
import type { FrameEnv, WipeSummary } from "./types.js";

export async function wipeSelected(env: FrameEnv, scope: FrameScope): Promise<WipeSummary> {
  const keys = localStorageKeys(env, scope.localStorage);
  for (const key of keys) {
    env.localStorage.removeItem(key);
  }
  const databases = (await listDatabases(env, scope.indexedDB)).map((d) => d.name);
  for (const name of databases) {
    await deleteDatabase(env, name);
  }
  return { localStorageItems: keys.length, databases };
}

/**
 * Deletes one database. Another open connection that does not close on `versionchange` blocks the delete: that is
 * `IMP_WIPE_FAILED`, never a wait without end. The request stays queued in IndexedDB and completes when that
 * connection closes, so the caller treats the failure as fatal for the job (QW-2 keeps the partition exclusive).
 */
function deleteDatabase(env: FrameEnv, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deleting = env.indexedDB.deleteDatabase(name);
    deleting.onsuccess = () => resolve();
    deleting.onblocked = () =>
      reject(
        new FrameFailure("IMP_WIPE_FAILED", "another connection blocks the delete", {
          database: name,
        }),
      );
    deleting.onerror = () =>
      reject(new FrameFailure("IMP_WIPE_FAILED", "the delete failed", { database: name }));
  });
}
