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

/** The part of Electron's `app` used to find the default directories. */
export interface ElectronPaths {
  getPath(name: "userData" | "appData"): string;
}

/**
 * userData per flavor. Electron creates the userData directory as soon as `app.getPath("userData")` is read
 * (Verified 2026-10-28, a probe app on Electron 45.0.0), so the default is asked for only when it is used:
 * - test: `WG_USER_DATA` (an absolute path; e2e tests pass a fresh temporary directory), and the app refuses to
 *   start without it, so a test run never creates or touches a real profile;
 * - dev: `WG_USER_DATA` when set (for check runs), otherwise its own directory next to the production one
 *   (Assumed: keeps development runs out of real saves);
 * - prod: Electron's default; the variable is ignored.
 */
export function resolveUserData(
  flavor: Flavor,
  env: Readonly<Record<string, string | undefined>>,
  electron: ElectronPaths,
): string {
  const fromEnv = env.WG_USER_DATA;
  if (flavor === "test") {
    if (!fromEnv)
      throw new Error("The test build needs WG_USER_DATA (a temporary userData directory).");
    if (!isAbsolute(fromEnv)) throw new Error("WG_USER_DATA must be an absolute path.");
    return fromEnv;
  }
  if (flavor === "dev") {
    if (fromEnv && isAbsolute(fromEnv)) return fromEnv;
    return join(electron.getPath("appData"), "WGLauncher Dev");
  }
  return electron.getPath("userData");
}
