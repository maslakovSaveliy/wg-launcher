// The library database (architecture.md section 7): `node:sqlite` in the main process, the only writer.
// `openDatabase` is synchronous, like the API underneath; keep every statement small and indexed (section 13).

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  backupDatabase,
  LATEST_VERSION,
  MIGRATIONS,
  type Migration,
  migrate,
  readUserVersion,
} from "./migrate.js";
import { createDeviceRepo } from "./repos/device.js";

/** A database at the schema version this app knows, open for reading and writing. */
export interface WritableDb {
  readonly readOnly: false;
  readonly raw: DatabaseSync;
  /** Unix milliseconds; injected so tests are deterministic. Repositories never read the system clock. */
  readonly now: () => number;
  /**
   * Runs `fn` in one `BEGIN IMMEDIATE` transaction: commits when it returns, rolls back when it throws. Called
   * inside another transaction it joins that one.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * A database written by a newer app (`user_version` above what this build migrates to). It is opened read-only
 * and nothing in the app writes to it; the caller shows `reason` instead of the library.
 */
export interface ReadOnlyDb {
  readonly readOnly: true;
  readonly reason: string;
  readonly userVersion: number;
  readonly raw: DatabaseSync;
  close(): void;
}

export type Db = WritableDb | ReadOnlyDb;

export interface OpenOptions {
  now: () => number;
  /** Where the copy made before a migration goes: `<userData>/backups`. */
  backupDir: string;
  /** Where that copy is written first, as a `.partial` file: `<userData>/tmp` (emptied at start-up). */
  tmpDir: string;
  /** For tests; defaults to the migrations of this build. */
  migrations?: readonly Migration[];
}

/**
 * Opens (and creates) the database at `path`, sets the per-connection pragmas, migrates to the newest schema and
 * makes sure the one `device` row exists.
 *
 * - A file whose `user_version` is newer than the migrations is opened with `readOnly: true` and returned as a
 *   `ReadOnlyDb`. It is first opened read-only, so nothing is written to it even to learn its version.
 * - Before migrating a database that already has a schema, a copy goes to `backups/library-v<n>-<time>.db`.
 * - A failing migration is rolled back whole, the connection is closed and the error is thrown.
 */
export function openDatabase(path: string, options: OpenOptions): Db {
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = migrations.length === 0 ? 0 : (migrations[migrations.length - 1]?.version ?? 0);

  if (existsSync(path)) {
    const probe = new DatabaseSync(path, { readOnly: true });
    let version: number;
    try {
      version = readUserVersion(probe);
    } catch (error) {
      probe.close();
      throw error;
    }
    if (version > latest) {
      return {
        readOnly: true,
        reason: `The library database is at schema version ${version}, newer than version ${latest} that this app knows. It was written by a newer WGLauncher and is opened read-only; nothing was changed.`,
        userVersion: version,
        raw: probe,
        close: () => probe.close(),
      };
    }
    probe.close();
  }

  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    const mode = (raw.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string })
      .journal_mode;
    if (mode.toLowerCase() !== "wal")
      throw new Error(`Cannot enable WAL (journal mode is ${mode}).`);
    raw.exec("PRAGMA synchronous = FULL");
    migrate(raw, migrations, (fromVersion) =>
      backupDatabase(raw, options, fromVersion, options.now),
    );
  } catch (error) {
    raw.close();
    throw error;
  }

  const db: WritableDb = {
    readOnly: false,
    raw,
    now: options.now,
    transaction<T>(fn: () => T): T {
      if (raw.isTransaction) return fn();
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        if (raw.isTransaction) raw.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => raw.close(),
  };
  try {
    createDeviceRepo(db).ensure();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export { LATEST_VERSION };
