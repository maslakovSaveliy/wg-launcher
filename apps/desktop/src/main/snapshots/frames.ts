// The frames the export dialog offers (save-transfer.md section 6, "Export", and its open question on frame keys):
// every frame key of the game outside its top-level keys that its adapter does not declare, each with the remembered
// choice (`in_export`) and what the frame holds now. What it holds is read in a quiescent window under a `task`
// lease, like the storage check (counts and usage numbers only, never key names, database names or values), because
// no per-key result is recorded. An open game window refuses it with GAME_RUNNING, as the export itself does (AC-11).
import type { FrameInventory } from "@wg-launcher/exporters/wire";
import type { ErrorCode, FrameSummary, Result } from "@wg-launcher/shared";
import type { StorageTarget } from "../db/repos/storage-targets.js";
import { workerSlot } from "../worker/slot.js";
import { adapterFor, type SnapshotDeps } from "./export.js";
import { frameKeyCandidates, knownKeys, type StorageKeyRef, sameKey } from "./keys.js";
import { failureOf, runQuiescentJob } from "./quiescent/job.js";

export interface FrameChoice {
  key: StorageKeyRef;
  inExport: boolean;
}

/** The frame keys outside the top-level keys, without those the adapter declares (every export covers them). */
export function frameChoices(
  entryUrl: string,
  targets: readonly StorageTarget[],
  adapter: { storage: { frameKeys: readonly StorageKeyRef[] } } | null,
): FrameChoice[] {
  const declared = adapter?.storage.frameKeys ?? [];
  return frameKeyCandidates(entryUrl, targets)
    .filter((candidate) => !declared.some((key) => sameKey(key, candidate.key)))
    .map((candidate) => ({
      key: candidate.key,
      inExport: candidate.rows.some((row) => row.inExport),
    }));
}

/** Counts and usage numbers of one frame; IndexedDB usage only where Chromium reports it. */
export function frameSummary(choice: FrameChoice, inventory: FrameInventory): FrameSummary {
  const indexedDb = inventory.usageDetails?.indexedDB;
  return {
    origin: choice.key.origin,
    topLevelSite: choice.key.topLevelSite,
    inExport: choice.inExport,
    localStorageItems: inventory.localStorageItems,
    databases: inventory.databases.length,
    indexedDbBytes: typeof indexedDb === "number" ? indexedDb : null,
  };
}

export async function listFrames(
  gameId: string,
  deps: SnapshotDeps,
): Promise<Result<FrameSummary[], ErrorCode>> {
  const game = deps.repos.games.get(gameId);
  if (!game) return { ok: false, code: "NOT_FOUND", message: "The game is not in the library." };
  const targets = deps.repos.storageTargets.listForGame(gameId);
  const choices = frameChoices(game.url, targets, adapterFor(game.url));
  if (choices.length === 0) return { ok: true, data: [] };
  const workers = workerSlot(deps.startWorker, {});
  const summaries: FrameSummary[] = [];
  try {
    return await runQuiescentJob<FrameSummary[]>(
      gameId,
      {
        direction: "export",
        lock: "task",
        // A partitioned frame is reached under its top-level page, so the window visits every known key.
        keys: knownKeys(game.url, targets),
        async runFrames(frames, context) {
          const worker = await workers.get(context.signal);
          if (worker === null) return failureOf(context.signal);
          for (const frame of frames) {
            const choice = choices.find((c) => sameKey(c.key, frame.key));
            if (!choice) continue;
            const inventory = await worker.inventory(frame.port);
            if (!inventory.ok) return inventory;
            summaries.push(frameSummary(choice, inventory.data));
          }
          return { ok: true, data: undefined };
        },
        async commit(context) {
          if (context.signal.aborted) return failureOf(context.signal);
          context.committed();
          return { ok: true, data: summaries };
        },
        async discard() {},
      },
      deps.job,
    );
  } finally {
    await workers.dispose();
  }
}
