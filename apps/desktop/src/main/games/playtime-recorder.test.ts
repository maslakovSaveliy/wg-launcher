import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepos } from "../db/repos/index.js";
import { fakeClock, openTestDb, tempDir } from "../db/testing.js";
import { CHECKPOINT_MS, createPlaytimeHub, settleUnfinishedSessions } from "./playtime-recorder.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const OTHER = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c";

class FakeWindow extends EventEmitter {
  visible = false;
  focused = false;
  minimized = false;
  isVisible() {
    return this.visible;
  }
  isFocused() {
    return this.focused;
  }
  isMinimized() {
    return this.minimized;
  }
  /** Shown and focused, with the events Electron emits. */
  up() {
    this.visible = true;
    this.emit("show");
    this.focused = true;
    this.emit("focus");
  }
}

function setUp(options: { locked?: boolean } = {}) {
  const dir = tempDir();
  const wall = fakeClock();
  const db = openTestDb(dir, wall);
  const repos = createRepos(db);
  for (const id of [GAME, OTHER]) {
    repos.games.insert({ id, url: "https://example.com/", title: id.slice(-1) });
  }
  let mono = 5_000;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const hub = createPlaytimeHub({
    sessions: repos.playSessions,
    games: repos.games,
    clock: () => mono,
    log,
    isScreenLocked: () => options.locked ?? false,
  });
  const advance = (ms: number) => {
    mono += ms;
    wall.advance(ms);
    vi.advanceTimersByTime(ms);
  };
  const rows = (id = GAME) => repos.playSessions.listForGame(id);
  return { repos, hub, advance, rows, log, wall };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the playtime recorder (architecture.md section 10, PRD section 8)", () => {
  it("sets last_launched_at and starts one unfinished session at launch", () => {
    const { repos, hub, rows, wall } = setUp();
    hub.attach(GAME, new FakeWindow());
    expect(repos.games.get(GAME)?.lastLaunchedAt).toBe(wall.now());
    expect(rows()).toEqual([
      expect.objectContaining({ gameId: GAME, endedAt: null, activeMs: 0, startedAt: wall.now() }),
    ]);
  });

  it("accrues only while the window is shown and focused, and keeps a session of 10 s or more", () => {
    const { hub, advance, rows } = setUp();
    const window = new FakeWindow();
    hub.attach(GAME, window);
    advance(5_000); // hidden: nothing
    window.up();
    advance(8_000);
    window.focused = false;
    window.emit("blur");
    advance(30_000); // blurred: nothing
    window.emit("focus");
    advance(2_000);
    window.emit("minimize");
    advance(30_000); // minimized: nothing
    window.emit("closed");
    expect(rows()).toEqual([expect.objectContaining({ activeMs: 10_000 })]);
    expect(rows()[0]?.endedAt).not.toBeNull();
  });

  it("deletes a session with less than 10 000 ms of active time at close", () => {
    const { hub, advance, rows, log } = setUp();
    const window = new FakeWindow();
    hub.attach(GAME, window);
    window.up();
    advance(9_999);
    window.emit("closed");
    expect(rows()).toEqual([]);
    expect(log.info).toHaveBeenCalledWith("game.playtime", {
      gameId: GAME,
      activeMs: 9_999,
      kept: false,
    });
  });

  it("checkpoints the active time every 60 s, and stops checkpointing after the close", () => {
    const { hub, advance, rows, wall } = setUp();
    const window = new FakeWindow();
    hub.attach(GAME, window);
    window.up();
    expect(CHECKPOINT_MS).toBe(60_000);
    advance(59_999);
    expect(rows()[0]?.activeMs).toBe(0);
    advance(1);
    expect(rows()[0]).toMatchObject({ activeMs: 60_000, checkpointAt: wall.now() });
    advance(60_000);
    expect(rows()[0]?.activeMs).toBe(120_000);
    window.emit("closed");
    const ended = rows()[0];
    advance(CHECKPOINT_MS * 3);
    expect(rows()[0]).toEqual(ended);
  });

  it("replays the state of a window that is already shown and focused when attached", () => {
    const { hub, advance, rows } = setUp();
    const window = new FakeWindow();
    window.visible = true;
    window.focused = true;
    hub.attach(GAME, window);
    advance(12_000);
    window.emit("closed");
    expect(rows()[0]?.activeMs).toBe(12_000);
  });

  it("pauses at step 1 of the close procedure; a Stay that shows the window resumes", () => {
    const { hub, advance, rows } = setUp();
    const window = new FakeWindow();
    const recorder = hub.attach(GAME, window);
    window.up();
    advance(10_000);
    recorder.pause();
    advance(50_000); // the close procedure and its dialog: not counted
    window.emit("show"); // "Stay"
    advance(3_000);
    window.emit("closed");
    expect(rows()[0]?.activeMs).toBe(13_000);
  });

  it("stops every game on suspend and screen lock, and resumes on resume and unlock", () => {
    const { hub, advance, rows } = setUp();
    const a = new FakeWindow();
    const b = new FakeWindow();
    hub.attach(GAME, a);
    hub.attach(OTHER, b);
    a.up();
    b.up(); // both counted as focused by their own events; the rule is per window
    advance(10_000);
    hub.power("lock-screen");
    advance(20_000);
    hub.power("unlock-screen");
    advance(1_000);
    hub.power("suspend");
    advance(20_000);
    hub.power("resume");
    advance(1_000);
    a.emit("closed");
    b.emit("closed");
    expect(rows(GAME)[0]?.activeMs).toBe(12_000);
    expect(rows(OTHER)[0]?.activeMs).toBe(12_000);
  });

  it("starts a window opened while the screen is locked as locked", () => {
    const { hub, advance, rows } = setUp({ locked: true });
    const window = new FakeWindow();
    hub.attach(GAME, window);
    window.up();
    advance(20_000);
    hub.power("unlock-screen");
    advance(11_000);
    window.emit("closed");
    expect(rows()[0]?.activeMs).toBe(11_000);
  });

  it("logs a failed checkpoint and keeps counting", () => {
    const { repos, hub, advance, log } = setUp();
    const window = new FakeWindow();
    hub.attach(GAME, window);
    window.up();
    const checkpoint = vi.spyOn(repos.playSessions, "checkpoint").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => advance(CHECKPOINT_MS)).not.toThrow();
    expect(log.error).toHaveBeenCalledWith("game.playtime-write-failed", {
      gameId: GAME,
      error: expect.any(Error),
    });
    checkpoint.mockRestore();
    window.emit("closed");
    expect(repos.playSessions.listForGame(GAME)[0]?.activeMs).toBe(CHECKPOINT_MS);
  });
});

describe("settleUnfinishedSessions (start-up)", () => {
  it("deletes unfinished sessions under 10 000 ms and ends the others at their last checkpoint", () => {
    const { repos, wall } = setUp();
    const short = repos.playSessions.start(GAME);
    repos.playSessions.checkpoint(short.id, 9_999);
    wall.advance(1000);
    const long = repos.playSessions.start(GAME);
    repos.playSessions.checkpoint(long.id, 10_000);
    const checkpointAt = wall.now();
    wall.advance(1000);
    const done = repos.playSessions.start(OTHER);
    repos.playSessions.end(done.id, 4_000); // finished: left as it is
    wall.advance(60_000);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };

    settleUnfinishedSessions(repos.playSessions, log);

    expect(repos.playSessions.listForGame(GAME)).toEqual([
      expect.objectContaining({ id: long.id, activeMs: 10_000, endedAt: checkpointAt }),
    ]);
    expect(repos.playSessions.listForGame(OTHER)).toEqual([
      expect.objectContaining({ id: done.id, activeMs: 4_000 }),
    ]);
    expect(repos.playSessions.listUnfinished()).toEqual([]);
    expect(log.info).toHaveBeenCalledWith("playtime.settled", { deleted: 1, ended: 1 });
  });
});
