import type { WritableDb } from "../database.js";
import { updateWhere } from "./sql.js";

export type JournalKind = "import" | "delete-saves";
export type JournalState = "running" | "rolling-back" | "done" | "failed";

/** One restore or delete-saves operation, written before each step (save-transfer.md section 6). */
export interface JournalEntry {
  id: string;
  gameId: string;
  kind: JournalKind;
  revisionId: string | null;
  backupRevisionId: string | null;
  step: string;
  state: JournalState;
  startedAt: number;
  updatedAt: number;
}

export interface NewJournalEntry {
  id: string;
  gameId: string;
  kind: JournalKind;
  revisionId?: string | null;
  step: string;
}

interface JournalRow {
  id: string;
  game_id: string;
  kind: JournalKind;
  revision_id: string | null;
  backup_revision_id: string | null;
  step: string;
  state: JournalState;
  started_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, game_id, kind, revision_id, backup_revision_id, step, state, started_at, updated_at";

const toEntry = (row: JournalRow): JournalEntry => ({
  id: row.id,
  gameId: row.game_id,
  kind: row.kind,
  revisionId: row.revision_id,
  backupRevisionId: row.backup_revision_id,
  step: row.step,
  state: row.state,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
});

export function createRestoreJournalRepo(db: WritableDb) {
  const insert = db.raw.prepare(
    `INSERT INTO restore_journal (id, game_id, kind, revision_id, step, state, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
  );
  const get = db.raw.prepare(`SELECT ${COLUMNS} FROM restore_journal WHERE id = ?`);
  // Start-up recovery only, over a table that holds a handful of rows.
  const unfinished = db.raw.prepare(
    `SELECT ${COLUMNS} FROM restore_journal WHERE state IN ('running', 'rolling-back') ORDER BY started_at, id`,
  );
  const read = (id: string): JournalEntry | null => {
    const row = get.get(id) as JournalRow | undefined;
    return row ? toEntry(row) : null;
  };
  return {
    /** Writes a new entry in state `running`. */
    begin(entry: NewJournalEntry): JournalEntry {
      const at = db.now();
      insert.run(entry.id, entry.gameId, entry.kind, entry.revisionId ?? null, entry.step, at, at);
      const stored = read(entry.id);
      if (!stored) throw new Error("restoreJournal.begin: the inserted row cannot be read back.");
      return stored;
    },
    get: read,
    update(
      id: string,
      patch: {
        step?: string;
        state?: JournalState;
        revisionId?: string | null;
        backupRevisionId?: string | null;
      },
    ): JournalEntry | null {
      updateWhere(
        db,
        "restore_journal",
        "id",
        id,
        patch,
        {
          step: "step",
          state: "state",
          revisionId: "revision_id",
          backupRevisionId: "backup_revision_id",
        },
        { updated_at: db.now() },
      );
      return read(id);
    },
    listUnfinished: (): JournalEntry[] =>
      (unfinished.all() as unknown as JournalRow[]).map(toEntry),
  };
}
