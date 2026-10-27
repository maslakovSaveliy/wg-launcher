import { join } from "node:path";
import { isUuidV7 } from "@wg-launcher/shared";
import { describe, expect, it } from "vitest";
import type { WritableDb } from "../database.js";
import { dbOptions, fakeClock, openDb, openTestDb, tempDir } from "../testing.js";
import { createRepos, type Repos } from "./index.js";
import type { NewSnapshot } from "./snapshots.js";

function setUp() {
  const dir = tempDir();
  const clock = fakeClock();
  const db = openTestDb(dir, clock);
  return { db, clock, repos: createRepos(db), dir };
}

let counter = 0;
const gameId = (n: number) => `0000000${n}-0000-7000-8000-000000000000`;
function newGame(n: number) {
  return { id: gameId(n), url: `https://example.com/game-${n}/`, title: `Game ${n}` };
}

function snapshot(revisionId: string, game: string, extra: Partial<NewSnapshot> = {}): NewSnapshot {
  counter += 1;
  return {
    revisionId,
    gameId: game,
    kind: "export",
    manifestGameId: game,
    parentRevisionId: null,
    createdAt: "2026-10-28T12:00:00.000Z",
    deviceId: "device-1",
    exporterId: "generic-web-storage",
    exporterVersion: "1.0.0",
    adapterId: null,
    adapterVersion: null,
    contentHash: `sha256:${counter}`,
    sizeBytes: 100 + counter,
    path: `snapshots/${game}/${revisionId}.wgsnap`,
    flushState: "unconfirmed",
    ...extra,
  };
}

/** Seeds one game with a row in every table that refers to it. */
function seedFullGame(db: WritableDb, repos: Repos, n: number) {
  repos.games.insert(newGame(n));
  repos.windowState.save({
    gameId: gameId(n),
    x: 10,
    y: 20,
    width: 1280,
    height: 800,
    displayId: "1",
    maximized: false,
    fullscreen: false,
  });
  repos.playSessions.start(gameId(n));
  repos.storageChecks.save(gameId(n), true);
  repos.storageTargets.markSeen({
    gameId: gameId(n),
    topOrigin: "https://example.com",
    frameOrigin: "https://example.com",
  });
  repos.snapshots.addIfAbsent(snapshot(`rev-${n}`, gameId(n)));
  return db;
}

describe("device", () => {
  it("is created once, as a UUIDv7, on the first open and kept on later opens", () => {
    const dir = tempDir();
    const options = dbOptions(dir, fakeClock());
    const first = openDb(join(dir, "library.db"), options);
    if (first.readOnly) throw new Error(first.reason);
    const device = createRepos(first).device.get();
    first.close();
    expect(device).not.toBeNull();
    expect(isUuidV7(device?.id ?? "")).toBe(true);

    const second = openDb(join(dir, "library.db"), options);
    if (second.readOnly) throw new Error(second.reason);
    expect(createRepos(second).device.get()).toEqual(device);
    expect(second.raw.prepare("SELECT count(*) AS n FROM device").get()).toMatchObject({ n: 1 });
    second.close();
  });
});

