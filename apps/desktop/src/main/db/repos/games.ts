import type { WritableDb } from "../database.js";
import type { Orphan } from "./orphans.js";
import { toBool, updateWhere } from "./sql.js";

export interface Game {
  id: string;
  url: string;
  title: string;
  coverPath: string | null;
  supportMode: "by-link";
  /** The revision the partition's data descends from (save-transfer.md). */
  baseRevisionId: string | null;
  needsRecovery: boolean;
  lastLaunchedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type NewGame = Pick<Game, "id" | "url" | "title"> & { coverPath?: string | null };
export type GamePatch = Partial<
  Pick<Game, "title" | "coverPath" | "baseRevisionId" | "needsRecovery" | "lastLaunchedAt">
>;

interface GameRow {
  id: string;
  url: string;
  title: string;
  cover_path: string | null;
  support_mode: "by-link";
  base_revision_id: string | null;
  needs_recovery: number;
  last_launched_at: number | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, url, title, cover_path, support_mode, base_revision_id, needs_recovery, last_launched_at, created_at, updated_at";

/** The statements, exported so the query-plan test can run `EXPLAIN QUERY PLAN` on exactly what the code runs. */
export const GAMES_SQL = {
  get: `SELECT ${COLUMNS} FROM games WHERE id = ?`,
  // ORDER BY the primary key: walks the key's index in creation order (UUIDv7 ids are time-ordered), no sort step.
  // Sorting by last played, title or playtime is done by the caller over this list.
  list: `SELECT ${COLUMNS} FROM games ORDER BY id`,
} as const;

function toGame(row: GameRow): Game {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    coverPath: row.cover_path,
    supportMode: row.support_mode,
    baseRevisionId: row.base_revision_id,
    needsRecovery: toBool(row.needs_recovery),
    lastLaunchedAt: row.last_launched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createGamesRepo(db: WritableDb) {
  const insertStmt = db.raw.prepare(
    "INSERT INTO games (id, url, title, cover_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const getStmt = db.raw.prepare(GAMES_SQL.get);
  const listStmt = db.raw.prepare(GAMES_SQL.list);
  const launchedStmt = db.raw.prepare("UPDATE games SET last_launched_at = ? WHERE id = ?");
  const get = (id: string): Game | null => {
    const row = getStmt.get(id) as GameRow | undefined;
    return row ? toGame(row) : null;
  };

  return {
    insert(game: NewGame): Game {
      const at = db.now();
      insertStmt.run(game.id, game.url, game.title, game.coverPath ?? null, at, at);
      const stored = get(game.id);
      if (!stored) throw new Error("games.insert: the inserted row cannot be read back.");
      return stored;
    },
    get,
    list: (): Game[] => (listStmt.all() as unknown as GameRow[]).map(toGame),
    /** Changes the given fields and `updated_at`; returns the game, or null if there is none. */
    update(id: string, patch: GamePatch): Game | null {
      updateWhere(
        db,
        "games",
        "id",
        id,
        patch,
        {
          title: "title",
          coverPath: "cover_path",
          baseRevisionId: "base_revision_id",
          needsRecovery: "needs_recovery",
          lastLaunchedAt: "last_launched_at",
        },
        { updated_at: db.now() },
      );
      return get(id);
    },
    /** Records a launch: `last_launched_at` becomes the database clock's now (a launch is not an edit). */
    markLaunched(id: string): void {
      launchedStmt.run(db.now(), id);
    },
    /**
     * "Remove from library" (architecture.md section 12), in one transaction: deletes the game row (the foreign
     * keys take its window state and play sessions with it) and its storage check (that table has no foreign key),
     * and adds an `orphans` row. Snapshots and storage targets are kept. Returns the orphan record, or null if
     * there is no such game.
     */
    remove(id: string): Orphan | null {
      return db.transaction(() => {
        const game = get(id);
        if (!game) return null;
        const removedAt = db.now();
        db.raw.prepare("DELETE FROM storage_checks WHERE game_id = ?").run(id);
        db.raw.prepare("DELETE FROM games WHERE id = ?").run(id);
        db.raw
          .prepare("INSERT INTO orphans (game_id, url, title, removed_at) VALUES (?, ?, ?, ?)")
          .run(id, game.url, game.title, removedAt);
        return { gameId: id, url: game.url, title: game.title, removedAt };
      });
    },
  };
}
