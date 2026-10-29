// Restore of a snapshot into a game (save-transfer.md section 6, R1 to R8), with the backup first and the rollback on
// any failure from R5 on (AGENTS.md data-safety invariant 3: a failure never destroys existing saves).
//
// R1 validates the file fully in the snapshot worker (a stored row's file in place, an external file after a copy
// into `tmp/` with the size limit enforced while copying); a revision already stored is reused when its `contentHash`
// matches, otherwise IMP_REVISION_CONFLICT. R2 checks the keys against the game (key-check.ts) with the confirmed
// mapping, computes the wipe set (the snapshot's keys, mapped, plus every known key of the game) and the expected
// hash, and asks the user in one native confirmation that lists the mapping and the keys that could not be checked;
// no consent, nothing written. R3 takes the lock (the game window must be closed) and runs R2 again. R4 to R7 are
// restore-steps.ts. R8, in one transaction: an external file's row (kind `imported`), the game's base revision and the
// journal's `done`. Every step is journaled before it starts (journal.ts).
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FrameScope } from "@wg-launcher/exporters/wire";
import type { ErrorCode, Result } from "@wg-launcher/shared";
import { DEFAULT_LIMITS } from "@wg-launcher/snapshot/container";
import type { Snapshot } from "../db/repos/snapshots.js";
import type { Validated } from "../worker/client.js";
import { workerSlot } from "../worker/slot.js";
import type { FaultPoint } from "./faults.js";
import { beginJournal } from "./journal.js";
import {
  type CheckedKeys,
  checkStorageKeys,
  type KeyMapping,
  sameCheckedKeys,
  targetKeysOf,
} from "./key-check.js";
import { knownKeys, numberKeys, type StorageKeyRef, sameKey } from "./keys.js";
import { failureOf, holdQuiescentJob, type JobKey, type QuiescentHold } from "./quiescent/job.js";
import {
  ALL,
  adapterScopeOf,
  backupName,
  fail,
  importKeys,
  type PlannedKey,
  rollBack,
  runStep,
  type TaskDeps,
  verifyKeys,
  wipeKeys,
  writeBackup,
} from "./restore-steps.js";

export type { RestoreStep } from "./faults.js";

export type RestoreSource = { revisionId: string } | { file: string };

export interface RestoreRequest {
  gameId: string;
  source: RestoreSource;
  /** Origin by origin, as the user confirmed it (architecture.md section 6, `snapshot:import`). */
  mapping?: readonly KeyMapping[];
  /** Called once the lock is held (R3): the IPC handler then answers with a task id. */
  onLocked?(): void;
  /** Each real step as it starts. */
  onStep?(step: FaultPoint): void;
  signal?: AbortSignal;
}

export interface RestoreOutcome {
  revisionId: string;
  backupRevisionId: string;
  contentHash: string;
}

/** The plan of R2, compared again under the lock (R3). */
interface Plan {
  checked: CheckedKeys;
  /** The keys the backup covers and R5 wipes: the snapshot's keys (mapped) plus every known key of the game. */
  wipeSet: JobKey[];
  scope: FrameScope;
  selective: boolean;
}

/** `maxStorageKeys` (snapshot-format.md section 8): a backup holds at most this many keys. */
const MAX_STORAGE_KEYS = 32;

const keyText = (key: StorageKeyRef) =>
  key.topLevelSite === null ? key.origin : `${key.origin} (inside ${key.topLevelSite})`;

