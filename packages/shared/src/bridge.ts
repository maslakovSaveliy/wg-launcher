// The launcher bridge's shape (`window.wg`, security.md section 6): one typed function per IPC channel and two event
// subscriptions. No zod here and only type imports, so the sandboxed preload bundles this file without the schemas
// (it imports `@wg-launcher/shared/bridge`); validation is the main process's job.

import type {
  GameStateEvent,
  IpcChannel,
  IpcRequest,
  IpcResult,
  TaskProgressEvent,
} from "./ipc.js";

/** Bumped whenever the bridge's functions change. */
export const BRIDGE_VERSION = 6;

/** Bridge function name to channel. */
export const BRIDGE_CHANNELS = {
  listLibrary: "library:list",
  addGame: "library:add",
  updateGame: "library:update",
  removeGame: "library:remove",
  listOrphans: "library:orphans",
  deleteOrphanData: "library:deleteOrphanData",
  launchGame: "game:launch",
  focusGame: "game:focus",
  clearCache: "game:clearCache",
  deleteSaves: "game:deleteSaves",
  createShortcut: "shortcut:create",
  listFrames: "snapshot:frames",
  exportSnapshot: "snapshot:export",
  importSnapshot: "snapshot:import",
  verifySnapshot: "snapshot:verify",
  retryRecovery: "snapshot:recover",
  listSnapshots: "snapshot:list",
  saveSnapshotAs: "snapshot:saveAs",
  getSettings: "settings:get",
  setSettings: "settings:set",
} as const satisfies Record<string, IpcChannel>;

export type BridgeFunction = keyof typeof BRIDGE_CHANNELS;

/** Main to the launcher renderer: `GameStateEvent` (architecture.md section 6). */
export const GAME_STATE_CHANNEL = "game:state";

/** Main to the launcher renderer: `TaskProgressEvent` (architecture.md section 6). */
export const TASK_PROGRESS_CHANNEL = "task:progress";

export type WgBridge = {
  readonly bridgeVersion: typeof BRIDGE_VERSION;
  /** Calls `listener` with every game state change; returns the function that unsubscribes. */
  onGameState(listener: (event: GameStateEvent) => void): () => void;
  /** Calls `listener` with every task progress event; returns the function that unsubscribes. */
  onTaskProgress(listener: (event: TaskProgressEvent) => void): () => void;
} & {
  readonly [F in BridgeFunction]: (
    request: IpcRequest<(typeof BRIDGE_CHANNELS)[F]>,
  ) => Promise<IpcResult<(typeof BRIDGE_CHANNELS)[F]>>;
};
