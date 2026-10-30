// The restore journal of one operation (save-transfer.md section 6): each step is written to `restore_journal` before
// it starts, so a crash leaves the last step begun. An entry ends `done` (R8 committed) or `failed` (it stopped, and
// anything it changed was rolled back and verified); `rolling-back` stays while a rollback has not verified, so the
// next start-up and "Retry recovery" try it again. Writes are synchronous SQLite with `synchronous = FULL`.

import type { Repos } from "../db/repos/index.js";
import type { JournalEntry, JournalKind } from "../db/repos/restore-journal.js";
import type { FaultPoint } from "./faults.js";

/** The steps of R1 to R4: a job stopped there changed no game storage. */
const BEFORE_WIPE: ReadonlySet<string> = new Set(["validate", "plan", "lock", "backup"]);

/** True when the entry's job may have changed game storage (it reached R5), so a rollback must run first. */
export const reachedWipe = (entry: Pick<JournalEntry, "step" | "state">): boolean =>
  entry.state === "rolling-back" || !BEFORE_WIPE.has(entry.step);

export interface Journal {
  readonly id: string;
  readonly gameId: string;
  /** Writes `step` (still `running`, or `rolling-back` for a rollback step). */
  step(step: FaultPoint): void;
  revision(revisionId: string): void;
  backup(backupRevisionId: string): void;
  finish(state: "done" | "failed"): void;
  entry(): JournalEntry;
}

type JournalRepo = Repos["restoreJournal"];

function wrap(repo: JournalRepo, id: string, gameId: string): Journal {
  const read = () => {
    const entry = repo.get(id);
    if (entry === null) throw new Error("The restore journal entry is gone.");
    return entry;
  };
  return {
    id,
    gameId,
    step(step) {
      repo.update(id, step.startsWith("rollback-") ? { step, state: "rolling-back" } : { step });
    },
    revision: (revisionId) => void repo.update(id, { revisionId }),
    backup: (backupRevisionId) => void repo.update(id, { backupRevisionId }),
    finish: (state) => void repo.update(id, { state }),
    entry: read,
  };
}

/** Begins an entry at its first step. */
export function beginJournal(
  repo: JournalRepo,
  entry: { id: string; gameId: string; kind: JournalKind; revisionId?: string; step: FaultPoint },
): Journal {
  repo.begin(entry);
  return wrap(repo, entry.id, entry.gameId);
}

/** An unfinished entry found at start-up or by "Retry recovery". */
export function resumeJournal(repo: JournalRepo, entry: JournalEntry): Journal {
  return wrap(repo, entry.id, entry.gameId);
}
