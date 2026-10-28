// The storage check behind the "Local data" badge (architecture.md section 11): the quiescent inventory, counts and
// usage numbers only, over every known key of the game. It holds a `background` lease, so a launch cancels it
// (plan M5: the launch aborts the lease's signal and waits for its release), and it then records nothing. `has_data`
// means at least one localStorage item or IndexedDB database, or `usageDetails.fileSystem` above zero.
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { StorageCheck } from "../db/repos/storage-checks.js";
import type { SnapshotWorker } from "../worker/client.js";
import type { SnapshotDeps } from "./export.js";
import { knownKeys } from "./keys.js";
import { runQuiescentJob } from "./quiescent/job.js";

export async function runStorageCheck(
  gameId: string,
  signal: AbortSignal | undefined,
  deps: SnapshotDeps,
): Promise<Result<StorageCheck, ErrorCode>> {
  const game = deps.repos.games.get(gameId);
  if (!game) return { ok: false, code: "NOT_FOUND", message: "The game is not in the library." };
  const keys = knownKeys(game.url, deps.repos.storageTargets.listForGame(gameId));
  let worker: SnapshotWorker | null = null;
  let hasData = false;
  try {
    return await runQuiescentJob<StorageCheck>(
      gameId,
      {
        direction: "export",
        lock: "background",
        keys,
        async runFrames(frames) {
          worker ??= await deps.startWorker();
          worker.begin({});
          for (const frame of frames) {
            const inventory = await worker.inventory(frame.port);
            if (!inventory.ok) return inventory;
            const { localStorageItems, databases, usageDetails } = inventory.data;
            if (
              localStorageItems > 0 ||
              databases.length > 0 ||
              (usageDetails?.fileSystem ?? 0) > 0
            ) {
              hasData = true;
            }
          }
          return { ok: true, data: undefined };
        },
        async commit(context) {
          if (context.signal.aborted) {
            return { ok: false, code: "CANCELLED", message: "The check was cancelled." };
          }
          deps.repos.storageChecks.save(gameId, hasData);
          const saved = deps.repos.storageChecks.get(gameId);
          if (!saved)
            return { ok: false, code: "INTERNAL", message: "The check was not recorded." };
          deps.log.info("snapshot.storage-check.done", { gameId, hasData, keys: keys.length });
          return { ok: true, data: saved };
        },
        async discard() {},
      },
      deps.job,
      signal,
    );
  } finally {
    (worker as SnapshotWorker | null)?.kill();
  }
}
