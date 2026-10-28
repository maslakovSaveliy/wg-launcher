// Snapshot export (save-transfer.md section 6, "Export"): the lock, the quiescent window over the game keys with the
// adapter's scope, the snapshot worker's file (written as `tmp/<revisionId>.wgsnap.partial`, read back through the
// full validator, flushed and renamed to `snapshots/<gameId>/<revisionId>.wgsnap`), then the database row and the
// game's `base_revision_id`. Export never changes the game's storage apart from the aborted key-generator probe.
// The manifest's `flushState` comes from `decideFlushState`: the generic exporter runs no flush hook, so every export
// here is `unconfirmed` (data-safety invariant 4; save-transfer.md section 7).
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ADAPTERS,
  type Adapter,
  adapterScope,
  decideFlushState,
  type FrameScope,
  GENERIC_EXPORTER,
} from "@wg-launcher/exporters/wire";
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { Repos } from "../db/repos/index.js";
import type { Snapshot } from "../db/repos/snapshots.js";
import type { Logger } from "../log/logger.js";
import type { AppPaths } from "../paths.js";
import type { Limits, SnapshotWorker } from "../worker/client.js";
import { type WorkerSlot, workerSlot } from "../worker/slot.js";
import { frameKeyCandidates, numberKeys, type StorageKeyRef, sameKey, topOrigins } from "./keys.js";
import {
  type Bypass,
  failureOf,
  type JobDeps,
  type JobKey,
  runQuiescentJob,
} from "./quiescent/job.js";

/** The steps a task reports (architecture.md section 6, `task:progress`). */
export type ExportStep = "lock" | "read" | "write";

export interface ExportProgress {
  step: ExportStep;
  /** Entry bytes the worker received, measured; never estimated. */
  bytesDone?: number;
}

/** Test-flavor controls; production passes none. */
export interface ExportTestControls {
  limits?: Limits;
  fault?: "fail-write";
  bypass?: Bypass;
}

export interface ExportOptions {
  /** The cross-site or first-party frame keys the user ticked; omitted, the remembered choice applies. */
  frameKeys?: readonly StorageKeyRef[];
  onLocked?(): void;
  onProgress?(progress: ExportProgress): void;
  test?: ExportTestControls;
}

export interface SnapshotDeps {
  repos: Pick<Repos, "games" | "snapshots" | "storageTargets" | "device" | "storageChecks">;
  /** One database transaction (`WritableDb.transaction`): the row and the base revision move together. */
  transaction<T>(fn: () => T): T;
  paths: Pick<AppPaths, "snapshots" | "tmp">;
  job: JobDeps;
  startWorker(): Promise<SnapshotWorker>;
  log: Logger;
  newId(): string;
  now(): number;
}

type Failure = { ok: false; code: ErrorCode; message: string };
const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });

type NotExported = { key: number; kind: "fileSystem" | "cacheStorage" | "serviceWorkers" };

/** The adapter whose `match.origins` holds the game's top-level origin, if any (save-transfer.md section 8). */
export function adapterFor(entryUrl: string): Adapter | null {
  const origin = new URL(entryUrl).origin;
  return ADAPTERS.find((adapter) => adapter.match.origins.includes(origin)) ?? null;
}

export interface ExportKeys {
  keys: JobKey[];
  /** Remembers the user's frame choice on the `storage_targets` rows; called at commit only. */
  remember(): void;
}

/**
 * The game keys of an export: every top-level origin, the frame keys an adapter declared that were observed, and
 * the frame keys the user chose (or, without a choice, the ones remembered with `in_export`). A chosen key that is
 * not a frame key of this game is INVALID_ARGUMENT; more keys than a manifest may hold (`maxStorageKeys`, 32) is
 * SNAP_MANIFEST_INVALID, the code the format gives such a manifest (snapshot-format.md section 4). Nothing is written
 * here: the choice is remembered by `remember`, when the export commits.
 */
