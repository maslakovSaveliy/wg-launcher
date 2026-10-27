import type { WritableDb } from "../database.js";
import { fromBool, toBool } from "./sql.js";

/** The latest storage check of a game; it drives the "Local data" badge (architecture.md section 11). */
export interface StorageCheck {
  gameId: string;
  checkedAt: number;
  hasData: boolean;
}

export function createStorageChecksRepo(db: WritableDb) {
  const get = db.raw.prepare(
    "SELECT game_id, checked_at, has_data FROM storage_checks WHERE game_id = ?",
  );
  const save = db.raw.prepare(
    `INSERT INTO storage_checks (game_id, checked_at, has_data) VALUES (?, ?, ?)
     ON CONFLICT (game_id) DO UPDATE SET checked_at = excluded.checked_at, has_data = excluded.has_data`,
  );
  return {
    get(gameId: string): StorageCheck | null {
      const row = get.get(gameId) as
        | { game_id: string; checked_at: number; has_data: number }
        | undefined;
      return row
        ? { gameId: row.game_id, checkedAt: row.checked_at, hasData: toBool(row.has_data) }
        : null;
    },
    save(gameId: string, hasData: boolean): void {
      save.run(gameId, db.now(), fromBool(hasData));
    },
  };
}
