import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@wg-launcher/shared";
import { describe, expect, it, vi } from "vitest";
import { createRepos } from "../db/repos/index.js";
import { fakeClock, openTestDb, tempDir } from "../db/testing.js";
import type { WriteOptions } from "../worker/client.js";
import { type CommitRequest, commitExport, discardExport, exportKeys } from "./export.js";
import { JobStop } from "./quiescent/stop.js";

function setUp() {
  const dir = tempDir();
  const clock = fakeClock();
  const db = openTestDb(dir, clock);
  const repos = createRepos(db);
  const paths = { snapshots: join(dir, "snapshots"), tmp: join(dir, "tmp") };
  mkdirSync(paths.tmp, { recursive: true });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const gameId = uuidv7();
  repos.games.insert({ id: gameId, url: "http://localhost:4317/", title: "lab" });
  repos.storageTargets.markSeen({
    gameId,
    topOrigin: "http://localhost:4317",
    frameOrigin: "http://127.0.0.1:4317",
  });
  const deps = {
    repos,
    transaction: <T>(fn: () => T) => db.transaction(fn),
    paths,
    log,
    now: clock.now,
  };
  const revisionId = uuidv7();
  const finalPath = join(paths.snapshots, gameId, `${revisionId}.wgsnap`);
  /** A worker whose write puts the final file in place and answers `answer`. */
  const worker = (answer: "written" | "died-after-rename") => ({
    write: vi.fn(async (options: WriteOptions) => {
      writeFileSync(options.finalPath, "snapshot");
      return answer === "written"
        ? { ok: true as const, data: { contentHash: "a".repeat(64), sizeBytes: 8, entries: 1 } }
        : {
            ok: false as const,
            code: "INTERNAL" as const,
            message: "The snapshot worker stopped.",
          };
    }),
  });
  const keyed = exportKeys(
    gameId,
    "http://localhost:4317/",
    repos,
    [{ origin: "http://127.0.0.1:4317", topLevelSite: "http://localhost" }],
    null,
  );
  if (!keyed.ok) throw new Error(keyed.code);
  const request = (overrides: Partial<CommitRequest>): CommitRequest => ({
    gameId,
    revisionId,
    keys: keyed.data.keys,
    adapter: null,
    notExported: [],
    worker: worker("written"),
    remember: keyed.data.remember,
    signal: new AbortController().signal,
    ...overrides,
  });
  const inExport = () => repos.storageTargets.listForGame(gameId).map((row) => row.inExport);
  const files = () => ({
    tmp: readdirSync(paths.tmp),
    snapshots: existsSync(join(paths.snapshots, gameId))
      ? readdirSync(join(paths.snapshots, gameId))
      : [],
  });
  return { repos, deps, gameId, revisionId, finalPath, worker, request, inExport, files, keyed };
}

describe("the export commit (save-transfer.md section 6, Export)", () => {
  it("records the row, moves the base revision and remembers the frame choice, together", async () => {
    const { deps, request, repos, gameId, revisionId, inExport, files } = setUp();
    expect(inExport()).toEqual([false]);
    const result = await commitExport(request({}), deps);
    expect(result).toMatchObject({ ok: true, data: { revisionId, flushState: "unconfirmed" } });
    expect(repos.games.get(gameId)?.baseRevisionId).toBe(revisionId);
    expect(inExport()).toEqual([true]);
    expect(files()).toEqual({ tmp: [], snapshots: [`${revisionId}.wgsnap`] });
  });

  it("choosing frames writes nothing before the commit", () => {
    const { inExport } = setUp();
    expect(inExport()).toEqual([false]);
  });

  it("removes the final file when the worker failed after its rename, and writes no row", async () => {
    const { deps, request, repos, gameId, worker, files, inExport } = setUp();
    const result = await commitExport(request({ worker: worker("died-after-rename") }), deps);
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(files()).toEqual({ tmp: [], snapshots: [] });
    expect(repos.snapshots.listForGame(gameId, null)).toEqual([]);
    expect(inExport()).toEqual([false]);
  });

  it("rolls the row back when moving the base revision fails, and removes the file", async () => {
    const { deps, request, repos, gameId, files, inExport } = setUp();
    vi.spyOn(repos.games, "update").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    expect(await commitExport(request({}), deps)).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(repos.snapshots.listForGame(gameId, null)).toEqual([]);
    expect(repos.games.get(gameId)?.baseRevisionId).toBeNull();
    expect(inExport()).toEqual([false]);
    expect(files()).toEqual({ tmp: [], snapshots: [] });
  });

  it("commits nothing once the job was stopped, and returns why (the watchdog's EXP_TIMEOUT)", async () => {
    const { deps, request, repos, gameId, files } = setUp();
    const stop = new AbortController();
    stop.abort(new JobStop({ ok: false, code: "EXP_TIMEOUT", message: "The job took too long." }));
    expect(await commitExport(request({ signal: stop.signal }), deps)).toMatchObject({
      ok: false,
      code: "EXP_TIMEOUT",
    });
    expect(repos.snapshots.listForGame(gameId, null)).toEqual([]);
    expect(files()).toEqual({ tmp: [], snapshots: [] });
  });

  it("discards a stopped export only after its worker has exited: no partial, no final file, no row", async () => {
    const { deps, repos, gameId, revisionId, finalPath, files } = setUp();
    const partialPath = join(deps.paths.tmp, `${revisionId}.wgsnap.partial`);
    writeFileSync(partialPath, "partial");
    const workers = {
      get: vi.fn(),
      // A worker that renames its file in its last moments, before it exits.
      dispose: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        mkdirSync(join(deps.paths.snapshots, gameId), { recursive: true });
        writeFileSync(finalPath, "snapshot");
      }),
    };
    await discardExport({ gameId, revisionId, workers }, deps);
    expect(workers.dispose).toHaveBeenCalled();
    expect(files()).toEqual({ tmp: [], snapshots: [] });
    expect(repos.snapshots.listForGame(gameId, null)).toEqual([]);
  });

  it("refuses more storage keys than a manifest holds with SNAP_MANIFEST_INVALID", () => {
    const { repos, gameId } = setUp();
    for (let port = 5000; port < 5040; port++) {
      repos.storageTargets.markSeen({
        gameId,
        topOrigin: `http://localhost:${port}`,
        frameOrigin: `http://localhost:${port}`,
      });
    }
    expect(exportKeys(gameId, "http://localhost:4317/", repos, undefined, null)).toMatchObject({
      ok: false,
      code: "SNAP_MANIFEST_INVALID",
    });
  });
});
