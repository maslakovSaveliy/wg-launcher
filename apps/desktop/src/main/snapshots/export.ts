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
import { frameKeyCandidates, numberKeys, type StorageKeyRef, sameKey, topOrigins } from "./keys.js";
import { type Bypass, type JobDeps, type JobKey, runQuiescentJob } from "./quiescent/job.js";

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
  paths: Pick<AppPaths, "snapshots" | "tmp">;
  job: JobDeps;
  startWorker(): Promise<SnapshotWorker>;
  log: Logger;
  newId(): string;
  now(): number;
}

type Failure = { ok: false; code: ErrorCode; message: string };
const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });

/** The adapter whose `match.origins` holds the game's top-level origin, if any (save-transfer.md section 8). */
export function adapterFor(entryUrl: string): Adapter | null {
  const origin = new URL(entryUrl).origin;
  return ADAPTERS.find((adapter) => adapter.match.origins.includes(origin)) ?? null;
}

/**
 * The game keys of an export: every top-level origin, the frame keys an adapter declared that were observed, and
 * the frame keys the user chose (or, without a choice, the ones remembered with `in_export`). A chosen key that is
 * not a frame key of this game is refused. A choice is remembered on the `storage_targets` rows.
 */
export function exportKeys(
  gameId: string,
  entryUrl: string,
  repos: SnapshotDeps["repos"],
  chosen: readonly StorageKeyRef[] | undefined,
  adapter: Adapter | null,
): Result<JobKey[], ErrorCode> {
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
  if (chosen !== undefined) {
    for (const candidate of candidates) {
      const inExport = chosen.some((key) => sameKey(key, candidate.key));
      for (const row of candidate.rows) repos.storageTargets.setInExport(row, inExport);
    }
  }
  const keys = numberKeys(
    topOrigins(entryUrl, targets),
    frames.map((candidate) => candidate.key),
  );
  if (keys.length > 32) return fail("INVALID_ARGUMENT", "Too many storage keys for one snapshot.");
  return { ok: true, data: keys };
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
  const keys = keyed.data;
  const scope: FrameScope = adapter
    ? adapterScope(adapter)
    : { localStorage: "all", indexedDB: "all" };
  const revisionId = deps.newId();
  const notExported: { key: number; kind: "fileSystem" | "cacheStorage" | "serviceWorkers" }[] = [];
  let worker: SnapshotWorker | null = null;
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
          if (worker === null) {
            worker = await deps.startWorker();
            worker.begin(options.test?.limits ?? {});
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
          // Every job has the game's own top key, so runFrames ran and started the worker.
          if (worker === null) return fail("INTERNAL", "No frame was read.");
          report({ step: "write" });
          const dir = join(deps.paths.snapshots, gameId);
          await mkdir(dir, { recursive: true });
          const finalPath = join(dir, `${revisionId}.wgsnap`);
          const flushState = decideFlushState({
            hook: "none",
            timeoutMs: 0,
            viaFlushFlow: false,
            run: { kind: "not-run" },
            inputAt: [],
            closedByLauncherAt: null,
          });
          const fresh = repos.games.get(gameId);
          const createdAt = new Date(deps.now()).toISOString();
          const written = await worker.write({
            manifest: {
              format: "wgsnap",
              formatVersion: 1,
              gameId,
              revisionId,
              parentRevisionId: fresh?.baseRevisionId ?? null,
              createdAt,
              deviceId: repos.device.ensure().id,
              exporter: GENERIC_EXPORTER,
              adapter: adapter ? { id: adapter.id, version: adapter.version } : null,
              gameVersion: null,
              flushState,
              storageKeys: keys.map(({ origin, topLevelSite, role }) => ({
                origin,
                topLevelSite,
                role,
              })),
              ...(notExported.length > 0 ? { notExported } : {}),
            },
            partialPath: join(deps.paths.tmp, `${revisionId}.wgsnap.partial`),
            finalPath,
            ...(options.test?.fault ? { fault: options.test.fault } : {}),
          });
          if (!written.ok) {
            // The worker removes its partial file itself; a worker that died on the way could not.
            await rm(join(deps.paths.tmp, `${revisionId}.wgsnap.partial`), { force: true });
            return written;
          }
          if (context.signal.aborted) {
            await rm(finalPath, { force: true });
            return fail("CANCELLED", "The export was stopped.");
          }
          try {
            const { snapshot } = repos.snapshots.addIfAbsent({
              revisionId,
              gameId,
              kind: "export",
              manifestGameId: gameId,
              parentRevisionId: fresh?.baseRevisionId ?? null,
              createdAt,
              deviceId: repos.device.ensure().id,
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
            await rm(finalPath, { force: true });
            return fail("INTERNAL", "The snapshot could not be recorded.");
          }
        },
        async discard() {
          await rm(join(deps.paths.tmp, `${revisionId}.wgsnap.partial`), { force: true });
        },
      },
      deps.job,
    );
  } finally {
    (worker as SnapshotWorker | null)?.kill();
  }
}
