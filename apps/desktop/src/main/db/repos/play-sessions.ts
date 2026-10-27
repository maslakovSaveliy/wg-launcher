import type { WritableDb } from "../database.js";

export interface PlaySession {
  id: number;
  gameId: string;
  startedAt: number;
  endedAt: number | null;
  activeMs: number;
  checkpointAt: number;
}

interface PlaySessionRow {
  id: number;
  game_id: string;
  started_at: number;
  ended_at: number | null;
  active_ms: number;
  checkpoint_at: number;
}

const COLUMNS = "id, game_id, started_at, ended_at, active_ms, checkpoint_at";

export const PLAY_SESSIONS_SQL = {
  // Served by play_sessions_by_game (game_id, started_at): no sort step.
  listForGame: `SELECT ${COLUMNS} FROM play_sessions WHERE game_id = ? ORDER BY started_at, id`,
  totalActiveMs: "SELECT COALESCE(SUM(active_ms), 0) AS total FROM play_sessions WHERE game_id = ?",
} as const;

const toSession = (row: PlaySessionRow): PlaySession => ({
  id: row.id,
  gameId: row.game_id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  activeMs: row.active_ms,
  checkpointAt: row.checkpoint_at,
});

export function createPlaySessionsRepo(db: WritableDb) {
  const insert = db.raw.prepare(
    "INSERT INTO play_sessions (game_id, started_at, checkpoint_at) VALUES (?, ?, ?)",
  );
  const byId = db.raw.prepare(`SELECT ${COLUMNS} FROM play_sessions WHERE id = ?`);
  const checkpoint = db.raw.prepare(
    "UPDATE play_sessions SET active_ms = ?, checkpoint_at = ? WHERE id = ?",
  );
  const end = db.raw.prepare(
    "UPDATE play_sessions SET active_ms = ?, checkpoint_at = ?, ended_at = ? WHERE id = ?",
  );
  const del = db.raw.prepare("DELETE FROM play_sessions WHERE id = ?");
  const listForGame = db.raw.prepare(PLAY_SESSIONS_SQL.listForGame);
  const total = db.raw.prepare(PLAY_SESSIONS_SQL.totalActiveMs);
  // Start-up only (sessions a crash left unfinished); the table has no index on ended_at and needs none for this.
  const unfinished = db.raw.prepare(
    `SELECT ${COLUMNS} FROM play_sessions WHERE ended_at IS NULL ORDER BY id`,
  );
  return {
    /** A session is one window lifetime: it starts when the game window opens. */
    start(gameId: string): PlaySession {
      const at = db.now();
      const { lastInsertRowid } = insert.run(gameId, at, at);
      const row = byId.get(lastInsertRowid) as PlaySessionRow | undefined;
      if (!row) throw new Error("playSessions.start: the inserted row cannot be read back.");
      return toSession(row);
    },
    checkpoint(id: number, activeMs: number): void {
      checkpoint.run(activeMs, db.now(), id);
    },
    end(id: number, activeMs: number): void {
      const at = db.now();
      end.run(activeMs, at, at, id);
    },
    delete(id: number): void {
      del.run(id);
    },
    listForGame: (gameId: string): PlaySession[] =>
      (listForGame.all(gameId) as unknown as PlaySessionRow[]).map(toSession),
    listUnfinished: (): PlaySession[] =>
      (unfinished.all() as unknown as PlaySessionRow[]).map(toSession),
    totalActiveMs: (gameId: string): number => (total.get(gameId) as { total: number }).total,
  };
}
