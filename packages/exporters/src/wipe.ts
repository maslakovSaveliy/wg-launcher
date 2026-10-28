// `wipe-selected` (save-transfer.md section 6, R5): for a selective (adapter) restore, removes only the selected
// localStorage keys and databases. A full restore wipes with CDP `Storage.clearDataForStorageKey` instead.
import { request } from "./idb.js";
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
    await request(env.indexedDB.deleteDatabase(name));
  }
  return { localStorageItems: keys.length, databases };
}
