// A game's storage keys (save-transfer.md section 2) from what its windows recorded in `storage_targets`. The known
// keys are the top-level origins (the entry URL's and every top-level origin observed) plus every frame key observed
// under them: a frame of the same site is first-party storage, a cross-site frame is partitioned under its top-level
// site. The game keys an export covers are the top-level origins plus the frame keys the user confirmed (or an
// adapter declared). Keys are sorted by origin, then `topLevelSite` with `null` first, and numbered in that order: the
// manifest's `storageKeys` and its `data/<k>/` paths (snapshot-format.md section 4).
import type { StorageTarget } from "../db/repos/storage-targets.js";
import { siteOf } from "../policy/site.js";
import type { JobKey } from "./quiescent/layout.js";

export interface StorageKeyRef {
  origin: string;
  topLevelSite: string | null;
}

/** A frame key and the `storage_targets` rows it comes from (one per top-level origin of its site). */
export interface FrameKeyCandidate {
  key: StorageKeyRef;
  rows: StorageTarget[];
}

const sameKey = (a: StorageKeyRef, b: StorageKeyRef) =>
  a.origin === b.origin && a.topLevelSite === b.topLevelSite;

function compareKeys(a: StorageKeyRef, b: StorageKeyRef): number {
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  if (a.topLevelSite === b.topLevelSite) return 0;
  if (a.topLevelSite === null || b.topLevelSite === null) return a.topLevelSite === null ? -1 : 1;
  return a.topLevelSite < b.topLevelSite ? -1 : 1;
}

/** The top-level origins of a game: its entry URL's origin and every top-level origin observed. */
export function topOrigins(entryUrl: string, targets: readonly StorageTarget[]): string[] {
  return [...new Set([new URL(entryUrl).origin, ...targets.map((row) => row.topOrigin)])].sort();
}

/** Every frame key observed that is not one of the top-level keys, with its rows. */
export function frameKeyCandidates(
  entryUrl: string,
  targets: readonly StorageTarget[],
): FrameKeyCandidate[] {
  const tops = new Set(topOrigins(entryUrl, targets));
  const candidates: FrameKeyCandidate[] = [];
  for (const row of targets) {
    if (row.frameOrigin === row.topOrigin) continue;
    const topSite = siteOf(row.topOrigin);
    const key: StorageKeyRef =
      siteOf(row.frameOrigin) === topSite
        ? { origin: row.frameOrigin, topLevelSite: null }
        : { origin: row.frameOrigin, topLevelSite: topSite };
    // A first-party frame at a top-level origin shares that origin's storage.
    if (key.topLevelSite === null && tops.has(key.origin)) continue;
    const known = candidates.find((candidate) => sameKey(candidate.key, key));
    if (known) known.rows.push(row);
    else candidates.push({ key, rows: [row] });
  }
  return candidates.sort((a, b) => compareKeys(a.key, b.key));
}

/** Numbers the keys in manifest order. */
export function numberKeys(tops: readonly string[], frames: readonly StorageKeyRef[]): JobKey[] {
  const drafts = [
    ...tops.map((origin) => ({ origin, topLevelSite: null, role: "top" as const })),
    ...frames.map((key) => ({ ...key, role: "frame" as const })),
  ].sort(compareKeys);
  return drafts.map((draft, index) => ({ index, ...draft }));
}

/** Every known key of a game (backups, deletes and storage checks cover all of them). */
export function knownKeys(entryUrl: string, targets: readonly StorageTarget[]): JobKey[] {
  return numberKeys(
    topOrigins(entryUrl, targets),
    frameKeyCandidates(entryUrl, targets).map((candidate) => candidate.key),
  );
}

export { sameKey };
