// The `library:*` channels (architecture.md sections 6, 11 and 12): list, add, edit, remove from library and the
// orphan list. Cards carry recorded state only (badges through `badgesFor`). Every question to the user is a native
// dialog whose text is written here; a file is chosen in a native dialog, so no path crosses IPC.

import type { Card, IpcCode, Result } from "@wg-launcher/shared";
import { MAX_TITLE_CHARS } from "@wg-launcher/shared";
import { LAUNCHER_ORIGIN } from "../../app-protocol.js";
import type { Game } from "../../db/repos/games.js";
import { badgesFor } from "../../policy/badges.js";
import { checkEntryUrl } from "../../policy/url-rules.js";
import type { Handlers } from "../register.js";
import { type HandlerContext, type Library, READ_ONLY } from "./context.js";

type Fail = { ok: false; code: IpcCode; message: string };
const fail = (code: IpcCode, message: string): Fail => ({ ok: false, code, message });
const NOT_FOUND = fail("NOT_FOUND", "The game is not in the library.");

/**
 * The exporter whose round trip would back "Export verified". No exporter exists in this build (Task 13 adds it), so
 * the badge cannot appear: `badgesFor` never matches an empty version.
 */
const RUNNING_EXPORTER_VERSION = "";

/** The host name, cut to the title limit (a host can be longer than 200 characters). */
function defaultTitle(href: string): string {
  return [...new URL(href).hostname].slice(0, MAX_TITLE_CHARS).join("");
}

export function cardOf(library: Library, game: Game): Card {
  const { repos, runtime } = library;
  const check = repos.storageChecks.get(game.id);
  const verified = repos.snapshots
    .listForGame(game.id, game.baseRevisionId)
    .flatMap((s) =>
      s.verifiedAt !== null && s.verifiedExporterVersion !== null
        ? [s.verifiedExporterVersion]
        : [],
    );
  return {
    gameId: game.id,
    title: game.title,
    url: game.url,
    coverUrl: game.coverPath === null ? null : `${LAUNCHER_ORIGIN}/covers/${game.coverPath}`,
    badges: badgesFor({
      supportMode: game.supportMode,
      lastCheck: check ? { hasData: check.hasData, checkedAt: check.checkedAt } : null,
      verifiedExporterVersions: verified,
      runningExporterVersion: RUNNING_EXPORTER_VERSION,
    }),
    lastLaunchedAt: game.lastLaunchedAt,
    playtimeMs: repos.playSessions.totalActiveMs(game.id),
    state: runtime.state(game.id),
    needsRecovery: game.needsRecovery,
  };
}

export function libraryHandlers(
  context: HandlerContext,
): Pick<
  Handlers,
  "library:list" | "library:add" | "library:update" | "library:remove" | "library:orphans"
