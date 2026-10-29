import { beforeEach, describe, expect, it, vi } from "vitest";
import { holdQuiescentJob } from "./quiescent/job.js";
import { fakeHold, fakeWorker, taskDb, taskDeps, validatedFile } from "./testing.js";
import { verifySnapshot } from "./verify.js";

vi.mock("./quiescent/job.js", async (original) => ({
  ...(await original<typeof import("./quiescent/job.js")>()),
  holdQuiescentJob: vi.fn(),
}));

const MiB = 2 ** 20;

describe("verify (save-transfer.md section 6)", () => {
  beforeEach(() => vi.mocked(holdQuiescentJob).mockReset());

  it("sizes the import and re-export windows from the validated snapshot's data, like a restore", async () => {
    const { repos, gameId, store } = taskDb();
    const row = store("export");
    const worker = fakeWorker(validatedFile(gameId, 300 * MiB));
    const { deps } = taskDeps(repos, worker);
    const { hold, windowBytes, release } = fakeHold(gameId);
    vi.mocked(holdQuiescentJob).mockResolvedValue({ ok: true, data: hold });

    const result = await verifySnapshot(gameId, row.revisionId, deps);

    expect(result).toMatchObject({ ok: true, data: { revisionId: row.revisionId } });
    // R6 then R7: each window's deadline grows with the 300 MiB the file holds.
    expect(windowBytes).toEqual([300 * MiB, 300 * MiB]);
    expect(release).toHaveBeenCalledOnce();
    expect(worker.kill).toHaveBeenCalled();
  });
});
