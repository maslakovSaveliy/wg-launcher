import { uuidv7 } from "@wg-launcher/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginJournal } from "./journal.js";
import { holdQuiescentJob } from "./quiescent/job.js";
import { recoveryNotice, retryRecovery } from "./recovery.js";
import { fakeHold, fakeWorker, taskDb, taskDeps, validatedFile } from "./testing.js";

vi.mock("./quiescent/job.js", async (original) => ({
  ...(await original<typeof import("./quiescent/job.js")>()),
  holdQuiescentJob: vi.fn(),
}));

/** A game whose import stopped after the wipe, with its backup recorded. */
function pendingRecovery() {
  const db = taskDb();
  const backup = db.store("backup");
  const journal = beginJournal(db.repos.restoreJournal, {
    id: uuidv7(),
    gameId: db.gameId,
    kind: "import",
    step: "wipe",
  });
  journal.backup(backup.revisionId);
  return { ...db, backup, journal };
}

describe("Retry recovery (save-transfer.md section 6, Failed rollback)", () => {
  beforeEach(() => vi.mocked(holdQuiescentJob).mockReset());

  it("gives the hold back when the caller's onLocked throws", async () => {
    const { repos, gameId } = pendingRecovery();
    const { deps } = taskDeps(repos, fakeWorker(validatedFile(gameId, 1024)));
    const { hold, release } = fakeHold(gameId);
    vi.mocked(holdQuiescentJob).mockResolvedValue({ ok: true, data: hold });
    const onLocked = () => {
      throw new Error("the task id could not be sent");
    };

    await expect(retryRecovery(gameId, deps, { onLocked })).rejects.toThrow("task id");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back under the hold and frees the game", async () => {
    const { repos, gameId, journal } = pendingRecovery();
    const { deps, recovery } = taskDeps(repos, fakeWorker(validatedFile(gameId, 1024)));
    const { hold, release } = fakeHold(gameId);
    vi.mocked(holdQuiescentJob).mockResolvedValue({ ok: true, data: hold });
    const onLocked = vi.fn();

    expect(await retryRecovery(gameId, deps, { onLocked })).toEqual({ ok: true, data: undefined });
    expect(onLocked).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(recovery.clear).toHaveBeenCalledWith(gameId);
    expect(journal.entry().state).toBe("failed");
  });

  it("closes the journal and clears the game's mark together, so a failed write leaves the recovery pending", async () => {
    const { db, repos, gameId, journal } = pendingRecovery();
    repos.games.update(gameId, { needsRecovery: true });
    const { deps } = taskDeps(repos, fakeWorker(validatedFile(gameId, 1024)));
    (deps as { transaction: (fn: () => unknown) => unknown }).transaction = (fn) =>
      db.transaction(fn);
    const { hold } = fakeHold(gameId);
    vi.mocked(holdQuiescentJob).mockResolvedValue({ ok: true, data: hold });
    const update = repos.games.update.bind(repos.games);
    repos.games.update = (id, patch) => {
      if (patch.needsRecovery === false) throw new Error("disk full");
      return update(id, patch);
    };

    const result = await retryRecovery(gameId, deps);
    expect(result.ok).toBe(false);
    // The next start finds the entry unfinished and runs the recovery again; the game stays marked.
    expect(journal.entry().state).not.toBe("failed");
    expect(repos.games.get(gameId)?.needsRecovery).toBe(true);
  });
});

describe("the notice of a refused launch (save-transfer.md section 6)", () => {
  it("names the backup and Retry recovery while no task holds the game", () => {
    const { repos, gameId } = pendingRecovery();
    const notice = recoveryNotice(repos, gameId, { taskRunning: false });
    expect(notice).toContain("was interrupted");
    expect(notice).toContain("Retry recovery");
  });

  it("says a task is changing the saves while one holds the game past the wipe", () => {
    const { repos, gameId } = pendingRecovery();
    const notice = recoveryNotice(repos, gameId, { taskRunning: true });
    expect(notice).toBe(
      "A task is changing this game's saves right now (an import, a delete, or putting back the saves from before). The game can start when it ends.",
    );
  });
});
