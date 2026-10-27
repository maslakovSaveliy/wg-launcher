// The on-disk layout of userData (architecture.md section 3) and how userData is chosen per build flavor.

import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Flavor } from "./flavor.js";

export interface AppPaths {
  /** The SQLite library database (Task 6). */
  db: string;
  covers: string;
  /** Exports and imported files, immutable. */
  snapshots: string;
  /** Pre-import and pre-delete backups, never deleted automatically. */
  backups: string;
  /** `*.partial` files; emptied at start-up. */
  tmp: string;
  logs: string;
}

export function appPaths(userData: string): AppPaths {
  return {
    db: join(userData, "library.db"),
    covers: join(userData, "covers"),
    snapshots: join(userData, "snapshots"),
    backups: join(userData, "backups"),
    tmp: join(userData, "tmp"),
    logs: join(userData, "logs"),
  };
}

/** Creates the directories and empties `tmp/`, which only ever holds unfinished `.partial` files. */
export async function prepareAppPaths(paths: AppPaths): Promise<void> {
  await Promise.all(
    [paths.covers, paths.snapshots, paths.backups, paths.tmp, paths.logs].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  const leftovers = await readdir(paths.tmp);
  await Promise.all(
    leftovers.map((name) => rm(join(paths.tmp, name), { recursive: true, force: true })),
  );
}

/**
 * userData per flavor: the test flavor takes it from `WG_USER_DATA` (an absolute path; e2e tests always pass a
 * fresh temporary directory) and refuses to start without it, so a test run never touches a real profile; the dev
 * flavor uses its own directory next to the production one (Assumed: keeps development runs out of real saves);
 * prod uses Electron's default and ignores the variable.
 */
export function resolveUserData(
  flavor: Flavor,
  env: Readonly<Record<string, string | undefined>>,
  defaults: { userData: string; appData: string },
): string {
  if (flavor === "test") {
    const dir = env.WG_USER_DATA;
    if (!dir)
      throw new Error("The test build needs WG_USER_DATA (a temporary userData directory).");
    if (!isAbsolute(dir)) throw new Error("WG_USER_DATA must be an absolute path.");
    return dir;
  }
  if (flavor === "dev") return join(defaults.appData, "WGLauncher Dev");
  return defaults.userData;
}
