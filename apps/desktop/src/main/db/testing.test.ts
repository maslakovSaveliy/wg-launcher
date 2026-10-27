import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WritableDb } from "./database.js";
import { fakeClock, openTestDb, tempDir } from "./testing.js";

// Windows cannot delete a file that is still open, so every database a test opens must be closed before the
// helper removes its directory. The two tests run in order: the second looks at what the first left behind.
describe("test helpers", () => {
  let first: { db: WritableDb; dir: string } | undefined;

  it("opens a database in a temporary directory", () => {
    const dir = tempDir();
    first = { db: openTestDb(dir, fakeClock()), dir };
    expect(first.db.raw.isOpen).toBe(true);
    expect(existsSync(first.dir)).toBe(true);
  });

  it("closes that database and removes its directory after the test", () => {
    expect(first?.db.raw.isOpen).toBe(false);
    expect(existsSync(first?.dir ?? "")).toBe(false);
  });
});
