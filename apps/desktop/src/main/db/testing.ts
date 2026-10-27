// Helpers for the database tests only (never imported by product code): a temporary directory per test, a fake
// clock, and databases that are closed before their directory is removed (Windows cannot delete an open file).
// Nothing touches a real profile and every timestamp is deterministic.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { type Db, type OpenOptions, openDatabase, type WritableDb } from "./database.js";

const dirs: string[] = [];
const handles: Array<{ raw: DatabaseSync }> = [];

/** A fresh temporary directory, removed after the current test (after the databases opened below are closed). */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wg-db-"));
  dirs.push(dir);
  return dir;
}

/** Closes `db` after the current test, before the directories are removed. Returns it. */
export function closeAfterTest<T extends { raw: DatabaseSync }>(db: T): T {
  handles.push(db);
  return db;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    if (handle.raw.isOpen) handle.raw.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A clock that starts at `start` and moves only when told to. */
export function fakeClock(start = 1_800_000_000_000): {
  now: () => number;
  advance(ms: number): void;
} {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

/** The options of `openDatabase` for a database in `dir`: backups in `dir/backups`, partial files in `dir/tmp`. */
export function dbOptions(dir: string, clock: { now: () => number } = fakeClock()): OpenOptions {
  return { now: clock.now, backupDir: join(dir, "backups"), tmpDir: join(dir, "tmp") };
}

/** `openDatabase`, closed after the test. */
export function openDb(path: string, options: OpenOptions): Db {
  return closeAfterTest(openDatabase(path, options));
}

/** A writable database `dir/library.db`, closed after the test. */
export function openTestDb(dir: string, clock: { now: () => number } = fakeClock()): WritableDb {
  const db = openDb(join(dir, "library.db"), dbOptions(dir, clock));
  if (db.readOnly) throw new Error(db.reason);
  return db;
}
