// The launcher bridge (security.md section 6): a sandboxed CommonJS preload, bundled into one file. It exposes
// `window.wg` through contextBridge: one function per IPC channel, each calling `ipcRenderer.invoke` with its fixed
// channel name, and the `game:state` and `task:progress` subscriptions. `ipcRenderer` itself, a generic invoke or send, and the IPC event
// object (whose `sender` is `ipcRenderer`) never reach the page. Validation is main's job (zod is not bundled here).
// Sandboxed preloads in Electron 45 have no Buffer, events, timers or url.

import {
  BRIDGE_CHANNELS,
  BRIDGE_VERSION,
  type BridgeFunction,
  GAME_STATE_CHANNEL,
  TASK_PROGRESS_CHANNEL,
  type WgBridge,
} from "@wg-launcher/shared/bridge";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const functions = Object.fromEntries(
  (Object.keys(BRIDGE_CHANNELS) as BridgeFunction[]).map((name) => {
    const channel = BRIDGE_CHANNELS[name];
    return [name, (request: unknown) => ipcRenderer.invoke(channel, request)];
  }),
) as Omit<WgBridge, "bridgeVersion" | "onGameState" | "onTaskProgress">;

/** Subscribes to one main-to-renderer channel; the IPC event object never reaches the page. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const forward = (_event: IpcRendererEvent, payload: unknown) => listener(payload as T);
  ipcRenderer.on(channel, forward);
  return () => {
    ipcRenderer.removeListener(channel, forward);
  };
}

const bridge: WgBridge = Object.freeze({
  ...functions,
  bridgeVersion: BRIDGE_VERSION,
  onGameState: (listener) => subscribe(GAME_STATE_CHANNEL, listener),
  onTaskProgress: (listener) => subscribe(TASK_PROGRESS_CHANNEL, listener),
});

contextBridge.exposeInMainWorld("wg", bridge);
