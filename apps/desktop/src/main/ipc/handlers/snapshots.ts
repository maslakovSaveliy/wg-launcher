// The snapshot channels (architecture.md section 6): export, import (restore), verify, "Retry recovery", list, save as,
// and the data deletes (`game:deleteSaves`, `library:deleteOrphanData`, `game:clearCache`). A task answers with its
// task id as soon as the game's lock is held (a refusal before that, such as GAME_RUNNING for an open window, AC-11,
// a key mismatch or a declined confirmation, is the call's own result); its steps, measured bytes and outcome follow
// as `task:progress` events, none of them before that reply, a failure with its code and a short message (Review
// Focus 5: the real error is shown). Rows never carry a file path; files are chosen in native dialogs in main.
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

type TaskKind = TaskProgressEvent["kind"];
type Step = TaskProgressEvent["step"];

/**
 * Starts a task and answers with its id once the game's lock is held; a refusal before that is the call's own result.
 * Its steps, measured bytes and outcome follow as `task:progress` events, none of them before that reply (they are
 * held until the turn after it), a failure with its code and a short message.
 */
async function startTask(
  context: HandlerContext,
  snapshots: NonNullable<HandlerContext["snapshots"]>,
  kind: TaskKind,
  gameId: string,
  first: Step,
  run: (hooks: {
    onLocked(): void;
    progress(step: Step, bytesDone?: number): void;
  }) => Promise<Result<unknown, ErrorCode>>,
): Promise<Result<{ taskId: string }, ErrorCode>> {
  const taskId = context.newId();
  let step: Step = first;
  let replied = false;
  const held: TaskProgressEvent[] = [];
  const send = (event: Partial<TaskProgressEvent> & Pick<TaskProgressEvent, "status">) => {
    const full: TaskProgressEvent = { taskId, gameId, kind, step, ...event };
    if (replied) snapshots.sendProgress(full);
    else held.push(full);
  };
  const locked = Promise.withResolvers<null>();
  const done = run({
    onLocked: () => locked.resolve(null),
    progress(next, bytesDone) {
      step = next;
      send({ status: "running", ...(bytesDone === undefined ? {} : { bytesDone }) });
    },
  });
  const firstSettled: Result<unknown, ErrorCode> | null = await Promise.race([
    locked.promise,
    done,
  ]);
  if (firstSettled !== null && !firstSettled.ok) return firstSettled;
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
      context.log.error("snapshot.task.threw", { gameId, kind, error });
      send({ status: "failed", code: "INTERNAL", message: "Something went wrong." });
    },
  );
  return { ok: true, data: { taskId } };
}

export function snapshotHandlers(
  context: HandlerContext,
): Pick<
  Handlers,
  | "snapshot:export"
  | "snapshot:import"
  | "snapshot:verify"
  | "snapshot:recover"
  | "snapshot:list"
  | "snapshot:saveAs"
  | "game:deleteSaves"
  | "game:clearCache"
  | "library:deleteOrphanData"
> {
  return {
    async "snapshot:export"({ gameId, frameKeys }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      if (!library.repos.games.get(gameId)) return NOT_FOUND;
      return startTask(context, snapshots, "export", gameId, "lock", ({ onLocked, progress }) =>
        snapshots.export(gameId, {
          ...(frameKeys ? { frameKeys } : {}),
          onLocked,
          onProgress: (p: { step: ExportStep; bytesDone?: number }) =>
            progress(p.step, p.bytesDone),
        }),
      );
    },

    async "snapshot:import"({ gameId, source, mapping }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      if (!library.repos.games.get(gameId)) return NOT_FOUND;
      let from: { revisionId: string } | { file: string };
      if (source === "file") {
        const file = await context.dialogs.openFile({
          title: "Import snapshot",
          filters: [{ name: "WGLauncher snapshot", extensions: ["wgsnap"] }],
        });
        if (file === null)
          return { ok: false, code: "CANCELLED", message: "Nothing was imported." };
        from = { file };
      } else {
        from = source;
      }
      return startTask(context, snapshots, "import", gameId, "validate", ({ onLocked, progress }) =>
        snapshots.restore(
          { gameId, source: from, ...(mapping ? { mapping } : {}) },
          { onLocked, onStep: (step) => progress(step) },
        ),
      );
    },

    async "snapshot:verify"({ gameId, revisionId }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      if (!library.repos.games.get(gameId)) return NOT_FOUND;
      return startTask(context, snapshots, "verify", gameId, "lock", ({ onLocked, progress }) =>
        snapshots.verify(gameId, revisionId, { onLocked, onStep: (step) => progress(step) }),
      );
    },

    async "snapshot:recover"({ gameId }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      if (!library.repos.games.get(gameId)) return NOT_FOUND;
      return startTask(context, snapshots, "recover", gameId, "lock", ({ onLocked, progress }) =>
        snapshots.recover(gameId, { onLocked, onStep: (step) => progress(step) }),
      );
    },

    async "game:deleteSaves"({ gameId }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      if (!library.repos.games.get(gameId)) return NOT_FOUND;
      return startTask(
        context,
        snapshots,
        "delete-saves",
        gameId,
        "lock",
        ({ onLocked, progress }) =>
          snapshots.deleteSaves(gameId, { onLocked, onStep: (step) => progress(step) }),
      );
    },

    async "library:deleteOrphanData"({ gameId }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      if (!library.repos.orphans.get(gameId)) {
        return { ok: false, code: "NOT_FOUND", message: "No data of a removed game has that id." };
      }
      return startTask(
        context,
        snapshots,
        "delete-saves",
        gameId,
        "lock",
        ({ onLocked, progress }) =>
          snapshots.deleteSaves(gameId, { onLocked, onStep: (step) => progress(step) }),
      );
    },

    async "game:clearCache"({ gameId }) {
      const { library, snapshots } = context;
      if (!library || !snapshots) return READ_ONLY;
      if (!library.repos.games.get(gameId)) return NOT_FOUND;
      return snapshots.clearCache(gameId);
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
