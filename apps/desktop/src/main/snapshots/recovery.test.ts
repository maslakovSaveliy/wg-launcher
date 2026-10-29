import { uuidv7 } from "@wg-launcher/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginJournal } from "./journal.js";
import { holdQuiescentJob } from "./quiescent/job.js";
import { retryRecovery } from "./recovery.js";
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
});
