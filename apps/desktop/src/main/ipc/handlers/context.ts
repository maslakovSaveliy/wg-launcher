// The context every IPC handler is built over, and the read-only refusal they share.

import type { IpcCode, Result } from "@wg-launcher/shared";
import type { Covers } from "../../covers.js";
import type { Repos } from "../../db/repos/index.js";
import type { Dialogs } from "../../dialogs.js";
import type { Flavor } from "../../flavor.js";
import type { GameRuntime } from "../../games/lifecycle.js";
import type { LockManager } from "../../games/locks.js";
import type { Logger } from "../../log/logger.js";

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
  dialogs: Pick<Dialogs, "confirm" | "openFile">;
  covers: Covers;
  /** `createShortcut` with the platform's writers (`shortcuts.ts`). */
  shortcuts: {
    /** `shortcutsSupported(process.platform)`. */
    supported: boolean;
    create(game: { id: string; title: string }): Promise<Result<{ created: boolean }, IpcCode>>;
  };
  flavor: Flavor;
  log: Logger;
  newId: () => string;
}

/** Returned by every channel that would read or write the library while the database is read-only. */
export const READ_ONLY = {
  ok: false,
  code: "LIBRARY_READ_ONLY",
  message: "The library is read-only because a newer WGLauncher wrote it. Nothing can be changed.",
} as const;