/** R2: the key check, the wipe set and the scope; nothing is written. */
function planRestore(
  gameId: string,
  validated: Validated,
  mapping: readonly KeyMapping[],
  deps: TaskDeps,
): Result<Plan, ErrorCode> {
  const game = deps.repos.games.get(gameId);
  if (!game) return fail("NOT_FOUND", "The game is not in the library.");
  const rows = deps.repos.storageTargets.listForGame(gameId);
  const checked = checkStorageKeys(
    validated.manifest.storageKeys,
    targetKeysOf(game.url, rows),
    mapping,
  );
  if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
  const known = knownKeys(game.url, rows);
  const union: Array<StorageKeyRef & { role: "top" | "frame" }> = [];
  for (const key of [...checked.data.keys, ...known]) {
    const same = union.find((other) => sameKey(other, key));
    if (same === undefined)
      union.push({ origin: key.origin, topLevelSite: key.topLevelSite, role: key.role });
    else if (key.role === "top") same.role = "top";
  }
  if (union.length > MAX_STORAGE_KEYS) {
    return fail(
      "IMP_BACKUP_FAILED",
      `This restore covers ${union.length} storage keys; a backup holds at most ${MAX_STORAGE_KEYS}, so nothing was changed.`,
    );
  }
  const tops = union
    .filter((k) => k.role === "top" && k.topLevelSite === null)
    .map((k) => k.origin);
  const frames = union.filter((k) => !(k.role === "top" && k.topLevelSite === null));
  const scope = adapterScopeOf(validated.manifest.adapter);
  if (!scope.ok) return scope;
  return {
    ok: true,
    data: {
      checked: checked.data,
      wipeSet: numberKeys(tops, frames),
      scope: scope.data ?? ALL,
      selective: scope.data !== null,
    },
  };
}

const samePlan = (a: Plan, b: Plan) =>
  sameCheckedKeys(a.checked, b.checked) &&
  a.wipeSet.length === b.wipeSet.length &&
  a.wipeSet.every((key, i) => sameKey(key, b.wipeSet[i] as StorageKeyRef));

/**
 * Copies an external file into `tmp/` (security.md section 8): a regular file only, opened without following a link,
 * and never more than `maxFileBytes`; validation, import and the final rename then use the private copy only.
 */