> {
  const { dialogs, covers, flavor, log } = context;

  /** Deletes a cover file that is no longer used; a failure is logged, never thrown (the row is already right). */
  const dropCover = async (name: string | null) => {
    if (name === null) return;
    await covers
      .remove(name)
      .catch((error: unknown) => log.warn("library.cover-remove-failed", { error }));
  };

  return {
    async "library:list"() {
      const library = context.library;
      if (!library) {
        return {
          ok: true,
          data: { library: "read-only", reason: context.readOnlyReason ?? READ_ONLY.message },
        };
      }
      const cards = library.repos.games.list().map((game) => cardOf(library, game));
      return {
        ok: true,
        data: { library: "ready", cards, canCreateShortcuts: context.shortcuts.supported },
      };
    },

    async "library:add"({ url, title }) {
      const library = context.library;
      if (!library) return READ_ONLY;
      // Not trimmed here: the renderer trims visibly before sending (architecture.md section 12).
      const checked = checkEntryUrl(url, flavor);
      if (!checked.ok) {
        return fail(
          "URL_NOT_ALLOWED",
          flavor === "prod"
            ? "Only https:// addresses can be added."
            : "Only https:// addresses can be added (and, in this build, http://localhost and http://127.0.0.1).",
        );
      }
      const href = checked.data;
      const same = library.repos.games.list().filter((game) => game.url === href);
      if (same.length > 0) {
        const where = same.length === 1 ? `as "${same[0]?.title}"` : `${same.length} times`;
        const confirmed = await dialogs.confirm({
          title: "Already in the library",
          message: `This address is already in your library ${where}.`,
          detail:
            "A second entry gets its own game id and its own saves; it shares nothing with the first one. Entries are never merged.",
          confirmLabel: "Add a second entry",
        });
        if (!confirmed) return fail("CANCELLED", "Nothing was added.");
      }
      const game = library.repos.games.insert({
        id: context.newId(),
        url: href,
        title: title ?? defaultTitle(href),
      });
      log.info("library.added", { gameId: game.id, sameUrl: same.length });
      return { ok: true, data: cardOf(library, game) };
    },

    async "library:update"({ gameId, title, cover }) {
      const library = context.library;
      if (!library) return READ_ONLY;
      const game = library.repos.games.get(gameId);
      if (!game) return NOT_FOUND;

      let coverPath: string | null | undefined;
      if (cover === "remove") coverPath = null;
      if (cover === "pick") {
        const file = await dialogs.openFile({
          title: "Choose a cover image",
          filters: [
            { name: "Images (PNG, JPEG, WebP)", extensions: ["png", "jpg", "jpeg", "webp"] },
          ],
        });
        if (file === null) return fail("CANCELLED", "No file was chosen.");
        const copied = await covers.set(gameId, file);
        if (!copied.ok) return copied;
        coverPath = copied.data;
      }

      // Read again after the dialog and the copy: another update may have changed the cover meanwhile. The read and
      // the update are synchronous, so nothing runs between them, and the file removed below is the one the row
      // held when this update replaced it.
      const previous = library.repos.games.get(gameId)?.coverPath ?? null;
      const updated = library.repos.games.update(gameId, {
        ...(title === undefined ? {} : { title }),
        ...(coverPath === undefined ? {} : { coverPath }),
      });
      if (!updated) {
        // Removed while the file dialog was open: the new copy belongs to nobody.
        await dropCover(coverPath ?? null);
        return NOT_FOUND;
      }
      if (coverPath !== undefined && previous !== coverPath) await dropCover(previous);
      log.info("library.updated", { gameId, title: title !== undefined, cover: cover ?? null });
      return { ok: true, data: cardOf(library, updated) };
    },

    async "library:remove"({ gameId }): Promise<Result<Record<string, never>, IpcCode>> {
      const library = context.library;
      if (!library) return READ_ONLY;
      const game = library.repos.games.get(gameId);
      if (!game) return NOT_FOUND;
      // A task lease keeps the game from launching while the dialog is open; an open window refuses the removal.
      const lease = await library.locks.acquire(gameId, "task");
      if (!("release" in lease)) {
        return lease.code === "GAME_RUNNING"
          ? fail("GAME_RUNNING", "Close the game before removing it from the library.")
          : fail(lease.code, "The game is busy. Try again when it is done.");
      }
      try {
        const confirmed = await dialogs.confirm({
          title: "Remove from library?",
          message: `Remove "${game.title}" from the library?`,
          detail:
            "Removed: the card with its title, cover, window position and playtime. " +
            "Kept: the game's snapshots and backups, and whatever the game saved on this computer, which stays " +
            'there and is listed under "Data of removed games" in Settings. Adding the address again creates a new, ' +
            "empty entry.",
          confirmLabel: "Remove from library",
        });
        if (!confirmed) return fail("CANCELLED", "The game was not removed.");
        if (!library.repos.games.remove(gameId)) return NOT_FOUND;
        await dropCover(game.coverPath);
        log.info("library.removed", { gameId });
        return { ok: true, data: {} };
      } finally {
        lease.release();
      }
    },

    async "library:orphans"() {
      const library = context.library;
      if (!library) return READ_ONLY;
      const orphans = library.repos.orphans
        .list()
        .map(({ gameId, title, url, removedAt }) => ({ gameId, title, url, removedAt }));
      return { ok: true, data: { orphans } };
    },
  };
}
