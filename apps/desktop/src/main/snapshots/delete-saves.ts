// "Delete local saves" (PRD section 9, AC-16; save-transfer.md section 6): R3 (the wipe set is every known key of the
// game, computed under the lock), R4 (the backup, written and validated by reading it back), R5 (the whole key of each
// frame cleared, then an inventory that must find nothing), then R8 with `base_revision_id` set to null, because the
// partition no longer descends from any revision. A failure after R5 restores the backup as a restore's rollback
// does. It works for a library entry and for a removed game's data ("Data of removed games",
// `library:deleteOrphanData`), whose orphan row goes once its data is gone. OPFS and other file systems are kept
// (they cannot be backed up in v1), cookies and caches are not touched.
import type { ErrorCode, Result } from "@wg-launcher/shared";
import { workerSlot } from "../worker/slot.js";
import type { FaultPoint } from "./faults.js";
import { beginJournal } from "./journal.js";
import { knownKeys } from "./keys.js";
import { failureOf, holdQuiescentJob, type QuiescentHold } from "./quiescent/job.js";
import { markNeedsRecovery } from "./restore.js";
import {
  backupName,
  fail,
  rollBack,
  runStep,
  type TaskDeps,
  wipeKeys,
  writeBackup,
} from "./restore-steps.js";

export interface DeleteOptions {
  onLocked?(): void;
  onStep?(point: FaultPoint): void;
}

export async function deleteLocalSaves(
  gameId: string,
  deps: TaskDeps,
  options: DeleteOptions = {},
): Promise<Result<{ backupRevisionId: string }, ErrorCode>> {
  const { repos, log } = deps;
  const game = repos.games.get(gameId);
  const orphan = game ? null : repos.orphans.get(gameId);
  const entry = game ?? orphan;
  if (!entry) return fail("NOT_FOUND", "The game is not in the library.");
  const confirmed = await deps.confirm({
    title: "Delete local saves?",
    message: `Delete what "${entry.title}" saved on this computer?`,
    detail:
      "Deleted: the game's localStorage and IndexedDB data on this computer. A backup is made first and kept " +
      "(backups are never deleted automatically). Kept: snapshots, backups, cookies, the cache, and files the game " +
      "keeps in other file systems (OPFS), which cannot be backed up yet.",
    confirmLabel: "Delete local saves",
  });
  if (!confirmed) return fail("CANCELLED", "Nothing was deleted.");

  const journal = beginJournal(repos.restoreJournal, {
    id: deps.newId(),
    gameId,
    kind: "delete-saves",
    step: "lock",
  });
  const context = {
    journal,
    ...(deps.faults ? { faults: deps.faults } : {}),
    ...(options.onStep ? { onStep: options.onStep } : {}),
  };
  const workers = workerSlot(deps.startWorker, {});
  let hold: QuiescentHold | null = null;
  const stopBeforeWipe = (failure: { ok: false; code: ErrorCode; message: string }) => {
    journal.finish("failed");
    log.warn("snapshot.delete-saves.failed", {
      gameId,
      code: failure.code,
      step: journal.entry().step,
    });
    return failure;
  };
  try {
    // R3: the wipe set under the lock.
    const locked = await runStep("lock", context, async () => {
      const held = await holdQuiescentJob(gameId, "task", deps.job);
      if (!held.ok) return held;
      hold = held.data;
      options.onLocked?.();
      return { ok: true, data: held.data };
    });
    if (!locked.ok) return stopBeforeWipe(locked);
    const held = locked.data;
    const keys = knownKeys(entry.url, repos.storageTargets.listForGame(gameId));

    // R4.
    const backupRevisionId = deps.newId();
    journal.backup(backupRevisionId);
    const backedUp = await runStep("backup", context, () =>
      writeBackup(held, keys, backupRevisionId, deps),
    );
    if (!backedUp.ok) return stopBeforeWipe(backedUp);
    const backup = backedUp.data;

    // R5 and R8.
    const changed = await (async (): Promise<Result<void, ErrorCode>> => {
      const wiped = await runStep("wipe", context, async () => {
        const worker = await workers.get(held.signal);
        if (worker === null) return failureOf(held.signal);
        return wipeKeys(held, keys, "all", worker);
      });
      if (!wiped.ok) return wiped;
      return runStep("commit", context, async () => {
        deps.transaction(() => {
          if (game) repos.games.update(gameId, { baseRevisionId: null });
          else repos.orphans.delete(gameId);
          journal.finish("done");
        });
        return { ok: true, data: undefined };
      });
    })();
    if (changed.ok) {
      log.info("snapshot.delete-saves.done", { gameId, backupRevisionId, keys: keys.length });
      return { ok: true, data: { backupRevisionId } };
    }
    log.warn("snapshot.delete-saves.failed", {
      gameId,
      code: changed.code,
      step: journal.entry().step,
    });
    const rolled = await rollBack(held, journal, backup, deps, options.onStep);
    if (rolled.ok) {
      journal.finish("failed");
      return {
        ok: false,
        code: changed.code,
        message: `${changed.message} Nothing was deleted: the saves were put back from ${backupName(backup)}.`,
      };
    }
    return markNeedsRecovery(gameId, backup, rolled, deps);
  } finally {
    await workers.dispose();
    (hold as QuiescentHold | null)?.release();
    if (hold !== null) deps.afterChange?.(gameId);
  }
}
