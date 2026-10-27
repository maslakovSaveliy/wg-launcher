// Ruling R18: the "below 5 ms per statement" budget (architecture.md section 13) is checked by the query plan, not
// by a wall-clock number. Each statement on a hot path must be served by an index or the primary key, with no full
// table scan and no sort step, over a library of 1 000 games.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type WritableDb } from "../database.js";
import { fakeClock, tempDir } from "../testing.js";
import { GAMES_SQL } from "./games.js";
import { createRepos } from "./index.js";
import { PLAY_SESSIONS_SQL } from "./play-sessions.js";
import { SNAPSHOTS_SQL } from "./snapshots.js";
import { STORAGE_TARGETS_SQL } from "./storage-targets.js";

function plan(db: WritableDb, sql: string, ...params: string[]): string[] {
  return (
    db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as unknown as Array<{
      detail: string;
    }>
  ).map((row) => row.detail);
}

function library(): WritableDb {
  const dir = tempDir();
  const clock = fakeClock();
  const db = openDatabase(join(dir, "library.db"), {
    now: clock.now,
    backupDir: join(dir, "backups"),
  });
  if (db.readOnly) throw new Error(db.reason);
  const repos = createRepos(db);
  db.transaction(() => {
    for (let n = 0; n < 1000; n += 1) {
      const id = `game-${String(n).padStart(4, "0")}`;
      repos.games.insert({ id, url: `https://example.com/${n}/`, title: `Game ${n}` });
      repos.playSessions.end(repos.playSessions.start(id).id, 1000);
      repos.storageTargets.markSeen({
        gameId: id,
        topOrigin: "https://example.com",
        frameOrigin: "https://example.com",
      });
      repos.snapshots.addIfAbsent({
        revisionId: `rev-${n}`,
        gameId: id,
        kind: "export",
        manifestGameId: id,
        parentRevisionId: null,
        createdAt: "2026-10-28T12:00:00.000Z",
        deviceId: "d",
        exporterId: "e",
        exporterVersion: "1",
        contentHash: `h${n}`,
        sizeBytes: 1,
        path: `p${n}`,
        flushState: "unconfirmed",
      });
    }
  });
  return db;
}

/** True for a plan line that reads a whole table or builds a sort. */
const isUnindexed = (detail: string) =>
  (/^SCAN /.test(detail) && !/USING (COVERING )?INDEX|USING PRIMARY KEY/.test(detail)) ||
  /USE TEMP B-TREE/.test(detail);

describe("hot-path statements use an index", () => {
  const db = library();
  const cases: Array<[string, string, string[], RegExp]> = [
    // Listing every game reads every row; it walks the primary-key index in order, so there is no sort.
    ["games.list", GAMES_SQL.list, [], /^SCAN games USING INDEX sqlite_autoindex_games_1/],
    [
      "games.get",
      GAMES_SQL.get,
      ["game-0001"],
      /^SEARCH games USING INDEX sqlite_autoindex_games_1 \(id=\?\)/,
    ],
    [
      "playSessions.listForGame",
      PLAY_SESSIONS_SQL.listForGame,
      ["game-0001"],
      /^SEARCH play_sessions USING INDEX play_sessions_by_game \(game_id=\?\)/,
    ],
    [
      "playSessions.totalActiveMs",
      PLAY_SESSIONS_SQL.totalActiveMs,
      ["game-0001"],
      /^SEARCH play_sessions USING INDEX play_sessions_by_game \(game_id=\?\)/,
    ],
    [
      "storageTargets.listForGame",
      STORAGE_TARGETS_SQL.listForGame,
      ["game-0001"],
      /^SEARCH storage_targets USING (COVERING )?INDEX sqlite_autoindex_storage_targets_1 \(game_id=\?\)/,
    ],
    [
      "snapshots.listForGame (the game's rows)",
      SNAPSHOTS_SQL.listOwn,
      ["game-0001"],
      /^SEARCH snapshots USING INDEX snapshots_by_game \(game_id=\?\)/,
    ],
    [
      "snapshots.findByRevision",
      SNAPSHOTS_SQL.findByRevision,
      ["rev-1"],
      /^SEARCH snapshots USING INDEX sqlite_autoindex_snapshots_1 \(revision_id=\?\)/,
    ],
  ];
  it.each(cases)("%s", (_name, sql, params, expected) => {
    const details = plan(db, sql, ...params);
    expect(details.filter(isUnindexed), details.join(" | ")).toEqual([]);
    expect(
      details.some((detail) => expected.test(detail)),
      details.join(" | "),
    ).toBe(true);
  });
});
