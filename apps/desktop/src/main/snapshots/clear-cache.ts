// "Clear cache" (PRD section 9, AC-16; architecture.md section 12): only while the game window is closed (a `task`
// lease, so a launch waits for it and an open window refuses it), after a native confirmation saying what goes and
// what stays. It clears the HTTP cache, the code caches and the shader cache, Cache Storage and service worker
// registrations of the game's session; localStorage, IndexedDB and cookies stay. `clearStorageData` without an
// `origin` reaches the partitioned keys of cross-site iframes too (open check 4, asserted in `e2e/delete.spec.ts`).
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { ConfirmSpec } from "../dialogs.js";
import type { Lease, LockRefusal } from "../games/locks.js";
import type { Logger } from "../log/logger.js";

/** The parts of an Electron `Session` the clear uses. */
export interface CacheSession {
  clearCache(): Promise<void>;
  clearCodeCaches(options: { urls?: string[] }): Promise<void>;
  clearStorageData(options: {
    storages: Array<"shadercache" | "cachestorage" | "serviceworkers">;
  }): Promise<void>;
}

export interface ClearCacheDeps {
  games: { get(id: string): { title: string } | null };
  locks: { acquire(gameId: string, kind: "task"): Promise<Lease | LockRefusal> };
  confirm(spec: ConfirmSpec): Promise<boolean>;
  session(gameId: string): CacheSession;
  log: Pick<Logger, "info" | "error">;
}

const REFUSED: Record<LockRefusal["code"], string> = {
  GAME_RUNNING: "Close the game before clearing its cache.",
  GAME_BUSY: "Another task for this game is running.",
  NEEDS_RECOVERY: "This game needs recovery first.",
  INTERNAL: "Something went wrong.",
};

export async function clearCache(
  gameId: string,
  deps: ClearCacheDeps,
): Promise<Result<Record<string, never>, ErrorCode>> {
  const game = deps.games.get(gameId);
  if (!game) return { ok: false, code: "NOT_FOUND", message: "The game is not in the library." };
  const lease = await deps.locks.acquire(gameId, "task");
  if (!("release" in lease)) {
    return { ok: false, code: lease.code, message: REFUSED[lease.code] };
  }
  try {
    const confirmed = await deps.confirm({
      title: "Clear cache?",
      message: `Clear the cache of "${game.title}"?`,
      detail:
        "Removed: downloaded files the game cached (HTTP cache, code and shader caches, Cache Storage) and its " +
        "service workers; the game downloads them again when it runs, so it needs the internet then. Kept: the " +
        "game's saves (localStorage and IndexedDB), its cookies, snapshots and backups.",
      confirmLabel: "Clear cache",
    });
    if (!confirmed) return { ok: false, code: "CANCELLED", message: "Nothing was cleared." };
    const ses = deps.session(gameId);
    try {
      await ses.clearCache();
      await ses.clearCodeCaches({});
      await ses.clearStorageData({ storages: ["shadercache", "cachestorage", "serviceworkers"] });
    } catch (error) {
      deps.log.error("game.clear-cache-failed", { gameId, error });
      return { ok: false, code: "INTERNAL", message: "The cache could not be cleared." };
    }
    deps.log.info("game.cache-cleared", { gameId });
    return { ok: true, data: {} };
  } finally {
    lease.release();
  }
}