export function exportKeys(
  gameId: string,
  entryUrl: string,
  repos: SnapshotDeps["repos"],
  chosen: readonly StorageKeyRef[] | undefined,
  adapter: Adapter | null,
): Result<ExportKeys, ErrorCode> {
  const targets = repos.storageTargets.listForGame(gameId);
  const candidates = frameKeyCandidates(entryUrl, targets);
  if (chosen?.some((key) => !candidates.some((candidate) => sameKey(candidate.key, key)))) {
    return fail("INVALID_ARGUMENT", "A chosen frame is not a frame of this game.");
  }
  const declared = adapter?.storage.frameKeys ?? [];
  const frames = candidates.filter((candidate) => {
    if (declared.some((key) => sameKey(key, candidate.key))) return true;
    if (chosen !== undefined) return chosen.some((key) => sameKey(key, candidate.key));
    return candidate.rows.some((row) => row.inExport);
  });
  const keys = numberKeys(
    topOrigins(entryUrl, targets),
    frames.map((candidate) => candidate.key),
  );
  if (keys.length > MAX_STORAGE_KEYS) {
    return fail(
      "SNAP_MANIFEST_INVALID",
      `This game uses ${keys.length} storage keys; a snapshot holds at most ${MAX_STORAGE_KEYS}.`,
    );
  }
  const remember = () => {
    if (chosen === undefined) return;
    for (const candidate of candidates) {
      const inExport = chosen.some((key) => sameKey(key, candidate.key));
      for (const row of candidate.rows) repos.storageTargets.setInExport(row, inExport);
    }
  };
  return { ok: true, data: { keys, remember } };
}

/** `maxStorageKeys` of snapshot-format.md section 8. */
const MAX_STORAGE_KEYS = 32;

export interface CommitRequest {
  gameId: string;
  revisionId: string;
  keys: readonly JobKey[];
  adapter: Adapter | null;
  notExported: readonly NotExported[];
  worker: Pick<SnapshotWorker, "write">;
  remember(): void;
  fault?: "fail-write";
  signal: AbortSignal;
  onWrite?(): void;
}

/**
 * The export's commit: the worker writes and verifies the file; then, in one database transaction, the user's frame
 * choice, the row and the game's base revision. The revision id is new to this job, so on any failure both its
 * partial and its final file are removed (a worker that died after its rename leaves a final file without a row
 * otherwise), and a stopped job (`signal`) commits nothing and returns why it stopped.
 */
export async function commitExport(
  request: CommitRequest,
  deps: Pick<SnapshotDeps, "repos" | "transaction" | "paths" | "log" | "now">,
): Promise<Result<Snapshot, ErrorCode>> {
  const { gameId, revisionId, adapter } = request;
  const { repos, log } = deps;
  const dir = join(deps.paths.snapshots, gameId);
  const finalPath = join(dir, `${revisionId}.wgsnap`);
  const partialPath = join(deps.paths.tmp, `${revisionId}.wgsnap.partial`);
  const removeFiles = () => removeRevisionFiles(deps.paths, gameId, revisionId);
  request.onWrite?.();
  await mkdir(dir, { recursive: true });
  const flushState = decideFlushState({
    hook: "none",
    timeoutMs: 0,
    viaFlushFlow: false,
    run: { kind: "not-run" },
    inputAt: [],
    closedByLauncherAt: null,
  });
  const parentRevisionId = repos.games.get(gameId)?.baseRevisionId ?? null;
  const createdAt = new Date(deps.now()).toISOString();
  const deviceId = repos.device.ensure().id;
  const written = await request.worker.write({
    manifest: {
      format: "wgsnap",
      formatVersion: 1,
      gameId,
      revisionId,
      parentRevisionId,
      createdAt,
      deviceId,
      exporter: GENERIC_EXPORTER,
      adapter: adapter ? { id: adapter.id, version: adapter.version } : null,
      gameVersion: null,
      flushState,
      storageKeys: request.keys.map(({ origin, topLevelSite, role }) => ({
        origin,
        topLevelSite,
        role,
      })),
      ...(request.notExported.length > 0 ? { notExported: [...request.notExported] } : {}),
    },
    partialPath,
    finalPath,
    ...(request.fault ? { fault: request.fault } : {}),
  });
  if (!written.ok) {
    await removeFiles();
    return written;
  }
  if (request.signal.aborted) {
    await removeFiles();
    return failureOf(request.signal);
  }
  try {
    const snapshot = deps.transaction(() => {
      request.remember();
      const { snapshot: row } = repos.snapshots.addIfAbsent({
        revisionId,
        gameId,
        kind: "export",
        manifestGameId: gameId,
        parentRevisionId,
        createdAt,
        deviceId,
        exporterId: GENERIC_EXPORTER.id,
        exporterVersion: GENERIC_EXPORTER.version,
        ...(adapter ? { adapterId: adapter.id, adapterVersion: adapter.version } : {}),
        contentHash: written.data.contentHash,
        sizeBytes: written.data.sizeBytes,
        path: `snapshots/${gameId}/${revisionId}.wgsnap`,
        flushState,
      });
      // The partition's data now descends from this revision (save-transfer.md, "Revision parents").
      repos.games.update(gameId, { baseRevisionId: revisionId });
      return row;
    });
    log.info("snapshot.export.done", {
      gameId,
      revisionId,
      sizeBytes: written.data.sizeBytes,
      entries: written.data.entries,
      flushState,
    });
    return { ok: true, data: snapshot };
  } catch (error) {
    log.error("snapshot.export.row-failed", { gameId, error });
    await removeFiles();
    return fail("INTERNAL", "The snapshot could not be recorded.");
  }
}

