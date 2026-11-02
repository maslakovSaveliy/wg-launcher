import { uuidv7 } from "@wg-launcher/shared";
import { describe, expect, it } from "vitest";
import { beginJournal } from "./journal.js";
import {
  changeOrRollBack,
  markNeedsRecovery,
  rollBack,
  trustedFlushState,
  validateBoundMs,
} from "./restore-steps.js";
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

  it("a bound past the longest timer Node keeps waits instead of firing at once", async () => {
    const { repos, gameId, store } = taskDb();
    const backup = store("backup");
    const worker = fakeWorker(validatedFile(gameId, MiB));
    const answer = worker.validate.getMockImplementation();
    // A validation that answers after 30 ms, under a bound of years (the e2e test's long per-MiB allowance).
    worker.validate.mockImplementation(
      (...args) =>
        new Promise((resolve) => setTimeout(() => resolve(answer?.(...args) as never), 30)),
    );
    const { deps } = taskDeps(repos, worker, { deadlineMs: 4000, deadlinePerMiBMs: 1e9 });
    expect(
      validateBoundMs(backup.sizeBytes, { deadlineMs: 4000, deadlinePerMiBMs: 1e9 }),
    ).toBeGreaterThan(2 ** 31);
    const { hold } = fakeHold(gameId);
    expect(await rollBack(hold, journalOf(repos, gameId), backup, deps)).toEqual({
      ok: true,
      data: undefined,
    });
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

describe("the flush state an imported snapshot is recorded with (AC-12, save-transfer.md section 7)", () => {
  it("is unconfirmed whatever the file says when no bundled adapter declares a flush hook", () => {
    expect(trustedFlushState({ flushState: "confirmed", adapter: null })).toBe("unconfirmed");
    expect(
      trustedFlushState({
        flushState: "confirmed",
        adapter: { id: "progress-lab", version: "1.0.0" },
      }),
    ).toBe("unconfirmed");
    expect(
      trustedFlushState({
        flushState: "confirmed",
        adapter: { id: "elsewhere", version: "9.9.9" },
      }),
    ).toBe("unconfirmed");
  });

  it("keeps an unconfirmed file unconfirmed", () => {
    expect(trustedFlushState({ flushState: "unconfirmed", adapter: null })).toBe("unconfirmed");
  });
});

describe("the message of a failed rollback", () => {
  const backup = { revisionId: uuidv7(), createdAt: "2026-10-29T00:00:00.000Z" };
  const deps = (hasGame: boolean) => ({
    repos: { games: { get: () => (hasGame ? {} : null), update: () => {} } },
    recovery: { mark: () => {}, clear: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, flush: () => {} },
  });
  const cause = { code: "IMP_WIPE_FAILED" as const, message: "x" };

  it("offers Retry recovery for a game in the library", () => {
    const out = markNeedsRecovery(uuidv7(), backup, cause, deps(true) as never);
    expect(out.message).toContain('use "Retry recovery"');
  });

  it("names the next start for a removed game's data, which has no Retry recovery control", () => {
    const out = markNeedsRecovery(uuidv7(), backup, cause, deps(false) as never);
    expect(out.message).not.toContain("Retry recovery");
    expect(out.message).toContain("next start");
  });
});
