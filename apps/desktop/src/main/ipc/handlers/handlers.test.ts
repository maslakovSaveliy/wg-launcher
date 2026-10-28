import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IPC_CONTRACT, type IpcChannel, type IpcResult, uuidv7 } from "@wg-launcher/shared";
import { describe, expect, it, vi } from "vitest";
import { createCovers } from "../../covers.js";
import { createRepos } from "../../db/repos/index.js";
import { dbOptions, fakeClock, openDb, openTestDb, tempDir } from "../../db/testing.js";
import type { ConfirmSpec, OpenFileSpec } from "../../dialogs.js";
import type { Flavor } from "../../flavor.js";
import { LockManager } from "../../games/locks.js";
import { createHandlers } from "./index.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

function setUp(
  options: { flavor?: Flavor; confirm?: boolean[]; files?: Array<string | null> } = {},
) {
  const dir = tempDir();
  const clock = fakeClock();
  const db = openTestDb(dir, clock);
  const repos = createRepos(db);
  const coversDir = join(dir, "covers");
  const tmpDir = join(dir, "tmp");
  mkdirSync(coversDir);
  mkdirSync(tmpDir, { recursive: true });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const locks = new LockManager({ log });
  const answers = [...(options.confirm ?? [])];
  const files = [...(options.files ?? [])];
  const dialogs = {
    confirm: vi.fn(async (_spec: ConfirmSpec) => answers.shift() ?? false),
    openFile: vi.fn(async (_spec: OpenFileSpec): Promise<string | null> => files.shift() ?? null),
  };
  const runtime = {
    state: vi.fn(() => "idle" as const),
    launch: vi.fn(async () => ({ ok: true as const, data: { window: "opened" as const } })),
    focus: vi.fn(() => false),
  };
  const handlers = createHandlers({
    library: { repos, runtime, locks },
    dialogs,
    covers: createCovers({ coversDir, tmpDir }),
    flavor: options.flavor ?? "test",
    log,
    newId: () => uuidv7(clock.now),
  });
  const file = (name: string, bytes: Uint8Array) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
  return { dir, db, repos, locks, dialogs, runtime, handlers, coversDir, clock, file, log };
}

/** Checks the result against the channel's response schema and returns its data. */
function dataOf<C extends IpcChannel>(channel: C, result: IpcResult<C>) {
  if (!result.ok) throw new Error(`${channel}: ${result.code} ${result.message}`);
  return IPC_CONTRACT[channel].response.parse(result.data) as typeof result.data;
}

describe("library:add (architecture.md section 12, AC-17)", () => {
  it("stores url.href, defaults the title to the host name and returns the card with honest badges", async () => {
    const { handlers } = setUp();
    const card = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://Example.com" }),
    );
    expect(card).toMatchObject({
      url: "https://example.com/",
      title: "example.com",
      coverUrl: null,
      lastLaunchedAt: null,
      playtimeMs: 0,
      state: "idle",
      needsRecovery: false,
    });
    expect(card.badges).toEqual([
      { id: "by-link" },
      { id: "needs-internet" },
      { id: "compat-not-verified" },
    ]);
    const list = dataOf("library:list", await handlers["library:list"]({}));
    expect(list).toEqual({ library: "ready", cards: [card] });
  });

  it.each([
    "ftp://example.com/",
    "http://example.com/",
    " https://example.com/",
    "javascript:alert(1)",
    // secretlint-disable-next-line
    "https://user:pass@example.com/",
  ])("refuses %j with URL_NOT_ALLOWED and adds nothing", async (url) => {
    const { handlers, repos } = setUp();
    expect(await handlers["library:add"]({ url })).toMatchObject({
      ok: false,
      code: "URL_NOT_ALLOWED",
    });
    expect(repos.games.list()).toEqual([]);
  });

  it("accepts development origins only in the dev and test flavors", async () => {
    const test = setUp({ flavor: "test" });
    expect((await test.handlers["library:add"]({ url: "http://127.0.0.1:4317/" })).ok).toBe(true);
    const prod = setUp({ flavor: "prod" });
    expect(await prod.handlers["library:add"]({ url: "http://127.0.0.1:4317/" })).toEqual({
      ok: false,
      code: "URL_NOT_ALLOWED",
      message: "Only https:// addresses can be added.",
    });
  });

  it("the same URL twice asks first; Cancel adds nothing, confirming adds a second entry with its own id", async () => {
    const { handlers, dialogs, repos } = setUp({ confirm: [false, true] });
    const first = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://a.example/", title: "Lab" }),
    );
    expect(dialogs.confirm).not.toHaveBeenCalled();

    expect(await handlers["library:add"]({ url: "https://a.example/" })).toMatchObject({
      ok: false,
      code: "CANCELLED",
    });
    expect(dialogs.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Already in the library",
        confirmLabel: "Add a second entry",
      }),
    );
    expect(repos.games.list()).toHaveLength(1);

    const second = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://a.example/" }),
    );
    expect(second.gameId).not.toBe(first.gameId);
    expect(
      repos.games
        .list()
        .map((g) => g.id)
        .sort(),
    ).toEqual([first.gameId, second.gameId].sort());
  });

  it("refuses everything while the database is read-only, but lists the reason", async () => {
    const dir = tempDir();
    const raw = new DatabaseSync(join(dir, "library.db"));
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    const db = openDb(join(dir, "library.db"), dbOptions(dir));
    expect(db.readOnly).toBe(true);
    const handlers = createHandlers({
      library: null,
      readOnlyReason: db.readOnly ? db.reason : "",
      dialogs: { confirm: vi.fn(), openFile: vi.fn() },
      covers: createCovers({ coversDir: dir, tmpDir: dir }),
      flavor: "test",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() },
      newId: uuidv7,
    });
    const list = dataOf("library:list", await handlers["library:list"]({}));
    expect(list).toEqual({ library: "read-only", reason: expect.stringContaining("newer") });
    const gameId = uuidv7();
    const writes = await Promise.all([
      handlers["library:add"]({ url: "https://a.example/" }),
      handlers["library:update"]({ gameId, title: "T" }),
      handlers["library:remove"]({ gameId }),
      handlers["library:orphans"]({}),
      handlers["game:launch"]({ gameId }),
      handlers["game:focus"]({ gameId }),
      handlers["settings:set"]({}),
    ]);
    for (const result of writes)
      expect(result).toMatchObject({ ok: false, code: "LIBRARY_READ_ONLY" });
  });
});

