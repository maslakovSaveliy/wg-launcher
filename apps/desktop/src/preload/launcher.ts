// The launcher bridge (security.md section 6): a sandboxed CommonJS preload, bundled into one file. It exposes
// typed functions through contextBridge, one per IPC channel (the channels come with the IPC contract, Task 9);
// `ipcRenderer` itself is never exposed. Sandboxed preloads in Electron 45 have no Buffer, events, timers or url.

import { contextBridge } from "electron";

/** The shape the renderer sees as `window.wgLauncher`. */
export interface LauncherBridge {
  /** Bumped whenever the bridge's functions change. */
  readonly bridgeVersion: 1;
}

const bridge: LauncherBridge = Object.freeze({ bridgeVersion: 1 });

contextBridge.exposeInMainWorld("wgLauncher", bridge);
