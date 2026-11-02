// Storage keys a game uses (architecture.md section 5, save-transfer.md section 2): every committed navigation of an
// http or https frame records `(top-level origin, frame origin)` in `storage_targets`. The main process is the only
// writer of the database (AGENTS.md data-safety invariant 9).

import type { WebContents } from "electron";
import type { StorageKey } from "../db/repos/storage-targets.js";
import type { Logger } from "../log/logger.js";

/** The origin of an http or https URL, or null for everything else (about:, data:, blob:, file:, garbage). */
function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The storage key of a frame at `frameUrl` under a top-level page at `topUrl`, or null when either is not web. */
export function storageKeyOf(
  topUrl: string,
  frameUrl: string,
): { topOrigin: string; frameOrigin: string } | null {
  const topOrigin = webOrigin(topUrl);
  const frameOrigin = webOrigin(frameUrl);
  return topOrigin && frameOrigin ? { topOrigin, frameOrigin } : null;
}

/**
 * Records the storage keys of `contents` for `gameId`. Each key is written once per window (the row's
 * `first_seen_at` and `last_seen_at` are about the key, not about every navigation, and writes are synchronous).
 */
export function recordFrames(
  contents: Pick<WebContents, "on" | "mainFrame">,
  gameId: string,
  repo: { markSeen(key: StorageKey): void },
  log: Logger,
): void {
  const seen = new Set<string>();
  contents.on(
    "did-frame-navigate",
    (_event, url, _code, _status, isMainFrame: boolean, _processId, _routingId) => {
      const topUrl = isMainFrame ? url : (contents.mainFrame?.url ?? "");
      const key = storageKeyOf(topUrl, url);
      if (!key) return;
      const id = `${key.topOrigin} ${key.frameOrigin}`;
      if (seen.has(id)) return;
      seen.add(id);
      try {
        repo.markSeen({ gameId, ...key });
      } catch (error) {
        seen.delete(id);
        log.error("game.storage-target-failed", { gameId, error });
      }
    },
  );
}
