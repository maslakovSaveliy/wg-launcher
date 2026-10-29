// Recovery of an interrupted or failed restore or delete (save-transfer.md section 6, "Crash or power loss" and
// "Failed rollback"; plan Review Focus 2). At start-up, before any game can launch, the main process reads the
// unfinished journal entries: a job that stopped in R1 to R4 changed no game storage, so its entry is closed (`tmp/`
// is emptied at start-up anyway); a job that reached R5, or a rollback that never verified, marks its game in the
// lock manager at once (launches and tasks are refused) and then runs the rollback. A verified rollback clears the
// mark and closes the entry `failed`; a failed one leaves the game `needs_recovery` with the entry `rolling-back`,
// and "Retry recovery" runs it again. The backup is never deleted.
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { Repos } from "../db/repos/index.js";
import type { JournalEntry } from "../db/repos/restore-journal.js";
import type { FaultPoint } from "./faults.js";
import { reachedWipe, resumeJournal } from "./journal.js";
import { holdQuiescentJob } from "./quiescent/job.js";
import { markNeedsRecovery } from "./restore.js";
import { backupName, fail, rollBack, type TaskDeps } from "./restore-steps.js";

/** The text a refused launch shows while a game needs recovery: it names the backup that holds its saves. */
export function recoveryNotice(
  repos: Pick<Repos, "restoreJournal" | "snapshots">,
  gameId: string,
): string {
  const entry = pendingEntry(repos, gameId);
  const backup =
    entry?.backupRevisionId == null ? null : repos.snapshots.findByRevision(entry.backupRevisionId);
  if (backup === null) {
    return "The game's saves need recovery before it can start.";
  }
  return `The game's saves need recovery before it can start: an import or delete was interrupted. Its saves from before are kept in ${backupName(backup)}; use "Retry recovery".`;
}

/** The game's latest unfinished entry that reached R5 (the one a rollback must finish). */
function pendingEntry(
  repos: Pick<Repos, "restoreJournal">,
  gameId: string,
): JournalEntry | undefined {
  return repos.restoreJournal
    .listUnfinished()
    .filter((entry) => entry.gameId === gameId && reachedWipe(entry))
    .at(-1);
}

/** Rolls one entry back under a recovery lease; on success the game is free again. */
async function recoverEntry(
  entry: JournalEntry,
  deps: TaskDeps,
  onStep?: (point: FaultPoint) => void,
): Promise<Result<void, ErrorCode>> {
  const { gameId } = entry;
  const backup =
    entry.backupRevisionId === null
      ? null
      : deps.repos.snapshots.findByRevision(entry.backupRevisionId);
  if (backup === null) {
    deps.recovery.mark(gameId);
    deps.log.error("snapshot.recovery.no-backup", { gameId, journal: entry.id });
    return fail("IMP_RECOVERY_FAILED", "The backup of this game's saves is not recorded.");
  }
  const held = await holdQuiescentJob(gameId, "task", deps.job, { recovery: true });
  if (!held.ok) {
    deps.log.warn("snapshot.recovery.not-started", { gameId, code: held.code });
    return held;
  }
  const journal = resumeJournal(deps.repos.restoreJournal, entry);
  try {
    const rolled = await rollBack(held.data, journal, backup, deps, onStep);
    if (!rolled.ok) return markNeedsRecovery(gameId, backup, rolled, deps);
    journal.finish("failed");
    deps.recovery.clear(gameId);
    if (deps.repos.games.get(gameId)) deps.repos.games.update(gameId, { needsRecovery: false });
    deps.log.info("snapshot.recovery.done", { gameId, backupRevisionId: backup.revisionId });
    return { ok: true, data: undefined };
  } finally {
    held.data.release();
    deps.afterChange?.(gameId);
  }
}

/**
 * Start-up: closes the entries that never reached R5 and marks the games of the others before returning, so no launch
 * gets in between; `done` resolves once each of their rollbacks has run (one at a time).
 */
export function recoverAtStartup(deps: TaskDeps): { pending: string[]; done: Promise<void> } {
  const entries = deps.repos.restoreJournal.listUnfinished();
  const reached: JournalEntry[] = [];
  for (const entry of entries) {
    if (reachedWipe(entry)) {
      deps.recovery.mark(entry.gameId);
      reached.push(entry);
    } else {
      resumeJournal(deps.repos.restoreJournal, entry).finish("failed");
      deps.log.info("snapshot.recovery.closed", { gameId: entry.gameId, step: entry.step });
    }
  }
  for (const entry of reached) {
    deps.log.warn("snapshot.recovery.pending", { gameId: entry.gameId, step: entry.step });
  }
  const done = (async () => {
    for (const entry of reached) {
      try {
        await recoverEntry(entry, deps);
      } catch (error) {
        deps.log.error("snapshot.recovery.threw", { gameId: entry.gameId, error });
      }
    }
  })();
  return { pending: [...new Set(reached.map((entry) => entry.gameId))], done };
}

/** "Retry recovery": the rollback of the game's pending entry again. */
export async function retryRecovery(
  gameId: string,
  deps: TaskDeps,
  options: { onLocked?(): void; onStep?(point: FaultPoint): void } = {},
): Promise<Result<void, ErrorCode>> {
  const entry = pendingEntry(deps.repos, gameId);
  if (entry === undefined) return fail("NOT_FOUND", "No recovery is pending for this game.");
  options.onLocked?.();
  return recoverEntry(entry, deps, options.onStep);
}
