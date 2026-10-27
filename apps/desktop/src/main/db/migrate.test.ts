import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backupDatabase, MIGRATIONS, type Migration } from "./migrate.js";
import { dbOptions, fakeClock, openDb, tempDir } from "./testing.js";

const ARCHITECTURE = join(import.meta.dirname, "../../../../../docs/specs/architecture.md");

/** Statements only: comments and whitespace do not count. */
function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ?([(),;]) ?/g, "$1")
    .trim();
}

function names(raw: DatabaseSync, type: "table" | "index"): string[] {
  return (
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(type) as Array<{ name: string }>
  ).map((row) => row.name);
}

function userVersion(raw: DatabaseSync): number {
  return (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("migrations", () => {
  it("a fresh database is migrated to version 1 with exactly the tables and indexes of architecture.md section 7", () => {
    const dir = tempDir();
    const db = openDb(join(dir, "library.db"), dbOptions(dir, fakeClock()));
    if (db.readOnly) throw new Error(db.reason);
    expect(userVersion(db.raw)).toBe(1);
    expect(names(db.raw, "table")).toEqual([
      "device",
      "games",
      "orphans",
      "play_sessions",
      "restore_journal",
      "settings",
      "snapshots",
      "storage_checks",
      "storage_targets",
      "window_state",
    ]);
    expect(names(db.raw, "index")).toEqual(["play_sessions_by_game", "snapshots_by_game"]);
    // A fresh database has nothing to back up.
    expect(existsSync(join(dir, "backups"))).toBe(false);
    expect(existsSync(join(dir, "tmp"))).toBe(false);
    db.close();
  });

  it("001-initial.sql is the SQL block of architecture.md section 7 (comments and spacing aside)", () => {
    const spec = readFileSync(ARCHITECTURE, "utf8");
    const section = spec.slice(spec.indexOf("## 7. SQLite schema v1"), spec.indexOf("## 8."));
    const block = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
    expect(block).toBeDefined();
    expect(normalizeSql(MIGRATIONS[0]?.sql ?? "")).toBe(normalizeSql(block ?? ""));
  });

  it("migrations are numbered 1, 2, 3 ... without gaps", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it("a failing migration leaves user_version, the old tables and the data alone, and the pre-migration copy exists", () => {
    const dir = tempDir();
    const path = join(dir, "library.db");
    const backupDir = join(dir, "backups");
    const clock = fakeClock();

    const first = openDb(path, dbOptions(dir, clock));
    if (first.readOnly) throw new Error(first.reason);
    first.raw.exec("INSERT INTO settings (key, value) VALUES ('k', '1')");
    first.close();

    const broken: Migration[] = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: "broken",
        sql: "CREATE TABLE half_done (a INTEGER); INSERT INTO no_such_table VALUES (1);",
      },
    ];
    expect(() => openDb(path, { ...dbOptions(dir, clock), migrations: broken })).toThrow(
      /migration 2.*broken/i,
    );

    // Nothing of the failed migration is left, and the version is the old one.
    const check = new DatabaseSync(path);
    expect(userVersion(check)).toBe(1);
    expect(names(check, "table")).not.toContain("half_done");
    expect(check.prepare("SELECT value FROM settings WHERE key = 'k'").get()).toMatchObject({
      value: "1",
    });
    check.close();

    // The copy made before the attempt is a complete, readable database of the old version.
    const copies = readdirSync(backupDir);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^library-v1-\d{8}T\d{9}Z\.db$/);
    const copy = new DatabaseSync(join(backupDir, copies[0] ?? ""), { readOnly: true });
    expect(userVersion(copy)).toBe(1);
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'k'").get()).toMatchObject({
      value: "1",
    });
    copy.close();
  });

  it("a failing first migration leaves a fresh database at version 0 with no tables", () => {
    const dir = tempDir();
    const path = join(dir, "library.db");
    const broken: Migration[] = [
      { version: 1, name: "broken", sql: "CREATE TABLE half_done (a INTEGER); SELECT nope FROM;" },
    ];
    expect(() => openDb(path, { ...dbOptions(dir, fakeClock()), migrations: broken })).toThrow(
      /migration 1/i,
    );
    const check = new DatabaseSync(path);
    expect(userVersion(check)).toBe(0);
    expect(names(check, "table")).toEqual([]);
    check.close();
  });

  it("a successful migration of an existing database is backed up first and applied", () => {
    const dir = tempDir();
    const path = join(dir, "library.db");
    const backupDir = join(dir, "backups");
    const clock = fakeClock();
    const first = openDb(path, dbOptions(dir, clock));
    first.close();

    const next: Migration[] = [
      ...MIGRATIONS,
      { version: 2, name: "add-note", sql: "ALTER TABLE orphans ADD COLUMN note TEXT;" },
    ];
    const db = openDb(path, { ...dbOptions(dir, clock), migrations: next });
    if (db.readOnly) throw new Error(db.reason);
    expect(userVersion(db.raw)).toBe(2);
    db.close();
    const [copy] = readdirSync(backupDir);
    expect(copy).toMatch(/^library-v1-/);
    // The copy is still version 1: the migration did not touch it.
    const old = new DatabaseSync(join(backupDir, copy ?? ""), { readOnly: true });
    expect(userVersion(old)).toBe(1);
    old.close();
  });

  it("two backups in the same millisecond never overwrite each other", () => {
    const dir = tempDir();
    const path = join(dir, "library.db");
    const backupDir = join(dir, "backups");
    const clock = fakeClock();
    openDb(path, dbOptions(dir, clock)).close();
    let migrations: Migration[] = [...MIGRATIONS];
    for (const version of [2, 3]) {
      migrations = [
        ...migrations,
        { version, name: `m${version}`, sql: `CREATE TABLE t${version} (a);` },
      ];
      openDb(path, { ...dbOptions(dir, clock), migrations }).close();
    }
    expect(readdirSync(backupDir)).toHaveLength(2);
  });

  it("an up-to-date database is not backed up or touched when opened again", () => {
    const dir = tempDir();
    const path = join(dir, "library.db");
    const backupDir = join(dir, "backups");
    openDb(path, dbOptions(dir, fakeClock())).close();
    openDb(path, dbOptions(dir, fakeClock())).close();
    expect(existsSync(backupDir)).toBe(false);
  });

  it("a database newer than the app opens read-only, reports why, and is not changed", () => {
    const dir = tempDir();
    const path = join(dir, "library.db");
    const backupDir = join(dir, "backups");
    const newer = new DatabaseSync(path);
    newer.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE future (a INTEGER); PRAGMA user_version = 99;",
    );
    newer.close();
    const before = sha256(path);

    const db = openDb(path, dbOptions(dir, fakeClock()));
    expect(db.readOnly).toBe(true);
    if (!db.readOnly) throw new Error("expected read-only");
    expect(db.reason).toMatch(/version 99.*newer.*version 1/i);
    expect(db.userVersion).toBe(99);
    // A write through the read-only handle is refused by SQLite itself.
    expect(() => db.raw.exec("INSERT INTO future VALUES (1)")).toThrow(/readonly/i);
    db.close();

    expect(sha256(path)).toBe(before);
    expect(existsSync(backupDir)).toBe(false);
  });

  describe("the backup copy", () => {
    function setUpBackup() {
      const dir = tempDir();
      const raw = new DatabaseSync(join(dir, "source.db"));
      raw.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1); PRAGMA user_version = 1");
      return { dir, raw, backupDir: join(dir, "backups"), tmpDir: join(dir, "tmp") };
    }

    it("is written under a .partial name in tmp/ and renamed into backups/", () => {
      const { raw, backupDir, tmpDir } = setUpBackup();
      const statements: string[] = [];
      const spy = {
        exec(sql: string) {
          statements.push(sql);
          raw.exec(sql);
        },
      } as DatabaseSync;

      const target = backupDatabase(spy, { backupDir, tmpDir }, 1, fakeClock().now);

      const vacuum = statements.find((sql) => sql.startsWith("VACUUM INTO"));
      expect(vacuum).toContain(tmpDir);
      expect(vacuum).toMatch(/\.partial'$/);
      expect(readdirSync(backupDir)).toEqual([target.split(/[\\/]/).pop()]);
      expect(readdirSync(tmpDir)).toEqual([]);
      raw.close();
    });

    // chmod does not stop a Windows process from renaming into a directory, so this case is for POSIX.
    it.skipIf(process.platform === "win32")(
      "leaves no .partial file in backups/ or tmp/ when it fails",
      () => {
        const { raw, backupDir, tmpDir } = setUpBackup();
        mkdirSync(backupDir);
        chmodSync(backupDir, 0o500); // the final rename into backups/ is refused
        try {
          expect(() => backupDatabase(raw, { backupDir, tmpDir }, 1, fakeClock().now)).toThrow();
        } finally {
          chmodSync(backupDir, 0o700);
        }
        expect(readdirSync(backupDir)).toEqual([]);
        expect(readdirSync(tmpDir)).toEqual([]);
        raw.close();
      },
    );
  });
});
