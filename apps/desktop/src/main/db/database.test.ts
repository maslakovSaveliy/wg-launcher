import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WritableDb } from "./database.js";
import { dbOptions, fakeClock, openDb, openTestDb, tempDir } from "./testing.js";

function open(): WritableDb {
  return openTestDb(tempDir());
}

const pragma = (db: WritableDb, name: string): unknown =>
  Object.values(db.raw.prepare(`PRAGMA ${name}`).get() ?? {})[0];

describe("openDatabase", () => {
  it("sets the per-connection pragmas of architecture.md section 7", () => {
    const db = open();
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "synchronous")).toBe(2); // FULL
    db.close();
  });

  it("enforces foreign keys: a play session needs its game", () => {
    const db = open();
    expect(() =>
      db.raw.exec(
        "INSERT INTO play_sessions (game_id, started_at, checkpoint_at) VALUES ('nope', 1, 1)",
      ),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it("rejects an unsupported support_mode", () => {
    const db = open();
    expect(() =>
      db.raw.exec(
        "INSERT INTO games (id, url, title, support_mode, created_at, updated_at) VALUES ('g', 'u', 't', 'package', 1, 1)",
      ),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it("transaction commits on return, rolls back on a throw, and nests", () => {
    const db = open();
    const count = () =>
      (db.raw.prepare("SELECT count(*) AS n FROM settings").get() as { n: number }).n;
    db.transaction(() => db.raw.exec("INSERT INTO settings VALUES ('a', '1')"));
    expect(count()).toBe(1);
    expect(() =>
      db.transaction(() => {
        db.raw.exec("INSERT INTO settings VALUES ('b', '2')");
        db.transaction(() => db.raw.exec("INSERT INTO settings VALUES ('c', '3')"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count()).toBe(1);
    expect(db.raw.isTransaction).toBe(false);
    db.close();
  });

  it("survives a restart: what was written is there after closing and reopening", () => {
    const dir = tempDir();
    const options = dbOptions(dir, fakeClock());
    const first = openDb(join(dir, "library.db"), options);
    if (first.readOnly) throw new Error(first.reason);
    first.raw.exec("INSERT INTO settings VALUES ('a', '1')");
    first.close();
    const second = openDb(join(dir, "library.db"), options);
    expect(second.readOnly).toBe(false);
    expect(second.raw.prepare("SELECT value FROM settings WHERE key = 'a'").get()).toMatchObject({
      value: "1",
    });
    second.close();
  });
});
