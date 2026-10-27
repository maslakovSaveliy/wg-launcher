// Numbered, append-only schema migrations (architecture.md section 7).
//
// The SQL lives in `migrations/NNN-name.sql` and is imported as a string with Vite's `?raw` suffix: electron-vite
// inlines it into the main bundle at build time and Vitest resolves it the same way, so there is no run-time file
// lookup that could break inside a packaged app. (Assumed: chosen over TypeScript string constants to keep the SQL
// in real `.sql` files; the main build is checked in the e2e run.) Add a migration by adding a file and a line to
// `MIGRATIONS`; never edit one that has shipped.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import initial from "./migrations/001-initial.sql?raw";

export interface Migration {
  /** The `PRAGMA user_version` the database has after this migration. Consecutive from 1. */
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "initial", sql: initial }];

/** The schema version this build of the app knows. */
export const LATEST_VERSION = MIGRATIONS.length;

export function readUserVersion(raw: DatabaseSync): number {
  return (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Applies every migration newer than the database's `user_version`, each in one transaction that also sets
 * `user_version`, so a failure rolls both back. `beforeMigrating(fromVersion)` runs once, before the first pending
 * migration, and only for a database that already holds a schema (`fromVersion >= 1`); if it throws nothing is
 * migrated.
 */
export function migrate(
  raw: DatabaseSync,
  migrations: readonly Migration[],
  beforeMigrating: (fromVersion: number) => void,
): void {
  migrations.forEach((migration, i) => {
    if (migration.version !== i + 1) {
      throw new Error(
        `Migrations must be numbered 1, 2, 3 ... without gaps: found ${migration.version} at position ${i + 1}.`,
      );
    }
  });
  const current = readUserVersion(raw);
  const pending = migrations.filter((migration) => migration.version > current);
  if (pending.length === 0) return;
  if (current >= 1) beforeMigrating(current);

  for (const migration of pending) {
    try {
      raw.exec("BEGIN IMMEDIATE");
      raw.exec(migration.sql);
      // `migration.version` is one of our own integers; PRAGMA takes no bound parameter.
      raw.exec(`PRAGMA user_version = ${migration.version}`);
      raw.exec("COMMIT");
    } catch (error) {
      // SQLite rolls some errors back by itself, so only roll back a transaction that is still open.
      if (raw.isTransaction) raw.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

/** `20261028T034126123Z` from Unix milliseconds. */
function compactUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, "");
}

/**
 * Copies the database to `<dir>/library-v<version>-<time>.db` (architecture.md section 3) with `VACUUM INTO`.
 * That statement writes a complete, consistent copy of what the connection sees, WAL content included, so no
 * checkpoint or file-level copy of a live database is needed. The copy is written under a `.partial` name, flushed,
 * then renamed, and an existing backup is never overwritten (a numeric suffix is added instead). Returns the path.
 */
export function backupDatabase(
  raw: DatabaseSync,
  dir: string,
  version: number,
  now: () => number,
): string {
  mkdirSync(dir, { recursive: true });
  const stem = `library-v${version}-${compactUtc(now())}`;
  let target = join(dir, `${stem}.db`);
  for (let n = 1; existsSync(target); n += 1) target = join(dir, `${stem}-${n}.db`);
  const partial = `${target}.partial`;
  // VACUUM INTO refuses an existing file; a `.partial` can only be a leftover of a crash during an earlier backup.
  rmSync(partial, { force: true });
  raw.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
  const fd = openSync(partial, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, target);
  return target;
}
