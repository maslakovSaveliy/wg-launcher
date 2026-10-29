// The storage-key check of a restore (save-transfer.md section 2, "Changed keys", AC-24), restore step R2 and again
// under the lock in R3. Pure: the snapshot's keys, what the target game recorded, and the mapping the user
// confirmed, origin by origin. After the mapping every key is checked:
// - a `top` key's origin must be a top-level origin of the target (its entry URL's or one observed);
// - a partitioned key's `topLevelSite` must be the site of such an origin, and so must a first-party frame key's
//   own site;
// - a `frame` key's origin must be a frame origin observed under a top-level origin of that site. If the target
//   observed frames there but not this origin (the iframe moved), it is a mismatch, unless the user mapped the
//   origin to itself (kept deliberately); if it observed none there yet, the key is unchecked and the user is asked.
// A mapped key's `topLevelSite` becomes the site of the mapped top-level origin. The checked keys are sorted again
// and renumbered (snapshot-format.md sections 4 and 5); each remembers its manifest index (`from`).

import { siteOf } from "../policy/site.js";
import { type StorageKeyRef, sameKey } from "./keys.js";
import type { JobKey } from "./quiescent/layout.js";

export interface ManifestKey extends StorageKeyRef {
  role: "top" | "frame";
}

/** One origin of the snapshot and the origin its storage goes to in the target. */
export interface KeyMapping {
  from: string;
  to: string;
}

/** What the target game recorded (`storage_targets`) and its entry URL's origin. */
export interface TargetKeys {
  topOrigins: readonly string[];
  /** Frames observed under a top-level origin (a frame at its own top-level origin is not listed). */
  frames: readonly { topOrigin: string; frameOrigin: string }[];
}

/** A key after the mapping: its new manifest index and the index it had in the snapshot. */
export interface CheckedKey extends JobKey {
  from: number;
}

export interface CheckedKeys {
  keys: CheckedKey[];
  /** Frame keys the target has no observations for yet: listed in the confirmation (after the mapping). */
  unchecked: StorageKeyRef[];
  /** True when a mapping was applied; the expected hash is then the mapped one (snapshot-format.md section 5). */
  mapped: boolean;
}

export interface KeyMismatch {
  /** The snapshot key, as the snapshot names it. */
  key: StorageKeyRef;
  /** The target keys it was compared with (origins, or frame origins observed there). */
  comparedWith: string[];
}

export type KeyCheckFailure =
  | { ok: false; code: "IMP_STORAGE_KEY_MISMATCH"; message: string; mismatches: KeyMismatch[] }
  | { ok: false; code: "INVALID_ARGUMENT"; message: string; mismatches: [] };

export type KeyCheck = { ok: true; data: CheckedKeys } | KeyCheckFailure;

/** The target keys from the entry URL and the game's `storage_targets` rows. */
export function targetKeysOf(
  entryUrl: string,
  rows: readonly { topOrigin: string; frameOrigin: string }[],
): TargetKeys {
  const topOrigins = [...new Set([new URL(entryUrl).origin, ...rows.map((r) => r.topOrigin)])];
  return {
    topOrigins: topOrigins.sort(),
    frames: rows
      .filter((row) => row.frameOrigin !== row.topOrigin)
      .map(({ topOrigin, frameOrigin }) => ({ topOrigin, frameOrigin })),
  };
}

const isOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
};

function compareKeys(a: StorageKeyRef, b: StorageKeyRef): number {
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  if (a.topLevelSite === b.topLevelSite) return 0;
  if (a.topLevelSite === null || b.topLevelSite === null) return a.topLevelSite === null ? -1 : 1;
  return a.topLevelSite < b.topLevelSite ? -1 : 1;
}

const nameOf = (key: StorageKeyRef) =>
  key.topLevelSite === null ? key.origin : `${key.origin} under ${key.topLevelSite}`;

const invalid = (message: string): KeyCheckFailure => ({
  ok: false,
  code: "INVALID_ARGUMENT",
  message,
  mismatches: [],
});

