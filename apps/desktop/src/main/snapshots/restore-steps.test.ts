import { uuidv7 } from "@wg-launcher/shared";
import { describe, expect, it } from "vitest";
import { beginJournal } from "./journal.js";
import { changeOrRollBack, rollBack, validateBoundMs } from "./restore-steps.js";
import { fakeHold, fakeWorker, taskDb, taskDeps, validatedFile } from "./testing.js";

const MiB = 2 ** 20;

function journalOf(repos: ReturnType<typeof taskDb>["repos"], gameId: string) {
  return beginJournal(repos.restoreJournal, {
    id: uuidv7(),
    gameId,
    kind: "import",
    step: "wipe",
  });
}

describe("the rollback's validation of the backup (save-transfer.md section 6)", () => {
  it("is bounded by the job deadline over the most data the reader accepts from the file", () => {
    const timing = { deadlineMs: 60_000, deadlinePerMiBMs: 1_000 };
    // 200 times 100 KiB is below the ratio floor: 64 MiB at most.
    expect(validateBoundMs(100 * 1024, timing)).toBe(60_000 + 64_000);
    // 200 times the file above it, at most 2 GiB in all.
    expect(validateBoundMs(2 * MiB, timing)).toBe(60_000 + 400_000);
    expect(validateBoundMs(100 * MiB, timing)).toBe(60_000 + 2048_000);
  });

  it("a validation that never answers is a failed rollback, and the game needs recovery", async () => {
    const { repos, gameId, store } = taskDb();
    const backup = store("backup");
    const worker = fakeWorker(null);
    const { deps, recovery } = taskDeps(repos, worker, { deadlineMs: 20, deadlinePerMiBMs: 0 });
    const { hold, windowBytes } = fakeHold(gameId);
    const journal = journalOf(repos, gameId);

    const rolled = await rollBack(hold, journal, backup, deps);
    expect(rolled).toMatchObject({ ok: false, code: "IMP_RECOVERY_FAILED" });
    // No window ran, nothing was wiped, and the worker was killed.
    expect(windowBytes).toEqual([]);
    expect(worker.kill).toHaveBeenCalled();

    const changed = await changeOrRollBack(hold, journal, backup, deps, async () => ({
      ok: false,
      code: "INTERNAL",
      message: "The import failed.",
    }));
    expect(changed).toMatchObject({ ok: false, code: "IMP_RECOVERY_FAILED" });
    expect(recovery.mark).toHaveBeenCalledWith(gameId);
    expect(recovery.clear).not.toHaveBeenCalled();
    expect(repos.games.get(gameId)?.needsRecovery).toBe(true);
    expect(journal.entry().state).toBe("rolling-back");
  });

  it("a validation that answers in time rolls back with windows sized from the backup's data", async () => {
    const { repos, gameId, store } = taskDb();
    const backup = store("backup");
    const worker = fakeWorker(validatedFile(gameId, 5 * MiB));
    const { deps } = taskDeps(repos, worker, { deadlineMs: 20, deadlinePerMiBMs: 0 });
    const { hold, windowBytes } = fakeHold(gameId);

    expect(await rollBack(hold, journalOf(repos, gameId), backup, deps)).toEqual({
      ok: true,
      data: undefined,
    });
    expect(windowBytes).toEqual([5 * MiB, 5 * MiB, 5 * MiB]);
  });
});
