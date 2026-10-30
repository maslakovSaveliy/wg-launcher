// Helpers for the snapshot task tests only (never imported by product code): a library database with one game and
// its stored snapshots, a snapshot worker whose answers a test sets, and a `QuiescentHold` that runs a window's plan
// at once over one connected frame per key and records the bytes each window reported for its deadline.

import { uuidv7 } from "@wg-launcher/shared";
import { vi } from "vitest";
import { createRepos } from "../db/repos/index.js";
import type { Snapshot, SnapshotKind } from "../db/repos/snapshots.js";
import { fakeClock, openTestDb, tempDir } from "../db/testing.js";
import type { SnapshotWorker, Validated } from "../worker/client.js";
import type { JobContext, JobPlan, JobTiming, QuiescentHold } from "./quiescent/job.js";
import type { TaskDeps } from "./restore-steps.js";

export const HASH = "c".repeat(64);
const MiB = 2 ** 20;

/** A database with one game, and a way to store snapshot rows for it. */
export function taskDb() {
  const dir = tempDir();
  const clock = fakeClock();
  const db = openTestDb(dir, clock);
  const repos = createRepos(db);
  const gameId = uuidv7();
  repos.games.insert({ id: gameId, url: "http://localhost:4317/", title: "lab" });
  const deviceId = repos.device.ensure().id;
  const store = (kind: SnapshotKind, overrides: Partial<Snapshot> = {}): Snapshot => {
    const revisionId = overrides.revisionId ?? uuidv7();
    return repos.snapshots.addIfAbsent({
      revisionId,
      gameId,
      kind,
      manifestGameId: gameId,
      parentRevisionId: null,
      createdAt: "2026-10-29T00:00:00.000Z",
      deviceId,
      exporterId: "generic-web-storage",
      exporterVersion: "1.0.0",
      contentHash: HASH,
      sizeBytes: MiB,
      path: `${kind === "backup" ? "backups" : "snapshots"}/${gameId}/${revisionId}.wgsnap`,
      flushState: "unconfirmed",
      ...overrides,
    }).snapshot;
  };
  return { db, repos, clock, gameId, store };
}

/** What a worker's `validate` answers for a file of one top-level key holding `dataBytes`. */
export function validatedFile(gameId: string, dataBytes: number): Validated {
  return {
    manifest: {
      format: "wgsnap",
      formatVersion: 1,
      gameId,
      revisionId: uuidv7(),
      parentRevisionId: null,
      createdAt: "2026-10-29T00:00:00.000Z",
      deviceId: uuidv7(),
      exporter: { id: "generic-web-storage", version: "1.0.0" },
      adapter: null,
      gameVersion: null,
      flushState: "unconfirmed",
      storageKeys: [{ origin: "http://localhost:4317", topLevelSite: null, role: "top" }],
      contentHash: HASH,
    },
    sizeBytes: MiB,
    entries: 1,
    dataBytes,
  } as Validated;
}

/** A worker that answers every command with success; `validate` answers `validated` (or never, when null). */
export function fakeWorker(validated: Validated | null) {
  const worker = {
    begin: vi.fn(),
    validate: vi.fn(() =>
      validated === null
        ? new Promise<never>(() => {})
        : Promise.resolve({ ok: true as const, data: validated }),
    ),
    inventory: vi.fn(async () => ({
      ok: true as const,
      data: { localStorageItems: 0, databases: [] },
    })),
    importFrame: vi.fn(async () => ({ ok: true as const, data: {} })),
    exportFrame: vi.fn(async () => ({ ok: true as const, data: {} })),
    wipeSelected: vi.fn(async () => ({
      ok: true as const,
      data: { localStorageItems: 0, databases: 0 },
    })),
    digest: vi.fn(async () => ({ ok: true as const, data: HASH })),
    expected: vi.fn(async () => ({ ok: true as const, data: HASH })),
    write: vi.fn(),
    onReceived: vi.fn(),
    kill: vi.fn(async () => {}),
  };
  return worker as typeof worker & SnapshotWorker;
}

/** A hold whose `run` runs the plan over one frame per key and records each window's reported bytes. */
export function fakeHold(gameId: string) {
  const windowBytes: number[] = [];
  const release = vi.fn();
  const signal = new AbortController().signal;
  const hold: QuiescentHold = {
    gameId,
    lock: "task",
    signal,
    async run<T>(plan: JobPlan<T>) {
      let bytes = 0;
      const context: JobContext = {
        signal,
        addBytes: (n) => {
          bytes += n;
        },
        committed: () => {},
        clearStorage: async () => {},
      };
      try {
        const frames = plan.keys.map((key) => ({ key, port: {} }));
        const ran = await plan.runFrames(frames, context);
        if (!ran.ok) {
          await plan.discard();
          return ran;
        }
        return await plan.commit(context);
      } finally {
        windowBytes.push(bytes);
      }
    },
    release,
  };
  return { hold, windowBytes, release };
}

/** The deps of a task over `repos`, with `worker` as every job's worker and a short job deadline. */
export function taskDeps(
  repos: ReturnType<typeof taskDb>["repos"],
  worker: SnapshotWorker,
  timing: Partial<JobTiming> = {},
) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const recovery = { mark: vi.fn(), clear: vi.fn() };
  const deps = {
    repos,
    log,
    recovery,
    job: { timing } as TaskDeps["job"],
    startWorker: async () => worker,
    fileOf: (relative: string) => `/userData/${relative}`,
    verifySession: () => ({ session: {} as never, dispose: async () => {} }),
    now: () => 1_800_000_000_000,
  } as unknown as TaskDeps;
  return { deps, log, recovery };
}