describe("games", () => {
  it("inserts with defaults and timestamps from the injected clock", () => {
    const { repos, clock } = setUp();
    const game = repos.games.insert(newGame(1));
    expect(game).toEqual({
      ...newGame(1),
      coverPath: null,
      supportMode: "by-link",
      baseRevisionId: null,
      needsRecovery: false,
      lastLaunchedAt: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    expect(repos.games.get(gameId(1))).toEqual(game);
    expect(repos.games.get(gameId(9))).toBeNull();
  });

  it("updates only the given fields and moves updated_at", () => {
    const { repos, clock } = setUp();
    repos.games.insert(newGame(1));
    const created = clock.now();
    clock.advance(5000);
    const updated = repos.games.update(gameId(1), {
      title: "Renamed",
      needsRecovery: true,
      lastLaunchedAt: clock.now(),
    });
    expect(updated).toMatchObject({
      title: "Renamed",
      url: newGame(1).url,
      needsRecovery: true,
      lastLaunchedAt: clock.now(),
      createdAt: created,
      updatedAt: clock.now(),
    });
    expect(repos.games.update(gameId(9), { title: "x" })).toBeNull();
  });

  it("lists in creation order (the id is a time-ordered UUIDv7)", () => {
    const { repos } = setUp();
    for (const n of [3, 1, 2]) repos.games.insert(newGame(n));
    expect(repos.games.list().map((g) => g.id)).toEqual([gameId(1), gameId(2), gameId(3)]);
  });

  it("allows the same URL twice as two entries", () => {
    const { repos } = setUp();
    repos.games.insert(newGame(1));
    repos.games.insert({ ...newGame(2), url: newGame(1).url });
    expect(repos.games.list()).toHaveLength(2);
  });

  it("removing a game deletes its window state, play sessions and storage check, keeps snapshots and storage targets, and records an orphan", () => {
    const { db, repos, clock } = setUp();
    seedFullGame(db, repos, 1);
    seedFullGame(db, repos, 2);
    clock.advance(1000);

    const orphan = repos.games.remove(gameId(1));
    expect(orphan).toEqual({
      gameId: gameId(1),
      url: newGame(1).url,
      title: "Game 1",
      removedAt: clock.now(),
    });

    const count = (table: string, game: string) =>
      (
        db.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE game_id = ?`).get(game) as {
          n: number;
        }
      ).n;
    for (const table of ["games", "window_state", "play_sessions", "storage_checks"]) {
      const column = table === "games" ? "id" : "game_id";
      const n = (
        db.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(gameId(1)) as {
          n: number;
        }
      ).n;
      expect(n, table).toBe(0);
    }
    // Kept: snapshots and storage targets of the removed game.
    expect(count("snapshots", gameId(1))).toBe(1);
    expect(count("storage_targets", gameId(1))).toBe(1);
    expect(repos.orphans.list()).toEqual([orphan]);
    // The other game is untouched.
    for (const table of [
      "window_state",
      "play_sessions",
      "storage_checks",
      "snapshots",
      "storage_targets",
    ]) {
      expect(count(table, gameId(2)), table).toBe(1);
    }
    expect(repos.games.get(gameId(2))).not.toBeNull();
  });

  it("removing an unknown game does nothing", () => {
    const { repos } = setUp();
    expect(repos.games.remove(gameId(9))).toBeNull();
    expect(repos.orphans.list()).toEqual([]);
  });

  it("removing a game is all or nothing", () => {
    const { db, repos } = setUp();
    seedFullGame(db, repos, 1);
    // Make the orphan insert fail at the end of the transaction: the earlier deletes must roll back.
    db.raw.exec(
      "INSERT INTO orphans (game_id, url, title, removed_at) VALUES ('" +
        gameId(1) +
        "', 'u', 't', 1)",
    );
    expect(() => repos.games.remove(gameId(1))).toThrow();
    expect(repos.games.get(gameId(1))).not.toBeNull();
    expect(repos.storageChecks.get(gameId(1))).not.toBeNull();
  });
});

describe("window state", () => {
  it("saves and overwrites one row per game", () => {
    const { repos, clock } = setUp();
    repos.games.insert(newGame(1));
    expect(repos.windowState.get(gameId(1))).toBeNull();
    const state = {
      gameId: gameId(1),
      x: null,
      y: null,
      width: 1280,
      height: 800,
      displayId: null,
      maximized: true,
      fullscreen: false,
    };
    repos.windowState.save(state);
    expect(repos.windowState.get(gameId(1))).toEqual({ ...state, updatedAt: clock.now() });
    clock.advance(10);
    repos.windowState.save({ ...state, x: 5, y: 6, maximized: false, fullscreen: true });
    expect(repos.windowState.get(gameId(1))).toEqual({
      ...state,
      x: 5,
      y: 6,
      maximized: false,
      fullscreen: true,
      updatedAt: clock.now(),
    });
  });

  it("refuses a state for a game that does not exist", () => {
    const { repos } = setUp();
    expect(() =>
      repos.windowState.save({
        gameId: gameId(9),
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        displayId: null,
        maximized: false,
        fullscreen: false,
      }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("play sessions", () => {
  it("starts, checkpoints and ends a session; sums active time per game", () => {
    const { repos, clock } = setUp();
    repos.games.insert(newGame(1));
    repos.games.insert(newGame(2));
    const a = repos.playSessions.start(gameId(1));
    expect(a).toMatchObject({
      gameId: gameId(1),
      startedAt: clock.now(),
      endedAt: null,
      activeMs: 0,
      checkpointAt: clock.now(),
    });
    expect(repos.playSessions.listUnfinished().map((s) => s.id)).toEqual([a.id]);

    clock.advance(60_000);
    repos.playSessions.checkpoint(a.id, 55_000);
    expect(repos.playSessions.listForGame(gameId(1))[0]).toMatchObject({
      activeMs: 55_000,
      checkpointAt: clock.now(),
      endedAt: null,
    });
    clock.advance(1000);
    repos.playSessions.end(a.id, 56_000);
    const b = repos.playSessions.start(gameId(1));
    repos.playSessions.end(b.id, 4000);
    repos.playSessions.end(repos.playSessions.start(gameId(2)).id, 999);

    expect(repos.playSessions.listUnfinished()).toEqual([]);
    expect(repos.playSessions.listForGame(gameId(1)).map((s) => s.id)).toEqual([a.id, b.id]);
    expect(repos.playSessions.totalActiveMs(gameId(1))).toBe(60_000);
    expect(repos.playSessions.totalActiveMs(gameId(3))).toBe(0);
  });

  it("deletes a session", () => {
    const { repos } = setUp();
    repos.games.insert(newGame(1));
    const s = repos.playSessions.start(gameId(1));
    repos.playSessions.delete(s.id);
    expect(repos.playSessions.listForGame(gameId(1))).toEqual([]);
  });
});

describe("storage targets", () => {
  it("records a key once, keeps first_seen_at, and tracks in_export", () => {
    const { repos, clock } = setUp();
    const key = {
      gameId: gameId(1),
      topOrigin: "https://example.com",
      frameOrigin: "https://cdn.example.com",
    };
    repos.storageTargets.markSeen(key);
    const first = clock.now();
    clock.advance(100);
    repos.storageTargets.markSeen(key);
    repos.storageTargets.markSeen({ ...key, frameOrigin: key.topOrigin });
    expect(repos.storageTargets.listForGame(gameId(1))).toEqual(
      [
        { ...key, inExport: false, firstSeenAt: first, lastSeenAt: clock.now() },
        {
          ...key,
          frameOrigin: key.topOrigin,
          inExport: false,
          firstSeenAt: clock.now(),
          lastSeenAt: clock.now(),
        },
      ].sort((a, b) => a.frameOrigin.localeCompare(b.frameOrigin)),
    );

    repos.storageTargets.setInExport(key, true);
    expect(
      repos.storageTargets.listForGame(gameId(1)).find((t) => t.frameOrigin === key.frameOrigin)
        ?.inExport,
    ).toBe(true);
    expect(repos.storageTargets.listForGame(gameId(2))).toEqual([]);
  });
});

describe("snapshots", () => {
  it("adds a row with added_at from the clock and finds it by revision", () => {
    const { repos, clock } = setUp();
    const result = repos.snapshots.addIfAbsent(snapshot("rev-a", gameId(1)));
    expect(result.added).toBe(true);
    expect(result.snapshot).toMatchObject({
      revisionId: "rev-a",
      gameId: gameId(1),
      kind: "export",
      flushState: "unconfirmed",
      verifiedAt: null,
      verifiedExporterVersion: null,
      addedAt: clock.now(),
    });
    expect(repos.snapshots.findByRevision("rev-a")).toEqual(result.snapshot);
    expect(repos.snapshots.findByRevision("nope")).toBeNull();
  });

  it("M8: restoring a stored revision into another game adds no row; the row keeps its first game", () => {
    const { db, repos } = setUp();
    repos.snapshots.addIfAbsent(snapshot("rev-a", gameId(1)));
    const again = repos.snapshots.addIfAbsent(snapshot("rev-a", gameId(2), { kind: "imported" }));
    expect(again.added).toBe(false);
    expect(again.snapshot.gameId).toBe(gameId(1));
    expect(again.snapshot.kind).toBe("export");
    expect(db.raw.prepare("SELECT count(*) AS n FROM snapshots").get()).toMatchObject({ n: 1 });
  });

  it("M8: listForGame returns the game's rows plus the row of its base revision, by added_at, without duplicates", () => {
    const { repos, clock } = setUp();
    repos.snapshots.addIfAbsent(snapshot("a1", gameId(1))); // first game's revision, added first
    clock.advance(10);
    repos.snapshots.addIfAbsent(snapshot("b1", gameId(2)));
    clock.advance(10);
    repos.snapshots.addIfAbsent(snapshot("b2", gameId(2)));
    clock.advance(10);
    repos.snapshots.addIfAbsent(snapshot("c1", gameId(3)));

    const ids = (game: string, base: string | null) =>
      repos.snapshots.listForGame(game, base).map((s) => s.revisionId);

    // Game 2 descends from a1 (stored under game 1): a1 comes first because it was added first.
    expect(ids(gameId(2), "a1")).toEqual(["a1", "b1", "b2"]);
    // A base revision that already belongs to the game is not listed twice.
    expect(ids(gameId(2), "b1")).toEqual(["b1", "b2"]);
    // No base revision, or one that is not stored: only the game's own rows.
    expect(ids(gameId(2), null)).toEqual(["b1", "b2"]);
    expect(ids(gameId(2), "missing")).toEqual(["b1", "b2"]);
    // Other games' rows never leak in.
    expect(ids(gameId(4), null)).toEqual([]);
    expect(ids(gameId(1), null)).toEqual(["a1"]);
  });

  it("marks a snapshot verified with the exporter version", () => {
    const { repos, clock } = setUp();
    repos.snapshots.addIfAbsent(snapshot("rev-a", gameId(1)));
    clock.advance(500);
    repos.snapshots.markVerified("rev-a", "1.0.0");
    expect(repos.snapshots.findByRevision("rev-a")).toMatchObject({
      verifiedAt: clock.now(),
      verifiedExporterVersion: "1.0.0",
    });
  });

  it("rejects an unknown kind or flush state", () => {
    const { repos } = setUp();
    expect(() =>
      repos.snapshots.addIfAbsent(snapshot("x", gameId(1), { kind: "other" as never })),
    ).toThrow(/CHECK/i);
    expect(() =>
      repos.snapshots.addIfAbsent(snapshot("y", gameId(1), { flushState: "maybe" as never })),
    ).toThrow(/CHECK/i);
  });
});

describe("restore journal", () => {
  it("records steps and lists unfinished entries", () => {
    const { repos, clock } = setUp();
    repos.restoreJournal.begin({
      id: "j1",
      gameId: gameId(1),
      kind: "import",
      revisionId: "rev-a",
      step: "backup",
    });
    repos.restoreJournal.begin({
      id: "j2",
      gameId: gameId(1),
      kind: "delete-saves",
      step: "backup",
    });
    expect(repos.restoreJournal.get("j1")).toEqual({
      id: "j1",
      gameId: gameId(1),
      kind: "import",
      revisionId: "rev-a",
      backupRevisionId: null,
      step: "backup",
      state: "running",
      startedAt: clock.now(),
      updatedAt: clock.now(),
    });
    clock.advance(20);
    repos.restoreJournal.update("j1", { step: "wipe", backupRevisionId: "rev-b" });
    repos.restoreJournal.update("j2", { state: "done" });
    expect(repos.restoreJournal.get("j1")).toMatchObject({
      step: "wipe",
      backupRevisionId: "rev-b",
      state: "running",
      updatedAt: clock.now(),
    });
    expect(repos.restoreJournal.listUnfinished().map((e) => e.id)).toEqual(["j1"]);
    repos.restoreJournal.update("j1", { state: "rolling-back" });
    expect(repos.restoreJournal.listUnfinished().map((e) => e.id)).toEqual(["j1"]);
    repos.restoreJournal.update("j1", { state: "failed" });
    expect(repos.restoreJournal.listUnfinished()).toEqual([]);
  });

  it("rejects an unknown kind or state", () => {
    const { repos } = setUp();
    expect(() =>
      repos.restoreJournal.begin({ id: "j", gameId: gameId(1), kind: "wipe" as never, step: "s" }),
    ).toThrow(/CHECK/i);
    repos.restoreJournal.begin({ id: "j", gameId: gameId(1), kind: "import", step: "s" });
    expect(() => repos.restoreJournal.update("j", { state: "paused" as never })).toThrow(/CHECK/i);
  });
});

describe("storage checks, orphans and settings", () => {
  it("keeps the latest storage check per game", () => {
    const { repos, clock } = setUp();
    expect(repos.storageChecks.get(gameId(1))).toBeNull();
    repos.storageChecks.save(gameId(1), true);
    clock.advance(5);
    repos.storageChecks.save(gameId(1), false);
    expect(repos.storageChecks.get(gameId(1))).toEqual({
      gameId: gameId(1),
      checkedAt: clock.now(),
      hasData: false,
    });
  });

  it("deletes an orphan record", () => {
    const { db, repos } = setUp();
    seedFullGame(db, repos, 1);
    repos.games.remove(gameId(1));
    expect(repos.orphans.get(gameId(1))).not.toBeNull();
    repos.orphans.delete(gameId(1));
    expect(repos.orphans.get(gameId(1))).toBeNull();
  });

  it("stores settings as JSON values", () => {
    const { repos } = setUp();
    expect(repos.settings.get("theme")).toBeUndefined();
    repos.settings.set("theme", "dark");
    repos.settings.set("window", { width: 1280, pinned: [1, 2] });
    repos.settings.set("theme", "light");
    expect(repos.settings.get("theme")).toBe("light");
    expect(repos.settings.get("window")).toEqual({ width: 1280, pinned: [1, 2] });
    expect(repos.settings.all()).toEqual({
      theme: "light",
      window: { width: 1280, pinned: [1, 2] },
    });
  });
});