describe("library:update (AC-17)", () => {
  it("changes the title and keeps gameId and url", async () => {
    const { handlers } = setUp();
    const card = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://a.example/" }),
    );
    const edited = dataOf(
      "library:update",
      await handlers["library:update"]({
        gameId: card.gameId,
        title: "<img src=x onerror=alert(1)>",
      }),
    );
    expect(edited).toMatchObject({
      gameId: card.gameId,
      url: card.url,
      title: "<img src=x onerror=alert(1)>",
    });
  });

  it("picks a cover in the dialog, replaces it (old file removed) and removes it", async () => {
    const { handlers, file, coversDir, dialogs } = setUp();
    const { gameId } = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://a.example/" }),
    );
    dialogs.openFile
      .mockResolvedValueOnce(file("one.png", PNG))
      .mockResolvedValueOnce(file("two.jpg", JPEG));

    const first = dataOf(
      "library:update",
      await handlers["library:update"]({ gameId, cover: "pick" }),
    );
    const [firstName] = readdirSync(coversDir);
    expect(first.coverUrl).toBe(`app://launcher/covers/${firstName}`);
    expect(firstName).toMatch(new RegExp(`^${gameId}-[0-9a-f]{16}\\.png$`));

    const second = dataOf(
      "library:update",
      await handlers["library:update"]({ gameId, cover: "pick" }),
    );
    const [secondName] = readdirSync(coversDir);
    expect(readdirSync(coversDir)).toHaveLength(1);
    expect(secondName).toMatch(/\.jpg$/);
    expect(second.coverUrl).toBe(`app://launcher/covers/${secondName}`);

    const removed = dataOf(
      "library:update",
      await handlers["library:update"]({ gameId, cover: "remove" }),
    );
    expect(removed.coverUrl).toBeNull();
    expect(readdirSync(coversDir)).toEqual([]);
  });

  it("a cancelled pick and a file that is not an image change nothing", async () => {
    const { handlers, file, coversDir, dialogs } = setUp();
    const { gameId } = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://a.example/" }),
    );
    dialogs.openFile.mockResolvedValueOnce(file("one.png", PNG));
    const withCover = dataOf(
      "library:update",
      await handlers["library:update"]({ gameId, cover: "pick" }),
    );

    dialogs.openFile.mockResolvedValueOnce(null);
    expect(await handlers["library:update"]({ gameId, cover: "pick", title: "New" })).toMatchObject(
      {
        ok: false,
        code: "CANCELLED",
      },
    );
    dialogs.openFile.mockResolvedValueOnce(file("fake.png", new TextEncoder().encode("text")));
    expect(await handlers["library:update"]({ gameId, cover: "pick" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
    const card = dataOf("library:list", await handlers["library:list"]({}));
    expect(card.library === "ready" && card.cards[0]).toMatchObject({
      title: "a.example",
      coverUrl: withCover.coverUrl,
    });
    expect(readdirSync(coversDir)).toHaveLength(1);
  });

  it("an unknown game is NOT_FOUND", async () => {
    const { handlers } = setUp();
    expect(await handlers["library:update"]({ gameId: uuidv7(), title: "T" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });
});

describe("library:remove and library:orphans (architecture.md section 12)", () => {
  it("confirms in a native dialog that says what is kept, then keeps snapshots and lists the orphan", async () => {
    const { handlers, repos, dialogs, file, coversDir } = setUp({ confirm: [false, true] });
    const { gameId } = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://a.example/", title: "Lab" }),
    );
    dialogs.openFile.mockResolvedValueOnce(file("c.png", PNG));
    await handlers["library:update"]({ gameId, cover: "pick" });
    repos.snapshots.addIfAbsent({
      revisionId: uuidv7(),
      gameId,
      kind: "export",
      manifestGameId: gameId,
      parentRevisionId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deviceId: repos.device.ensure().id,
      exporterId: "generic-web-storage",
      exporterVersion: "1.0.0",
      contentHash: "0".repeat(64),
      sizeBytes: 1,
      path: "snapshots/x.wgsnap",
      flushState: "unconfirmed",
    });

    expect(await handlers["library:remove"]({ gameId })).toMatchObject({
      ok: false,
      code: "CANCELLED",
    });
    expect(repos.games.get(gameId)).not.toBeNull();
    const spec = dialogs.confirm.mock.calls[0]?.[0];
    expect(spec?.confirmLabel).toBe("Remove from library");
    expect(spec?.detail).toMatch(/snapshots/i);
    expect(spec?.detail).toMatch(/backups/i);
    expect(spec?.detail).toContain("Data of removed games");

    expect(dataOf("library:remove", await handlers["library:remove"]({ gameId }))).toEqual({});
    expect(repos.games.get(gameId)).toBeNull();
    expect(repos.snapshots.listForGame(gameId, null)).toHaveLength(1);
    expect(readdirSync(coversDir)).toEqual([]);
    expect(dataOf("library:orphans", await handlers["library:orphans"]({}))).toEqual({
      orphans: [{ gameId, title: "Lab", url: "https://a.example/", removedAt: expect.any(Number) }],
    });
    expect(dataOf("library:list", await handlers["library:list"]({}))).toEqual({
      library: "ready",
      cards: [],
    });
  });

  it("refuses while the game's window is open (GAME_RUNNING), without a dialog", async () => {
    const { handlers, locks, dialogs } = setUp({ confirm: [true] });
    const { gameId } = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://a.example/" }),
    );
    const lease = await locks.acquire(gameId, "session");
    expect(await handlers["library:remove"]({ gameId })).toMatchObject({
      ok: false,
      code: "GAME_RUNNING",
    });
    expect(dialogs.confirm).not.toHaveBeenCalled();
    if ("release" in lease) lease.release();
    expect((await handlers["library:remove"]({ gameId })).ok).toBe(true);
  });
});

describe("badges and card state come from recorded state only (architecture.md section 11)", () => {
  it("shows Local data only after a storage check with data, and the runtime's state", async () => {
    const { handlers, repos, runtime, clock } = setUp();
    const { gameId } = dataOf(
      "library:add",
      await handlers["library:add"]({ url: "https://a.example/" }),
    );
    repos.storageChecks.save(gameId, false);
    let list = dataOf("library:list", await handlers["library:list"]({}));
    expect(list.library === "ready" && list.cards[0]?.badges.map((b) => b.id)).not.toContain(
      "local-data",
    );
    repos.storageChecks.save(gameId, true);
    runtime.state.mockReturnValue("running" as never);
    list = dataOf("library:list", await handlers["library:list"]({}));
    expect(list.library === "ready" && list.cards[0]).toMatchObject({
      state: "running",
      badges: expect.arrayContaining([{ id: "local-data", checkedAt: clock.now() }]),
    });
  });
});

describe("game:launch and game:focus", () => {
  it("passes the runtime's result through with the state", async () => {
    const { handlers, runtime } = setUp();
    const gameId = uuidv7();
    runtime.state.mockReturnValue("launching" as never);
    expect(dataOf("game:launch", await handlers["game:launch"]({ gameId }))).toEqual({
      window: "opened",
      state: "launching",
    });
    runtime.launch.mockResolvedValueOnce({ ok: false, code: "NOT_FOUND", message: "x" } as never);
    expect(await handlers["game:launch"]({ gameId })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await handlers["game:focus"]({ gameId })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    runtime.focus.mockReturnValue(true);
    expect(dataOf("game:focus", await handlers["game:focus"]({ gameId }))).toEqual({});
  });
});

describe("settings", () => {
  it("has no allowlisted key: get is empty and set stores nothing", async () => {
    const { handlers, repos } = setUp();
    expect(dataOf("settings:get", await handlers["settings:get"]({}))).toEqual({});
    expect(dataOf("settings:set", await handlers["settings:set"]({}))).toEqual({});
    expect(repos.settings.all()).toEqual({});
  });
});