/** The files a revision of this job may have left: the partial and, after the worker's rename, the final one. */
async function removeRevisionFiles(
  paths: SnapshotDeps["paths"],
  gameId: string,
  revisionId: string,
): Promise<void> {
  await rm(join(paths.tmp, `${revisionId}.wgsnap.partial`), { force: true });
  await rm(join(paths.snapshots, gameId, `${revisionId}.wgsnap`), { force: true });
}

/**
 * The export's discard, after a failure or a commit the job stopped before it settled (a hung write under the
 * watchdog): the worker is killed and has exited before the revision's files are removed, so a write still running
 * cannot leave one behind. No row exists then: the commit records one only after the write and only while the job
 * is not stopped.
 */
export async function discardExport(
  job: { gameId: string; revisionId: string; workers: WorkerSlot },
  deps: Pick<SnapshotDeps, "paths">,
): Promise<void> {
  await job.workers.dispose();
  await removeRevisionFiles(deps.paths, job.gameId, job.revisionId);
}

export async function exportSnapshot(
  gameId: string,
  options: ExportOptions,
  deps: SnapshotDeps,
): Promise<Result<Snapshot, ErrorCode>> {
  const { repos, log } = deps;
  const game = repos.games.get(gameId);
  if (!game) return fail("NOT_FOUND", "The game is not in the library.");
  const adapter = adapterFor(game.url);
  const keyed = exportKeys(gameId, game.url, repos, options.frameKeys, adapter);
  if (!keyed.ok) return keyed;
  const { keys, remember } = keyed.data;
  const scope: FrameScope = adapter
    ? adapterScope(adapter)
    : { localStorage: "all", indexedDB: "all" };
  const revisionId = deps.newId();
  const notExported: NotExported[] = [];
  const workers = workerSlot(deps.startWorker, options.test?.limits ?? {});
  let listening = false;
  const report = (progress: ExportProgress) => options.onProgress?.(progress);

  try {
    return await runQuiescentJob<Snapshot>(
      gameId,
      {
        direction: "export",
        lock: "task",
        keys,
        ...(options.test?.bypass ? { bypass: options.test.bypass } : {}),
        onLocked: () => {
          options.onLocked?.();
          report({ step: "lock" });
        },
        async runFrames(frames, context) {
          const worker = await workers.get(context.signal);
          if (worker === null) return failureOf(context.signal);
          if (!listening) {
            listening = true;
            let reported = 0;
            worker.onReceived((bytes) => {
              context.addBytes(bytes - reported);
              reported = bytes;
              report({ step: "read", bytesDone: bytes });
            });
            report({ step: "read", bytesDone: 0 });
          }
          for (const frame of frames) {
            const exported = await worker.exportFrame(frame.port, {
              keyIndex: frame.key.index,
              storageKey: { origin: frame.key.origin, topLevelSite: frame.key.topLevelSite },
              scope,
            });
            if (!exported.ok) return exported;
            for (const kind of exported.data.notExported)
              notExported.push({ key: frame.key.index, kind });
            log.info("snapshot.export.frame", {
              gameId,
              key: frame.key.index,
              localStorageItems: exported.data.localStorageItems,
              databases: exported.data.databases,
              records: exported.data.records,
              blobs: exported.data.blobs,
            });
          }
          return { ok: true, data: undefined };
        },
        async commit(context) {
          const worker = await workers.get(context.signal);
          if (worker === null) return failureOf(context.signal);
          return commitExport(
            {
              gameId,
              revisionId,
              keys,
              adapter,
              notExported,
              worker,
              remember,
              signal: context.signal,
              onWrite: () => report({ step: "write" }),
              ...(options.test?.fault ? { fault: options.test.fault } : {}),
            },
            deps,
          );
        },
        async discard() {
          await discardExport({ gameId, revisionId, workers }, deps);
        },
      },
      deps.job,
    );
  } finally {
    await workers.dispose();
  }
}
