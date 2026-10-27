import type { LauncherBridge } from "../preload/launcher.js";

declare global {
  interface Window {
    /** Exposed by the launcher preload; undefined if the preload did not run. */
    readonly wgLauncher?: LauncherBridge;
  }
}
