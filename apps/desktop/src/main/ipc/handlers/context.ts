// The context every IPC handler is built over, and the read-only refusal they share.

import type { ErrorCode, IpcCode, Result, TaskProgressEvent } from "@wg-launcher/shared";
import type { Covers } from "../../covers.js";
import type { Repos } from "../../db/repos/index.js";
import type { Snapshot } from "../../db/repos/snapshots.js";
import type { Dialogs } from "../../dialogs.js";
import type { Flavor } from "../../flavor.js";
import type { GameRuntime } from "../../games/lifecycle.js";
import type { LockManager } from "../../games/locks.js";
import type { Logger } from "../../log/logger.js";
import type { ExportOptions } from "../../snapshots/export.js";
import type { FaultPoint } from "../../snapshots/faults.js";
import type { KeyMapping } from "../../snapshots/key-check.js";
import type { RestoreOutcome, RestoreSource } from "../../snapshots/restore.js";

/** What a task reports while it runs: the lock is held (the call then answers), and each real step. */
export interface TaskHooks {
  onLocked(): void;
  onStep(step: FaultPoint): void;
}

/** What the handlers need when the database is writable. */
export interface Library {
  repos: Repos;
  runtime: Pick<GameRuntime, "state" | "launch" | "focus">;
  locks: Pick<LockManager, "acquire">;
}

export interface HandlerContext {
  /** Null while the database is read-only (architecture.md section 7): then nothing is read or written. */
  library: Library | null;
  /** Why the database is read-only; shown by the UI instead of the library. */
  readOnlyReason?: string;
  dialogs: Pick<Dialogs, "confirm" | "openFile" | "saveFile">;
  covers: Covers;
  /** `createShortcut` with the platform's writers (`shortcuts.ts`). */
  shortcuts: {
    /** `shortcutsSupported(process.platform)`. */
    supported: boolean;
    create(game: { id: string; title: string }): Promise<Result<{ created: boolean }, IpcCode>>;
  };
  /** The snapshot jobs; null while the database is read-only. */
  snapshots: Snapshots | null;
  flavor: Flavor;
  log: Logger;
  newId: () => string;
}

/** What the snapshot channels need (snapshots/export.ts and the file system). */
export interface Snapshots {
  export(gameId: string, options: ExportOptions): Promise<Result<Snapshot, ErrorCode>>;
  restore(
    request: { gameId: string; source: RestoreSource; mapping?: readonly KeyMapping[] },
    hooks: TaskHooks,
  ): Promise<Result<RestoreOutcome, ErrorCode>>;
  verify(gameId: string, revisionId: string, hooks: TaskHooks): Promise<Result<unknown, ErrorCode>>;
  recover(gameId: string, hooks: TaskHooks): Promise<Result<unknown, ErrorCode>>;
  /** "Delete local saves" of a library entry or of a removed game's data. */
  deleteSaves(gameId: string, hooks: TaskHooks): Promise<Result<unknown, ErrorCode>>;
  clearCache(gameId: string): Promise<Result<Record<string, never>, ErrorCode>>;
  /** Sends a `task:progress` event to the launcher page. */
  sendProgress(event: TaskProgressEvent): void;
  /** The absolute path of a stored snapshot (rows hold it relative to userData). */
  fileOf(path: string): string;
  copy(from: string, to: string): Promise<void>;
}

/** Returned by every channel that would read or write the library while the database is read-only. */
export const READ_ONLY = {
  ok: false,
  code: "LIBRARY_READ_ONLY",
  message: "The library is read-only because a newer WGLauncher wrote it. Nothing can be changed.",
} as const;