async function privateCopy(file: string, to: string): Promise<Result<void, ErrorCode>> {
  const info = await lstat(file).catch(() => null);
  if (info === null || !info.isFile())
    return fail("NOT_FOUND", "The chosen file is not a snapshot file.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    () => null,
  );
  if (handle === null) return fail("NOT_FOUND", "The chosen file cannot be read.");
  let copied = 0;
  const limit = DEFAULT_LIMITS.maxFileBytes;
  try {
    if (!(await handle.stat()).isFile())
      return fail("NOT_FOUND", "The chosen file is not a snapshot file.");
    await pipeline(
      handle.createReadStream(),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          copied += chunk.length;
          if (copied > limit) callback(Object.assign(new Error("too large"), { tooLarge: true }));
          else callback(null, chunk);
        },
      }),
      createWriteStream(to, { flags: "wx" }),
    );
    return { ok: true, data: undefined };
  } catch (error) {
    await rm(to, { force: true });
    if ((error as { tooLarge?: boolean }).tooLarge) {
      return fail("SNAP_FILE_TOO_LARGE", "The snapshot file is too large.");
    }
    return fail("INTERNAL", "The chosen file could not be copied.");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The text of the R2 confirmation: what is replaced, the backup, the mapping and the unchecked keys. */
function confirmation(
  title: string,
  validated: Validated,
  plan: Plan,
  mapping: readonly KeyMapping[],
) {
  const lines = [
    `The saves of "${title}" on this computer will be replaced by the snapshot of ${validated.manifest.createdAt}.`,
    "A backup of the current saves is made first and kept; if anything fails, they are restored from it.",
  ];
  if (validated.manifest.flushState === "unconfirmed") {
    lines.push(
      "The snapshot's flush is unconfirmed: the game may not have written everything before it was taken.",
    );
  }
  if (plan.selective) {
    lines.push(
      "Only the data the snapshot's adapter selects is replaced; other data of the game stays.",
    );
  }
  if (mapping.length > 0) {
    lines.push(
      `Storage keys are mapped: ${mapping.map((m) => (m.from === m.to ? `${m.from} kept as it is` : `${m.from} to ${m.to}`)).join("; ")}.`,
    );
  }
  if (plan.checked.unchecked.length > 0) {
    lines.push(
      `These iframe storage keys could not be checked against this game: ${plan.checked.unchecked.map(keyText).join("; ")}.`,
    );
  }
  return {
    title: "Restore snapshot?",
    message: `Restore a snapshot into "${title}"?`,
    detail: lines.join(" "),
    confirmLabel: plan.checked.unchecked.length > 0 ? "Restore anyway" : "Restore",
  };
}

export async function runRestore(
  request: RestoreRequest,
  deps: TaskDeps,
): Promise<Result<RestoreOutcome, ErrorCode>> {
  const { gameId, source } = request;
  const mapping = request.mapping ?? [];
  const { repos, log } = deps;
  const game = repos.games.get(gameId);
  if (!game) return fail("NOT_FOUND", "The game is not in the library.");
  const stored = "revisionId" in source ? repos.snapshots.findByRevision(source.revisionId) : null;
  if ("revisionId" in source && stored === null) {
    return fail("NOT_FOUND", "The snapshot is not stored.");
  }
  const journal = beginJournal(repos.restoreJournal, {
    id: deps.newId(),
    gameId,
    kind: "import",
    ...(stored ? { revisionId: stored.revisionId } : {}),
    step: "validate",
  });
  const context = {
    journal,
    ...(deps.faults ? { faults: deps.faults } : {}),
    ...(request.onStep ? { onStep: request.onStep } : {}),
  };
  const copy = "file" in source ? join(deps.paths.tmp, `${journal.id}.wgsnap.import`) : null;
  const workers = workerSlot(deps.startWorker, {});
  const signal = request.signal ?? new AbortController().signal;
  let hold: QuiescentHold | null = null;
  let committed = false;
  /** R1 to R4 changed nothing: the entry is closed and the copy removed. */
  const stopBeforeWipe = async (failure: { ok: false; code: ErrorCode; message: string }) => {
    journal.finish("failed");
    log.warn("snapshot.restore.failed", { gameId, code: failure.code, step: journal.entry().step });
    return failure;
  };
  try {
    // R1.
    const validatedStep = await runStep("validate", context, async () => {
      const path = copy ?? deps.fileOf((stored as Snapshot).path);
      if (copy !== null) {
        const copied = await privateCopy((source as { file: string }).file, copy);
        if (!copied.ok) return copied;
      }
      const worker = await workers.get(signal);
      if (worker === null) return failureOf(signal);
      const validated = await worker.validate(path);
      if (!validated.ok) return validated;
      const { revisionId, contentHash } = validated.data.manifest;
      const known = repos.snapshots.findByRevision(revisionId);
      if (
        (stored && stored.revisionId !== revisionId) ||
        (known && known.contentHash !== contentHash)
      ) {
        return fail(
          "IMP_REVISION_CONFLICT",
          "A different snapshot with the same revision is stored already, so this file was not restored.",
        );
      }
      if (!stored) journal.revision(revisionId);
      return { ok: true, data: { validated: validated.data, worker } };
    });
    if (!validatedStep.ok) return await stopBeforeWipe(validatedStep);
    const { validated, worker } = validatedStep.data;

    // R2.
    const planned = await runStep("plan", context, async () => {
      const plan = planRestore(gameId, validated, mapping, deps);
      if (!plan.ok) return plan;
      const keys: PlannedKey[] = plan.data.checked.keys;
      const expected = await worker.expected(
        keys.map(({ from, index, origin, topLevelSite, role }) => ({
          from,
          to: index,
          origin,
          topLevelSite,
          role,
        })),
      );
      if (!expected.ok) return expected;
      const confirmed = await deps.confirm(confirmation(game.title, validated, plan.data, mapping));
      if (!confirmed) return fail("CANCELLED", "Nothing was restored.");
      return { ok: true, data: { plan: plan.data, expected: expected.data } };
    });
    if (!planned.ok) return await stopBeforeWipe(planned);
    const { plan, expected } = planned.data;

    // R3.
    const locked = await runStep("lock", context, async () => {
      const held = await holdQuiescentJob(gameId, "task", deps.job, { signal });
      if (!held.ok) return held;
      hold = held.data;
      const again = planRestore(gameId, validated, mapping, deps);
      if (!again.ok) return again;
      if (!samePlan(plan, again.data)) {
        return fail(
          "IMP_PLAN_CHANGED",
          "The game recorded new storage while you confirmed, so nothing was restored. Try again.",
        );
      }
      request.onLocked?.();
      return { ok: true, data: held.data };
    });
    if (!locked.ok) return await stopBeforeWipe(locked);
    const held = locked.data;

    // R4.
    const backupRevisionId = deps.newId();
    journal.backup(backupRevisionId);
    const backedUp = await runStep("backup", context, () =>
      writeBackup(held, plan.wipeSet, backupRevisionId, deps),
    );
    if (!backedUp.ok) return await stopBeforeWipe(backedUp);
    const backup = backedUp.data;

    // R5 to R8; any failure rolls back.
    const keys: PlannedKey[] = plan.checked.keys;
    const changed = await (async (): Promise<Result<void, ErrorCode>> => {
      const wiped = await runStep("wipe", context, () =>
        wipeKeys(held, plan.wipeSet, plan.selective ? plan.scope : "all", worker),
      );
      if (!wiped.ok) return wiped;
      const imported = await runStep("import", context, () =>
        importKeys(held, keys, plan.scope, worker),
      );
      if (!imported.ok) return imported;
      const verified = await runStep("verify", context, () =>
        verifyKeys(held, keys, plan.scope, worker, expected),
      );
      if (!verified.ok) return verified;
      return runStep("commit", context, async () => {
        const { revisionId } = validated.manifest;
        const dir = join(deps.paths.snapshots, gameId);
        const finalPath = join(dir, `${revisionId}.wgsnap`);
        const adopt = copy !== null && repos.snapshots.findByRevision(revisionId) === null;
        if (adopt) {
          await mkdir(dir, { recursive: true });
          await rename(copy as string, finalPath);
        }
        try {
          deps.transaction(() => {
            if (adopt) {
              const { manifest } = validated;
              repos.snapshots.addIfAbsent({
                revisionId,
                gameId,
                kind: "imported",
                manifestGameId: manifest.gameId,
                parentRevisionId: manifest.parentRevisionId,
                createdAt: manifest.createdAt,
                deviceId: manifest.deviceId,
                exporterId: manifest.exporter.id,
                exporterVersion: manifest.exporter.version,
                ...(manifest.adapter
                  ? { adapterId: manifest.adapter.id, adapterVersion: manifest.adapter.version }
                  : {}),
                contentHash: manifest.contentHash,
                sizeBytes: validated.sizeBytes,
                path: `snapshots/${gameId}/${revisionId}.wgsnap`,
                flushState: manifest.flushState,
              });
            }
            // The partition's data now descends from the restored revision (save-transfer.md, "Revision parents").
            repos.games.update(gameId, { baseRevisionId: revisionId });
            journal.finish("done");
          });
        } catch (error) {
          if (adopt) await rm(finalPath, { force: true });
          log.error("snapshot.restore.commit-failed", { gameId, error });
          return fail("INTERNAL", "The restore could not be recorded.");
        }
        committed = true;
        return { ok: true, data: undefined };
      });
    })();

    if (changed.ok) {
      log.info("snapshot.restore.done", {
        gameId,
        revisionId: validated.manifest.revisionId,
        backupRevisionId,
        keys: keys.length,
        mapped: plan.checked.mapped,
      });
      return {
        ok: true,
        data: {
          revisionId: validated.manifest.revisionId,
          backupRevisionId,
          contentHash: validated.manifest.contentHash,
        },
      };
    }
    log.warn("snapshot.restore.failed", { gameId, code: changed.code, step: journal.entry().step });
    const rolled = await rollBack(held, journal, backup, deps, request.onStep);
    if (rolled.ok) {
      journal.finish("failed");
      return {
        ok: false,
        code: changed.code,
        message: `${changed.message} The saves were put back from ${backupName(backup)}.`,
      };
    }
    return markNeedsRecovery(gameId, backup, rolled, deps);
  } finally {
    await workers.dispose();
    if (copy !== null && !committed) await rm(copy, { force: true });
    (hold as QuiescentHold | null)?.release();
    if (hold !== null) deps.afterChange?.(gameId);
  }
}

/**
 * A failed rollback: IMP_RECOVERY_FAILED, the game marked `needs_recovery` (in the lock manager and the database, so a
 * launch is refused naming the backup), the journal left `rolling-back` for the next start-up and "Retry recovery".
 * The backup is never deleted.
 */
export function markNeedsRecovery(
  gameId: string,
  backup: Pick<Snapshot, "revisionId" | "createdAt">,
  cause: { code: ErrorCode; message: string },
  deps: Pick<TaskDeps, "repos" | "recovery" | "log">,
): { ok: false; code: ErrorCode; message: string } {
  deps.recovery.mark(gameId);
  if (deps.repos.games.get(gameId)) deps.repos.games.update(gameId, { needsRecovery: true });
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
