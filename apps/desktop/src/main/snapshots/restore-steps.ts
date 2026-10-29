// The quiescent windows of the restore protocol (save-transfer.md section 6), each run under a hold that keeps the
// game's lease and one job slot from R3 to R8: R4 the backup of every key of the wipe set (generic exporter, no
// adapter filter, written as `.partial`, read back and validated, renamed into `backups/<gameId>/`, recorded with
// kind `backup`), R5 the wipe (CDP `Storage.clearDataForStorageKey` of each frame's key with
// `local_storage,indexeddb` and an inventory that must find nothing, or the importer's `wipe-selected` for a selective
// restore), R6 the import (the worker's second pass over the file), R7 the re-export compared with the expected
// hash, and the rollback (wipe again, import the backup, compare with the backup's `contentHash`). Each window is one
// command per frame. Shared by restore.ts, recovery.ts, delete-saves.ts and verify.ts.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ADAPTERS,
  adapterScope,
  decideFlushState,
  type FrameScope,
  GENERIC_EXPORTER,
} from "@wg-launcher/exporters/wire";
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { Repos } from "../db/repos/index.js";
import type { Snapshot } from "../db/repos/snapshots.js";
import type { ConfirmSpec } from "../dialogs.js";
import type { AppPaths } from "../paths.js";
import type { SnapshotWorker } from "../worker/client.js";
import { workerSlot } from "../worker/slot.js";
import type { SnapshotDeps } from "./export.js";
import { type FaultHook, type FaultPoint, InjectedFault } from "./faults.js";
import type { Journal } from "./journal.js";
import { failureOf, type JobKey, type JobSession, type QuiescentHold } from "./quiescent/job.js";

export const ALL: FrameScope = { localStorage: "all", indexedDB: "all" };

/** What the restore, the delete, recovery and verify run on. */
export interface TaskDeps extends Omit<SnapshotDeps, "repos" | "paths"> {
  repos: Pick<
    Repos,
    | "games"
    | "snapshots"
    | "storageTargets"
    | "device"
    | "storageChecks"
    | "restoreJournal"
    | "orphans"
  >;
  paths: Pick<AppPaths, "snapshots" | "tmp" | "backups">;
  /** The absolute path of a stored row's file (rows hold it relative to userData). */
  fileOf(relative: string): string;
  /** A native confirmation whose text main writes (architecture.md section 6). */
  confirm(spec: ConfirmSpec): Promise<boolean>;
  /** The lock manager's recovery mark: launches and tasks are refused while it is set. */
  recovery: { mark(gameId: string): void; clear(gameId: string): void };
  /** Whether the game's window is open now; a restore refuses early (AC-11), R3 decides under the lock. */
  isRunning?(gameId: string): boolean;
  /** Data changed: "Local data" is checked again (architecture.md section 11). */
  afterChange?(gameId: string): void;
  /** A fresh in-memory partition `wg-verify-<nonce>` with the game policy, and its clean-up. */
  verifySession?(): { session: JobSession; dispose(): Promise<void> };
  /** Test flavor only (AC-8, Review Focus 2). */
  faults?: FaultHook;
}

/** A key of a restore plan: its index in the target and its index in the source file. */
export interface PlannedKey extends JobKey {
  from: number;
}

type Failure = { ok: false; code: ErrorCode; message: string };
export const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });
const OK = { ok: true, data: undefined } as const;

const toRef = ({ origin, topLevelSite }: JobKey) => ({ origin, topLevelSite });
const manifestKeys = (keys: readonly JobKey[]) =>
  [...keys]
    .sort((a, b) => a.index - b.index)
    .map(({ origin, topLevelSite, role }) => ({ origin, topLevelSite, role }));

/**
 * Runs one step: writes it to the journal before it starts, reports it, and calls the test fault hook at its start
 * and, once it succeeded, at its end (`crash-after:<step>` ends the process there).
 */
export interface StepContext {
  journal?: Journal;
  faults?: FaultHook;
  onStep?(point: FaultPoint): void;
  log?: Pick<TaskDeps["log"], "error">;
}

/**
 * Nothing a step does throws past it: an error (a journal write, a file system call, a bug) is the step's INTERNAL
 * failure, so a failure after R5 always reaches the rollback.
 */
