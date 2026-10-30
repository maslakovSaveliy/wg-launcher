// What a frame holds (save-transfer.md section 3 `FrameInventory`, section 4 export step 1 and import step 1). Reads
// counts, names and usage numbers only; never cookies, Cache Storage or credentials.
import type { FrameEnv } from "./env.js";
import { type FrameScope, type Selection, selectsDatabase, selectsKey } from "./scope.js";
import type { FrameInventory, NotExportedKind } from "./types.js";

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The localStorage keys of a selection, sorted. */
export function localStorageKeys(env: FrameEnv, selection: Selection): string[] {
  const keys: string[] = [];
  for (let i = 0; i < env.localStorage.length; i++) {
    const key = env.localStorage.key(i);
    if (key !== null && selectsKey(selection, key)) {
      keys.push(key);
    }
  }
  return keys.sort(byCodeUnits);
}

/** The databases of a selection as `indexedDB.databases()` lists them, sorted by name in code-unit order. */
export async function listDatabases(
  env: FrameEnv,
  selection: Selection,
): Promise<{ name: string; version: number }[]> {
  const listed = await env.indexedDB.databases();
  return listed
    .flatMap((info) =>
      typeof info.name === "string" && selectsDatabase(selection, info.name)
        ? [{ name: info.name, version: info.version ?? 0 }]
        : [],
    )
    .sort((a, b) => byCodeUnits(a.name, b.name));
}

async function usageDetails(env: FrameEnv): Promise<Record<string, number> | null> {
  if (env.storage === undefined) {
    return null;
  }
  // `usageDetails` is a Chromium extension of StorageEstimate.
  const estimate = (await env.storage.estimate()) as StorageEstimate & { usageDetails?: unknown };
  const details = estimate.usageDetails;
  if (typeof details !== "object" || details === null) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => typeof value === "number" && value >= 0),
  ) as Record<string, number>;
}

export async function readInventory(env: FrameEnv): Promise<FrameInventory> {
  return {
    localStorageItems: env.localStorage.length,
    databases: await listDatabases(env, "all"),
    usageDetails: await usageDetails(env),
  };
}

const NOT_EXPORTED: [string, NotExportedKind][] = [
  ["fileSystem", "fileSystem"],
  ["caches", "cacheStorage"],
  ["serviceWorkerRegistrations", "serviceWorkers"],
];

/** Storage kinds with data that the generic exporter does not export (save-transfer.md section 4, step 5). */
export async function notExported(env: FrameEnv): Promise<NotExportedKind[]> {
  const details = await usageDetails(env);
  return NOT_EXPORTED.filter(([usage]) => (details?.[usage] ?? 0) > 0).map(([, kind]) => kind);
}

/** True when no selected localStorage key and no selected database exists (import step 1). */
export async function isEmpty(env: FrameEnv, scope: FrameScope): Promise<boolean> {
  return (
    localStorageKeys(env, scope.localStorage).length === 0 &&
    (await listDatabases(env, scope.indexedDB)).length === 0
  );
}
