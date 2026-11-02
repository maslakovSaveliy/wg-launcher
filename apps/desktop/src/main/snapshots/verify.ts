// Verify (`snapshot:verify`, save-transfer.md section 6): R1, then R6 and R7 into a fresh in-memory partition
// (`wg-verify-<nonce>`, no `persist:` prefix) whose data is cleared afterwards; the game's own partition is never
// touched. The game's `task` lease is held meanwhile (architecture.md section 4: verify is a user task). Passing sets
// `verified_at` and `verified_exporter_version` to the running exporter's version, which is what "Export verified"
// shows (architecture.md section 11). It says nothing about flush (save-transfer.md section 7).
import { GENERIC_EXPORTER } from "@wg-launcher/exporters/wire";
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { Snapshot } from "../db/repos/snapshots.js";
import { workerSlot } from "../worker/slot.js";
import { failureOf, holdQuiescentJob } from "./quiescent/job.js";
import {
  ALL,
  adapterScopeOf,
  fail,
  importKeys,
  ownKeys,
  type TaskDeps,
  verifyKeys,
} from "./restore-steps.js";

export async function verifySnapshot(
  gameId: string,
  revisionId: string,
  deps: TaskDeps,
  options: { onLocked?(): void } = {},
): Promise<Result<Snapshot, ErrorCode>> {
  const { repos, log } = deps;
  const game = repos.games.get(gameId);
  if (!game) return fail("NOT_FOUND", "The game is not in the library.");
  const row = repos.snapshots
    .listForGame(gameId, game.baseRevisionId)
    .find((snapshot) => snapshot.revisionId === revisionId);
  if (!row) return fail("NOT_FOUND", "The snapshot is not stored for this game.");
  if (!deps.verifySession) return fail("INTERNAL", "Verification is not available.");
  const held = await holdQuiescentJob(gameId, "task", deps.job);
  if (!held.ok) return held;
  options.onLocked?.();
  const workers = workerSlot(deps.startWorker, {});
  let fresh: ReturnType<NonNullable<TaskDeps["verifySession"]>> | null = null;
  try {
    fresh = deps.verifySession();
    const worker = await workers.get(held.data.signal);
    if (worker === null) return failureOf(held.data.signal);
    const validated = await worker.validate(deps.fileOf(row.path));
    if (!validated.ok) return validated;
    if (validated.data.manifest.contentHash !== row.contentHash) {
      return fail("IMP_VERIFY_MISMATCH", "The snapshot file differs from its record.");
    }
    const scope = adapterScopeOf(validated.data.manifest.adapter);
    if (!scope.ok) return scope;
    const keys = ownKeys(validated.data.manifest.storageKeys);
    // The windows' deadlines grow with the data the file holds, as a restore's do (save-transfer.md section 6).
    const windows = { session: fresh.session, budgetBytes: validated.data.dataBytes };
    const imported = await importKeys(held.data, keys, scope.data ?? ALL, worker, windows);
    if (!imported.ok) return imported;
    const verified = await verifyKeys(
      held.data,
      keys,
      scope.data ?? ALL,
      worker,
      row.contentHash,
      windows,
    );
    if (!verified.ok) return verified;
    repos.snapshots.markVerified(revisionId, GENERIC_EXPORTER.version);
    log.info("snapshot.verify.done", { gameId, revisionId, keys: keys.length });
    return { ok: true, data: repos.snapshots.findByRevision(revisionId) as Snapshot };
  } finally {
    await workers.dispose();
    await fresh
      ?.dispose()
      .catch((error: unknown) => log.error("snapshot.verify.clear-failed", { error }));
    held.data.release();
  }
}
