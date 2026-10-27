import type { WritableDb } from "../database.js";

/** A removed game whose saves are still on disk ("Data of removed games" in settings). */
export interface Orphan {
  gameId: string;
  url: string;
  title: string;
  removedAt: number;
}

interface OrphanRow {
  game_id: string;
  url: string;
  title: string;
  removed_at: number;
}

const toOrphan = (row: OrphanRow): Orphan => ({
  gameId: row.game_id,
  url: row.url,
  title: row.title,
  removedAt: row.removed_at,
});

/** The rows are written by `games.remove`; this repository reads them and deletes one when its data is deleted. */
export function createOrphansRepo(db: WritableDb) {
  const get = db.raw.prepare(
    "SELECT game_id, url, title, removed_at FROM orphans WHERE game_id = ?",
  );
  const list = db.raw.prepare(
    "SELECT game_id, url, title, removed_at FROM orphans ORDER BY removed_at, game_id",
  );
  const del = db.raw.prepare("DELETE FROM orphans WHERE game_id = ?");
  return {
    get(gameId: string): Orphan | null {
      const row = get.get(gameId) as OrphanRow | undefined;
      return row ? toOrphan(row) : null;
    },
    list: (): Orphan[] => (list.all() as unknown as OrphanRow[]).map(toOrphan),
    delete(gameId: string): void {
      del.run(gameId);
    },
  };
}
