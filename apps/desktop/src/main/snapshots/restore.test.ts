import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@wg-launcher/shared";
import { describe, expect, it } from "vitest";
import { tempDir } from "../db/testing.js";
import { beginJournal } from "./journal.js";
import { commitRestore } from "./restore.js";
import { fakeWorker, taskDb, taskDeps, validatedFile } from "./testing.js";

describe("the row a restored external file is recorded with (AC-12, save-transfer.md section 8)", () => {
  it("is flush unconfirmed although the file's manifest claims confirmed", async () => {
    const { db, repos, gameId } = taskDb();
    const validated = validatedFile(gameId, 1024);
    validated.manifest.flushState = "confirmed";
    const { deps } = taskDeps(repos, fakeWorker(validated));
    const dir = tempDir();
    Object.assign(deps, {
      paths: { snapshots: join(dir, "snapshots"), tmp: dir, backups: join(dir, "backups") },
      transaction: <T>(fn: () => T) => db.transaction(fn),
    });
    const copy = join(dir, "copy.wgsnap");
    writeFileSync(copy, "bytes");
    const journal = beginJournal(repos.restoreJournal, {
      id: uuidv7(),
      gameId,
      kind: "import",
      step: "verify",
    });

    expect(await commitRestore(gameId, validated, copy, journal, deps)).toEqual({
      ok: true,
      data: undefined,
    });
    const row = repos.snapshots.findByRevision(validated.manifest.revisionId);
    expect(row?.kind).toBe("imported");
    expect(row?.flushState).toBe("unconfirmed");
  });
});
