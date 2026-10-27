import type { WritableDb } from "../database.js";
import { fromBool, toBool } from "./sql.js";

export interface WindowState {
  gameId: string;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  displayId: string | null;
  maximized: boolean;
  fullscreen: boolean;
  updatedAt: number;
}

interface WindowStateRow {
  game_id: string;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  display_id: string | null;
  maximized: number;
  fullscreen: number;
  updated_at: number;
}

export function createWindowStateRepo(db: WritableDb) {
  const get = db.raw.prepare(
    "SELECT game_id, x, y, width, height, display_id, maximized, fullscreen, updated_at FROM window_state WHERE game_id = ?",
  );
  const save = db.raw.prepare(
    `INSERT INTO window_state (game_id, x, y, width, height, display_id, maximized, fullscreen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (game_id) DO UPDATE SET x = excluded.x, y = excluded.y, width = excluded.width,
       height = excluded.height, display_id = excluded.display_id, maximized = excluded.maximized,
       fullscreen = excluded.fullscreen, updated_at = excluded.updated_at`,
  );
  return {
    get(gameId: string): WindowState | null {
      const row = get.get(gameId) as WindowStateRow | undefined;
      return row
        ? {
            gameId: row.game_id,
            x: row.x,
            y: row.y,
            width: row.width,
            height: row.height,
            displayId: row.display_id,
            maximized: toBool(row.maximized),
            fullscreen: toBool(row.fullscreen),
            updatedAt: row.updated_at,
          }
        : null;
    },
    /** Inserts or overwrites the one row of the game. */
    save(state: Omit<WindowState, "updatedAt">): void {
      save.run(
        state.gameId,
        state.x,
        state.y,
        state.width,
        state.height,
        state.displayId,
        fromBool(state.maximized),
        fromBool(state.fullscreen),
        db.now(),
      );
    },
  };
}
