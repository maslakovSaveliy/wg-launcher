// The launcher bridge (security.md section 6): a sandboxed CommonJS preload, bundled into one file. It exposes
// `window.wg` through contextBridge: one function per IPC channel, each calling `ipcRenderer.invoke` with its fixed
// channel name, and the `game:state` subscription. `ipcRenderer` itself, a generic invoke or send, and the IPC event
// object (whose `sender` is `ipcRenderer`) never reach the page. Validation is main's job (zod is not bundled here).
// Sandboxed preloads in Electron 45 have no Buffer, events, timers or url.

import {
  BRIDGE_CHANNELS,
  BRIDGE_VERSION,
  type BridgeFunction,
  GAME_STATE_CHANNEL,
  type WgBridge,
} from "@wg-launcher/shared/bridge";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const functions = Object.fromEntries(
  (Object.keys(BRIDGE_CHANNELS) as BridgeFunction[]).map((name) => {
    const channel = BRIDGE_CHANNELS[name];
    return [name, (request: unknown) => ipcRenderer.invoke(channel, request)];
  }),
) as Omit<WgBridge, "bridgeVersion" | "onGameState">;

const bridge: WgBridge = Object.freeze({
  ...functions,
  bridgeVersion: BRIDGE_VERSION,
  onGameState(listener) {
    const forward = (_event: IpcRendererEvent, payload: unknown) =>
      listener(payload as Parameters<typeof listener>[0]);
    ipcRenderer.on(GAME_STATE_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(GAME_STATE_CHANNEL, forward);
    };
  },
});

contextBridge.exposeInMainWorld("wg", bridge);
