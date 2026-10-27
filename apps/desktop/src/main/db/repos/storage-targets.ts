import type { WritableDb } from "../database.js";
import { fromBool, toBool } from "./sql.js";

/** One storage key of a game: the top-level origin and the frame origin that owns the data (partitioned storage). */
export interface StorageKey {
  gameId: string;
  topOrigin: string;
  frameOrigin: string;
}

export interface StorageTarget extends StorageKey {
  inExport: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface StorageTargetRow {
  game_id: string;
  top_origin: string;
  frame_origin: string;
  in_export: number;
  first_seen_at: number;
  last_seen_at: number;
}

export const STORAGE_TARGETS_SQL = {
  // The primary key (game_id, top_origin, frame_origin) serves the game_id prefix and the order.
  listForGame:
    "SELECT game_id, top_origin, frame_origin, in_export, first_seen_at, last_seen_at FROM storage_targets WHERE game_id = ? ORDER BY top_origin, frame_origin",
} as const;

/** Rows are kept when a game is removed, so the data can still be found and deleted (no foreign key). */
export function createStorageTargetsRepo(db: WritableDb) {
  const markSeen = db.raw.prepare(
    `INSERT INTO storage_targets (game_id, top_origin, frame_origin, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (game_id, top_origin, frame_origin) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  );
  const setInExport = db.raw.prepare(
    "UPDATE storage_targets SET in_export = ? WHERE game_id = ? AND top_origin = ? AND frame_origin = ?",
  );
  const list = db.raw.prepare(STORAGE_TARGETS_SQL.listForGame);
  return {
    /** Records that the key exists: new keys get `first_seen_at`, known ones only a newer `last_seen_at`. */
    markSeen(key: StorageKey): void {
      const at = db.now();
      markSeen.run(key.gameId, key.topOrigin, key.frameOrigin, at, at);
    },
    setInExport(key: StorageKey, inExport: boolean): void {
      setInExport.run(fromBool(inExport), key.gameId, key.topOrigin, key.frameOrigin);
    },
    listForGame: (gameId: string): StorageTarget[] =>
      (list.all(gameId) as unknown as StorageTargetRow[]).map((row) => ({
        gameId: row.game_id,
        topOrigin: row.top_origin,
        frameOrigin: row.frame_origin,
        inExport: toBool(row.in_export),
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      })),
  };
}