export function checkStorageKeys(
  manifestKeys: readonly ManifestKey[],
  target: TargetKeys,
  mapping: readonly KeyMapping[] = [],
): KeyCheck {
  const origins = new Set(manifestKeys.map((key) => key.origin));
  const to = new Map<string, string>();
  for (const { from, to: destination } of mapping) {
    if (!isOrigin(from) || !isOrigin(destination)) {
      return invalid("A storage-key mapping must map an http(s) origin to an http(s) origin.");
    }
    if (!origins.has(from)) return invalid(`The snapshot has no storage key of ${from}.`);
    if (to.has(from)) return invalid(`${from} is mapped twice.`);
    to.set(from, destination);
  }
  // The site of each mapped top-level origin of the snapshot, for its partitioned keys.
  const siteMap = new Map<string, string>();
  for (const key of manifestKeys) {
    const destination = to.get(key.origin);
    if (key.role === "top" && key.topLevelSite === null && destination !== undefined) {
      const site = siteOf(key.origin);
      const mappedSite = siteOf(destination);
      if (siteMap.has(site) && siteMap.get(site) !== mappedSite) {
        return invalid(`The top-level origins of ${site} are mapped to different sites.`);
      }
      siteMap.set(site, mappedSite);
    }
  }

  const topSites = new Set(target.topOrigins.map((origin) => siteOf(origin)));
  const mismatches: KeyMismatch[] = [];
  const unchecked: StorageKeyRef[] = [];
  const drafts: Omit<CheckedKey, "index">[] = [];
  for (const [from, key] of manifestKeys.entries()) {
    const origin = to.get(key.origin) ?? key.origin;
    const topLevelSite =
      key.topLevelSite === null ? null : (siteMap.get(key.topLevelSite) ?? key.topLevelSite);
    const mapped: StorageKeyRef = { origin, topLevelSite };
    const original: StorageKeyRef = { origin: key.origin, topLevelSite: key.topLevelSite };
    drafts.push({ from, origin, topLevelSite, role: key.role });
    const site = topLevelSite ?? siteOf(origin);
    if (key.role === "top" && topLevelSite === null) {
      if (!target.topOrigins.includes(origin)) {
        mismatches.push({ key: original, comparedWith: [...target.topOrigins] });
      }
      continue;
    }
    if (!topSites.has(site)) {
      mismatches.push({ key: original, comparedWith: [...target.topOrigins] });
      continue;
    }
    if (key.role !== "frame") continue;
    const observed = [
      ...new Set(
        target.frames
          .filter((row) => siteOf(row.topOrigin) === site && row.frameOrigin !== row.topOrigin)
          .map((row) => row.frameOrigin),
      ),
    ].sort();
    if (observed.length === 0) unchecked.push(mapped);
    else if (!observed.includes(origin) && to.get(key.origin) !== key.origin) {
      mismatches.push({ key: original, comparedWith: observed });
    }
  }

  const sorted = [...drafts].sort(compareKeys);
  if (sorted.some((key, i) => i > 0 && sameKey(key, sorted[i - 1] as StorageKeyRef))) {
    return {
      ok: false,
      code: "IMP_STORAGE_KEY_MISMATCH",
      message: "The mapping puts two storage keys of the snapshot on one storage key.",
      mismatches: [],
    };
  }
  if (mismatches.length > 0) {
    const what = mismatches
      .map((m) => `${nameOf(m.key)} (compared with ${m.comparedWith.join(", ") || "nothing"})`)
      .join("; ");
    return {
      ok: false,
      code: "IMP_STORAGE_KEY_MISMATCH",
      message: `The snapshot's storage keys do not match this game: ${what}.`,
      mismatches,
    };
  }
  return {
    ok: true,
    data: {
      keys: sorted.map((key, index) => ({ index, ...key })),
      unchecked: unchecked.sort(compareKeys),
      mapped: mapping.length > 0,
    },
  };
}

/** Whether R2 under the lock (R3) found the same plan the user confirmed. */
export function sameCheckedKeys(a: CheckedKeys, b: CheckedKeys): boolean {
  const same = (x: readonly StorageKeyRef[], y: readonly StorageKeyRef[]) =>
    x.length === y.length && x.every((key, i) => sameKey(key, y[i] as StorageKeyRef));
  return (
    same(a.keys, b.keys) &&
    a.keys.every((key, i) => key.from === b.keys[i]?.from && key.role === b.keys[i]?.role) &&
    same(a.unchecked, b.unchecked)
  );
}
