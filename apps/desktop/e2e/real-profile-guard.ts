// Guard for the e2e suite: a test run must never create or change the real userData directories of the app
// (`WGLauncher`, `WGLauncher Dev`). Electron/Chromium create or rewrite files in the default userData as soon as they
// start, so the guard compares a full content listing (relative names, sizes, modification times), not only the
// top-level names, and the harness runs it after a failed launch too. No Playwright import: unit-tested by Vitest.

import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Relative path to a short description: `dir`, `link`, or `file <size> <mtimeMs>`. `null` stands for a missing directory. */
export type DirSnapshot = ReadonlyMap<string, string>;

/**
 * Electron's default `appData` directory on this OS (where the real app keeps its userData), computed without
 * starting Electron.
 */
function defaultAppData(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32")
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/** The userData directories of the real app (prod) and of the dev flavor. Tests must never create or change them. */
export const REAL_PROFILE_DIRS: readonly string[] = ["WGLauncher", "WGLauncher Dev"].map((name) =>
  join(defaultAppData(), name),
);

/** Every entry below `dir` (recursively), or null if `dir` does not exist. */
export async function snapshotDir(dir: string): Promise<DirSnapshot | null> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const entries = new Map<string, string>();
  for (const name of names.sort()) {
    try {
      const info = await lstat(join(dir, name));
      entries.set(
        name,
        info.isSymbolicLink()
          ? "link"
          : info.isDirectory()
            ? "dir"
            : `file ${info.size} ${info.mtimeMs}`,
      );
    } catch (error) {
      // Gone between the listing and the stat: a running process is changing the directory.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.set(name, "vanished");
    }
  }
  return entries;
}

/** Human-readable differences between two snapshots of one directory; empty when they are identical. */
export function diffSnapshots(before: DirSnapshot | null, after: DirSnapshot | null): string[] {
  if (before === null && after === null) return [];
  if (before === null) return ["the directory did not exist and was created"];
  if (after === null) return ["the directory existed and is gone"];
  const differences: string[] = [];
  for (const [name, description] of after) {
    const old = before.get(name);
    if (old === undefined) differences.push(`added: ${name}`);
    else if (old !== description) differences.push(`changed: ${name} (${old} -> ${description})`);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) differences.push(`removed: ${name}`);
  }
  return differences;
}

/**
 * Records `dirs` now; `verify()` throws if any of them was created, removed or changed since (the message names the
 * directory by its last path segment and lists at most ten differences, never contents).
 */
export async function guardDirs(dirs: readonly string[]): Promise<{ verify(): Promise<void> }> {
  const before = await Promise.all(dirs.map(snapshotDir));
  return {
    async verify() {
      const problems: string[] = [];
      for (const [i, dir] of dirs.entries()) {
        const differences = diffSnapshots(before[i] ?? null, await snapshotDir(dir));
        if (differences.length > 0) {
          const shown = differences.slice(0, 10).join("; ");
          const more = differences.length > 10 ? ` (and ${differences.length - 10} more)` : "";
          problems.push(`${dir.split(/[\\/]/).pop()}: ${shown}${more}`);
        }
      }
      if (problems.length > 0) {
        throw new Error(`A test run touched the real profile directories: ${problems.join(" | ")}`);
      }
    },
  };
}

/** The guard for the real profile directories. */
export const guardRealProfiles = () => guardDirs(REAL_PROFILE_DIRS);
