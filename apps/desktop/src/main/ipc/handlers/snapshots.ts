// The `snapshot:*` channels of this task (architecture.md section 6): export, list and save as. An export answers
// with its task id as soon as the game's lock is held (a refusal before that, such as GAME_RUNNING for an open
// window, AC-11, is the call's own result); its steps, measured bytes and outcome follow as `task:progress` events,
// none of them before that reply,
// a failure with its code and a short message (Review Focus 5: the real error is shown). Rows never carry a file
// path, and "save as" chooses the destination in a native dialog in main.
import type { ErrorCode, Result, SnapshotRow, TaskProgressEvent } from "@wg-launcher/shared";
import type { Snapshot } from "../../db/repos/snapshots.js";
import type { ExportStep } from "../../snapshots/export.js";
import type { Handlers } from "../register.js";
import { type HandlerContext, READ_ONLY } from "./context.js";

const NOT_FOUND = {
  ok: false,
  code: "NOT_FOUND",
  message: "The game is not in the library.",
} as const;

export function toSnapshotRow(snapshot: Snapshot): SnapshotRow {
  return {
    revisionId: snapshot.revisionId,
    gameId: snapshot.gameId,
    kind: snapshot.kind,
    createdAt: snapshot.createdAt,
    parentRevisionId: snapshot.parentRevisionId,
    exporter: { id: snapshot.exporterId, version: snapshot.exporterVersion },
    adapter:
      snapshot.adapterId !== null && snapshot.adapterVersion !== null
        ? { id: snapshot.adapterId, version: snapshot.adapterVersion }
        : null,
    contentHash: snapshot.contentHash,
    sizeBytes: snapshot.sizeBytes,
    flushState: snapshot.flushState,
    verifiedAt: snapshot.verifiedAt,
    addedAt: snapshot.addedAt,
  };
}

/** A file name from the title and the date: letters, digits, spaces, dots, dashes and underscores only. */
function fileName(title: string, createdAt: string): string {
  const base =
    title
      .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
      .trim()
      .slice(0, 80) || "snapshot";
  return `${base} ${createdAt.slice(0, 10)}.wgsnap`;
}

export function snapshotHandlers(
  context: HandlerContext,
): Pick<Handlers, "snapshot:export" | "snapshot:list" | "snapshot:saveAs"> {
  return {
    async "snapshot:export"({ gameId, frameKeys }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      if (!library.repos.games.get(gameId)) return NOT_FOUND;
      const taskId = context.newId();
      let step: ExportStep = "lock";
      // Events wait until the reply with the task id has gone out, so a page that keeps only the tasks it knows
      // drops none of them.
      let replied = false;
      const held: TaskProgressEvent[] = [];
      const send = (event: Partial<TaskProgressEvent> & Pick<TaskProgressEvent, "status">) => {
        const full: TaskProgressEvent = { taskId, gameId, kind: "export", step, ...event };
        if (replied) snapshots.sendProgress(full);
        else held.push(full);
      };
      const locked = Promise.withResolvers<null>();
      const done = snapshots.export(gameId, {
        ...(frameKeys ? { frameKeys } : {}),
        onLocked: () => locked.resolve(null),
        onProgress: (progress) => {
          step = progress.step;
          send({
            status: "running",
            ...(progress.bytesDone === undefined ? {} : { bytesDone: progress.bytesDone }),
          });
        },
      });
      const first: Result<unknown, ErrorCode> | null = await Promise.race([locked.promise, done]);
      if (first !== null && !first.ok) return first;
      // The reply is sent when this handler's promise settles; the held events follow on the next turn.
      setImmediate(() => {
        replied = true;
        for (const event of held.splice(0)) snapshots.sendProgress(event);
      });
      void done.then(
        (result) =>
          result.ok
            ? send({ status: "done" })
            : send({ status: "failed", code: result.code, message: result.message.slice(0, 512) }),
        (error: unknown) => {
          context.log.error("snapshot.export.threw", { gameId, error });
          send({ status: "failed", code: "INTERNAL", message: "Something went wrong." });
        },
      );
      return { ok: true, data: { taskId } };
    },

    async "snapshot:list"({ gameId }) {
      const library = context.library;
      if (!library) return READ_ONLY;
      const game = library.repos.games.get(gameId);
      if (!game) return NOT_FOUND;
      const rows = library.repos.snapshots.listForGame(gameId, game.baseRevisionId);
      return { ok: true, data: { snapshots: rows.map(toSnapshotRow) } };
    },

    async "snapshot:saveAs"({ gameId, revisionId }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      const game = library.repos.games.get(gameId);
      if (!game) return NOT_FOUND;
      const snapshot = library.repos.snapshots
        .listForGame(gameId, game.baseRevisionId)
        .find((row) => row.revisionId === revisionId);
      if (!snapshot) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "The snapshot is not stored for this game.",
        };
      }
      const destination = await context.dialogs.saveFile({
        title: "Save snapshot",
        defaultPath: fileName(game.title, snapshot.createdAt),
        filters: [{ name: "WGLauncher snapshot", extensions: ["wgsnap"] }],
      });
      if (destination === null) return { ok: true, data: { saved: false } };
      try {
        await snapshots.copy(snapshots.fileOf(snapshot.path), destination);
      } catch (error) {
        context.log.error("snapshot.save-as-failed", { gameId, error });
        return { ok: false, code: "INTERNAL", message: "The snapshot could not be saved there." };
      }
      context.log.info("snapshot.saved-as", { gameId, revisionId });
      return { ok: true, data: { saved: true } };
    },
  };
}