export async function runStep<T>(
  point: FaultPoint,
  context: StepContext,
  run: () => Promise<Result<T, ErrorCode>>,
): Promise<Result<T, ErrorCode>> {
  try {
    context.journal?.step(point);
    context.onStep?.(point);
    context.faults?.(point, "start");
    const result = await run();
    if (result.ok) context.faults?.(point, "end");
    return result;
  } catch (error) {
    if (error instanceof InjectedFault) return fail("INTERNAL", error.message);
    context.log?.error("snapshot.step.threw", { step: point, error });
    return fail("INTERNAL", `The ${point} step failed unexpectedly.`);
  }
}

/** How a window runs: its session, the data it handles (its deadline), whether a cancel stops it, its step. */
export interface WindowOptions {
  session?: JobSession;
  /** Bytes of save data the window handles, known before it starts; each MiB extends its deadline (job.ts). */
  budgetBytes?: number;
  /** False for the rollback: a cancel must not stop it (the watchdog and the canary still do). */
  cancellable?: boolean;
  /** The step and the fault hook: `slow:<step>:<ms>` waits inside the window (test flavor). */
  point?: FaultPoint;
  faults?: FaultHook;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One window over `keys` whose frames each run `perFrame`; nothing to commit. */
function frameWindow(
  hold: QuiescentHold,
  keys: readonly JobKey[],
  perFrame: (
    frame: { key: JobKey; port: unknown },
    context: {
      signal: AbortSignal;
      clearStorage(key: JobKey, storageTypes: string): Promise<void>;
    },
  ) => Promise<Result<void, ErrorCode>>,
  options: WindowOptions & { commit?: () => Promise<Result<void, ErrorCode>> } = {},
): Promise<Result<void, ErrorCode>> {
  let first = true;
  return hold.run<void>(
    {
      direction: "import",
      lock: hold.lock,
      keys,
      ...(options.session ? { session: options.session } : {}),
      async runFrames(frames, context) {
        if (first) {
          first = false;
          // The deadline grows with the data this window handles (save-transfer.md section 6).
          context.addBytes(options.budgetBytes ?? 0);
          const delay = options.point ? (options.faults?.(options.point, "window") ?? 0) : 0;
          if (delay > 0) await sleep(delay);
        }
        for (const frame of frames) {
          if (context.signal.aborted) return failureOf(context.signal);
          const done = await perFrame(frame, context);
          if (!done.ok) return done;
        }
        return OK;
      },
      async commit(context) {
        if (context.signal.aborted) return failureOf(context.signal);
        return options.commit ? options.commit() : OK;
      },
      async discard() {},
    },
    { cancellable: options.cancellable !== false },
  );
}

/**
 * R4: exports every key of `keys` with the generic exporter and no filter into
 * `backups/<gameId>/<backupRevisionId>.wgsnap` and records it as kind `backup`. Pre-import and pre-delete backups never
 * move the game's base revision. Any failure is IMP_BACKUP_FAILED, and the partial and final files are removed.
 */
export async function writeBackup(
  hold: QuiescentHold,
  keys: readonly JobKey[],
  backupRevisionId: string,
  deps: TaskDeps,
): Promise<Result<{ snapshot: Snapshot; dataBytes: number }, ErrorCode>> {
  const { gameId } = hold;
  let listening = false;
  const workers = workerSlot(deps.startWorker, {});
  const dir = join(deps.paths.backups, gameId);
  const partialPath = join(deps.paths.tmp, `${backupRevisionId}.wgsnap.partial`);
  const finalPath = join(dir, `${backupRevisionId}.wgsnap`);
  const removeFiles = async () => {
    await rm(partialPath, { force: true });
    await rm(finalPath, { force: true });
  };
  let row: Snapshot | null = null;
  try {
    const result = await hold.run<{ snapshot: Snapshot; dataBytes: number }>({
      direction: "export",
      lock: hold.lock,
      keys,
      async runFrames(frames, context) {
        const worker = await workers.get(context.signal);
        if (worker === null) return failureOf(context.signal);
        if (!listening) {
          // The size is not known before the read: the deadline grows with the bytes the worker measured.
          listening = true;
          let reported = 0;
          worker.onReceived((bytes) => {
            context.addBytes(bytes - reported);
            reported = bytes;
          });
        }
        for (const frame of frames) {
          const exported = await worker.exportFrame(frame.port, {
            keyIndex: frame.key.index,
            storageKey: toRef(frame.key),
            scope: ALL,
          });
          if (!exported.ok) return exported;
        }
        return OK;
      },
      async commit(context) {
        const worker = await workers.get(context.signal);
        if (worker === null) return failureOf(context.signal);
        await mkdir(dir, { recursive: true });
        const game = deps.repos.games.get(gameId);
        const createdAt = new Date(deps.now()).toISOString();
        const deviceId = deps.repos.device.ensure().id;
        const flushState = decideFlushState({
          hook: "none",
          timeoutMs: 0,
          viaFlushFlow: false,
          run: { kind: "not-run" },
          inputAt: [],
          closedByLauncherAt: null,
        });
        const parentRevisionId = game?.baseRevisionId ?? null;
        const written = await worker.write({
          manifest: {
            format: "wgsnap",
            formatVersion: 1,
            gameId,
            revisionId: backupRevisionId,
            parentRevisionId,
            createdAt,
            deviceId,
            exporter: GENERIC_EXPORTER,
            adapter: null,
            gameVersion: null,
            flushState,
            storageKeys: manifestKeys(keys),
          },
          partialPath,
          finalPath,
        });
        if (!written.ok) return written;
        if (context.signal.aborted) return failureOf(context.signal);
        const { snapshot } = deps.repos.snapshots.addIfAbsent({
          revisionId: backupRevisionId,
          gameId,
          kind: "backup",
          manifestGameId: gameId,
          parentRevisionId,
          createdAt,
          deviceId,
          exporterId: GENERIC_EXPORTER.id,
          exporterVersion: GENERIC_EXPORTER.version,
          contentHash: written.data.contentHash,
          sizeBytes: written.data.sizeBytes,
          path: `backups/${gameId}/${backupRevisionId}.wgsnap`,
          flushState,
        });
        row = snapshot;
        context.committed();
        deps.log.info("snapshot.backup.done", {
          gameId,
          revisionId: backupRevisionId,
          keys: keys.length,
          sizeBytes: written.data.sizeBytes,
          entries: written.data.entries,
        });
        return { ok: true, data: { snapshot, dataBytes: written.data.dataBytes } };
      },
      async discard() {
        await workers.dispose();
        if (row === null) await removeFiles();
      },
    });
    if (result.ok) return result;
    if (row === null) await removeFiles();
    deps.log.warn("snapshot.backup.failed", { gameId, code: result.code });
    return fail(
      "IMP_BACKUP_FAILED",
      `The backup could not be made, so nothing was changed. ${result.message}`,
    );
  } finally {
    await workers.dispose();
  }
}

/** The code a failed wipe reports: its own IMP_ code, IMP_WIPE_FAILED for anything else. */
const asWipeFailure = (failure: Failure): Failure =>
  failure.code.startsWith("IMP_") ? failure : fail("IMP_WIPE_FAILED", failure.message);

/**
 * R5 over `keys`: with `scope` "all" each frame's whole key is cleared through CDP and an inventory must then find no
 * localStorage item and no database; a selective restore runs `wipe-selected` with the adapter's scope instead. A
 * blocked delete (`IMP_WIPE_FAILED`) stays queued in IndexedDB, so it is never retried: the caller rolls back.
 */
export async function wipeKeys(
  hold: QuiescentHold,
  keys: readonly JobKey[],
  scope: FrameScope | "all",
  worker: SnapshotWorker,
  options: WindowOptions = {},
): Promise<Result<void, ErrorCode>> {
  const wiped = await frameWindow(
    hold,
    keys,
    async (frame, context) => {
      if (scope !== "all") {
        const done = await worker.wipeSelected(frame.port, scope);
        return done.ok ? OK : done;
      }
      await context.clearStorage(frame.key, "local_storage,indexeddb");
      const inventory = await worker.inventory(frame.port);
      if (!inventory.ok) return inventory;
      if (inventory.data.localStorageItems > 0 || inventory.data.databases.length > 0) {
        return fail("IMP_WIPE_FAILED", "A storage key still held data after it was cleared.");
      }
      return OK;
    },
    options,
  );
  return wiped.ok ? wiped : asWipeFailure(wiped);
}

/** R6 over `keys`: each frame imports the validated file's key `from` as its own key. */
export function importKeys(
  hold: QuiescentHold,
  keys: readonly PlannedKey[],
  scope: FrameScope,
  worker: SnapshotWorker,
  options: WindowOptions = {},
): Promise<Result<void, ErrorCode>> {
  return frameWindow(
    hold,
    keys,
    async (frame) => {
      const key = keys.find((k) => k.index === frame.key.index) as PlannedKey;
      const imported = await worker.importFrame(frame.port, {
        from: key.from,
        keyIndex: key.index,
        storageKey: toRef(key),
        scope,
      });
      return imported.ok ? OK : imported;
    },
    options,
  );
}

/**
 * R7 over `keys`: re-exports them with `scope` and compares the `contentHash` of what came back with `expected`
 * (IMP_VERIFY_MISMATCH otherwise). `worker` must not have exported anything before in this job.
 */
export function verifyKeys(
  hold: QuiescentHold,
  keys: readonly JobKey[],
  scope: FrameScope,
  worker: SnapshotWorker,
  expected: string,
  options: WindowOptions = {},
): Promise<Result<void, ErrorCode>> {
  return frameWindow(
    hold,
    keys,
    async (frame) => {
      const exported = await worker.exportFrame(frame.port, {
        keyIndex: frame.key.index,
        storageKey: toRef(frame.key),
        scope,
      });
      return exported.ok ? OK : exported;
    },
    {
      ...options,
      async commit() {
        const digest = await worker.digest(manifestKeys(keys));
        if (!digest.ok) return digest;
        if (digest.data !== expected) {
          return fail("IMP_VERIFY_MISMATCH", "The data read back differs from what was written.");
        }
        return OK;
      },
    },
  );
}

/** The keys of a validated manifest, unmapped (the backup's, or a snapshot's own for verify). */
export const ownKeys = (
  storageKeys: readonly { origin: string; topLevelSite: string | null; role: "top" | "frame" }[],
): PlannedKey[] => storageKeys.map((key, index) => ({ index, from: index, ...key }));

/**
 * The rollback (any failure in R5 to R8): wipe the backup's keys again, import the backup, re-export and compare
 * with the backup's `contentHash`. Its steps are journaled as `rollback-*` with the state `rolling-back`. The backup is
 * never deleted. Resolves ok only when the state verifiably equals the backup.
 */
export async function rollBack(
  hold: QuiescentHold,
  journal: Journal,
  backup: Snapshot,
  deps: TaskDeps,
  onStep?: (point: FaultPoint) => void,
): Promise<Result<void, ErrorCode>> {
  const { gameId } = hold;
  const workers = workerSlot(deps.startWorker, {});
  // Nobody can cancel a rollback: the worker and every window run on a signal no cancel aborts.
  const never = new AbortController().signal;
  const context: StepContext = {
    journal,
    log: deps.log,
    ...(deps.faults ? { faults: deps.faults } : {}),
    ...(onStep ? { onStep } : {}),
  };
  const windowOf = (point: FaultPoint, budgetBytes: number): WindowOptions => ({
    cancellable: false,
    budgetBytes,
    point,
    ...(deps.faults ? { faults: deps.faults } : {}),
  });
  try {
    deps.log.warn("snapshot.rollback.start", { gameId, backupRevisionId: backup.revisionId });
    const wiped = await runStep("rollback-wipe", context, async () => {
      const worker = await workers.get(never);
      if (worker === null) return fail("INTERNAL", "The snapshot worker did not start.");
      const validated = await worker.validate(deps.fileOf(backup.path));
      if (!validated.ok) return validated;
      if (validated.data.manifest.contentHash !== backup.contentHash) {
        return fail("IMP_RECOVERY_FAILED", "The backup file differs from its record.");
      }
      const keys = ownKeys(validated.data.manifest.storageKeys);
      const { dataBytes } = validated.data;
      const done = await wipeKeys(hold, keys, "all", worker, windowOf("rollback-wipe", dataBytes));
      return done.ok ? { ok: true, data: { worker, keys, dataBytes } } : done;
    });
    if (!wiped.ok) return wiped;
    const { worker, keys, dataBytes } = wiped.data;
    const imported = await runStep("rollback-import", context, () =>
      importKeys(hold, keys, ALL, worker, windowOf("rollback-import", dataBytes)),
    );
    if (!imported.ok) return imported;
    const verified = await runStep("rollback-verify", context, () =>
      verifyKeys(
        hold,
        keys,
        ALL,
        worker,
        backup.contentHash,
        windowOf("rollback-verify", dataBytes),
      ),
    );
    if (!verified.ok) return verified;
    deps.log.info("snapshot.rollback.done", { gameId, backupRevisionId: backup.revisionId });
    return OK;
  } catch (error) {
    // Anything that throws here is a failed rollback, never an escape that leaves the game launchable.
    deps.log.error("snapshot.rollback.threw", { gameId, error });
    return fail("INTERNAL", "The rollback failed unexpectedly.");
  } finally {
    await workers.dispose().catch(() => undefined);
  }
}

/**
 * A failed rollback: IMP_RECOVERY_FAILED, the game marked `needs_recovery` (in the lock manager first, then in the
 * database, so a launch is refused naming the backup), the journal left `rolling-back` for the next start-up and
 * "Retry recovery". The backup is never deleted.
 */
export function markNeedsRecovery(
  gameId: string,
  backup: Pick<Snapshot, "revisionId" | "createdAt">,
  cause: { code: ErrorCode; message: string },
  deps: Pick<TaskDeps, "repos" | "recovery" | "log">,
): { ok: false; code: ErrorCode; message: string } {
  deps.recovery.mark(gameId);
  try {
    if (deps.repos.games.get(gameId)) deps.repos.games.update(gameId, { needsRecovery: true });
  } catch (error) {
    // The mark in the lock manager stands, and the journal entry makes the next start roll back again.
    deps.log.error("snapshot.recovery.flag-failed", { gameId, error });
  }
  deps.log.error("snapshot.rollback.failed", {
    gameId,
    code: cause.code,
    backupRevisionId: backup.revisionId,
  });
  return {
    ok: false,
    code: "IMP_RECOVERY_FAILED",
    message: `The saves could not be put back. They are kept in ${backupName(backup)}; use "Retry recovery".`,
  };
}

/**
 * R5 to R8 of a restore or a delete, and the rollback when they fail. From the wipe on, the game is marked in the lock
 * manager, so whatever happens no launch or task gets in before the change committed or a rollback verified (a crash
 * leaves the journal entry, and the next start rolls back). Nothing here throws: an error in `change` is a failure
 * that rolls back, an error in the rollback a failed rollback.
 */
export async function changeOrRollBack(
  hold: QuiescentHold,
  journal: Journal,
  backup: Snapshot,
  deps: TaskDeps,
  change: () => Promise<Result<void, ErrorCode>>,
  onStep?: (point: FaultPoint) => void,
): Promise<Result<void, ErrorCode>> {
  const { gameId } = hold;
  deps.recovery.mark(gameId);
  let changed: Result<void, ErrorCode>;
  try {
    changed = await change();
  } catch (error) {
    deps.log.error("snapshot.change.threw", { gameId, error });
    changed = fail("INTERNAL", "Something went wrong while the saves were changed.");
  }
  if (changed.ok) {
    deps.recovery.clear(gameId);
    return changed;
  }
  deps.log.warn("snapshot.change.failed", { gameId, code: changed.code });
  const rolled = await rollBack(hold, journal, backup, deps, onStep);
  if (!rolled.ok) return markNeedsRecovery(gameId, backup, rolled, deps);
  try {
    journal.finish("failed");
  } catch (error) {
    // The data equals the backup, but the entry still says the rollback has not verified: keep the game refused.
    deps.log.error("snapshot.journal.finish-failed", { gameId, error });
    return markNeedsRecovery(
      gameId,
      backup,
      fail("INTERNAL", "The journal could not be closed."),
      deps,
    );
  }
  deps.recovery.clear(gameId);
  return { ok: false, code: changed.code, message: changed.message };
}

/** The scope of the snapshot's adapter, or "all"; an adapter this build does not have cannot be honored. */
export function adapterScopeOf(
  adapter: { id: string; version: string } | null,
): Result<FrameScope | null, ErrorCode> {
  if (adapter === null) return { ok: true, data: null };
  const known = ADAPTERS.find((a) => a.id === adapter.id && a.version === adapter.version);
  if (!known) {
    return fail(
      "INVALID_ARGUMENT",
      `The snapshot was made with the adapter ${adapter.id} ${adapter.version}, which this version of WGLauncher does not have.`,
    );
  }
  return { ok: true, data: adapterScope(known) };
}

/** Text naming a backup for messages (the UI shows it; no path). */
export const backupName = (backup: Pick<Snapshot, "revisionId" | "createdAt">) =>
  `the backup of ${backup.createdAt} (revision ${backup.revisionId})`;
