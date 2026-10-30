import type { WgBridge } from "@wg-launcher/shared/bridge";

declare global {
  interface Window {
    /** Exposed by the launcher preload; undefined if the preload did not run. */
    readonly wg?: WgBridge;
  }
}
