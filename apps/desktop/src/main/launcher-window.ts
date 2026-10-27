// The launcher window and its session (security.md section 6, rendering rules): sandboxed, context-isolated, the
// typed preload bridge only, and its `webContents` denies every navigation, new window, webview and permission.

import { BrowserWindow, type Session } from "electron";
import type { Logger } from "./log/logger.js";

/** The launcher's own session: in memory (no `persist:` prefix), never the default session (architecture.md). */
export const LAUNCHER_PARTITION = "launcher";

/** Denies every permission request and check, device access and download on the launcher's session. */
export function setUpLauncherSession(ses: Session, log: Logger): void {
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    log.warn("launcher.permission-denied", { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => {
    event.preventDefault();
    log.warn("launcher.download-refused");
  });
  ses.setSpellCheckerEnabled(false);
}

export function createLauncherWindow(options: {
  session: Session;
  preload: string;
  log: Logger;
}): BrowserWindow {
  const { log } = options;
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: "WGLauncher",
    show: false,
    webPreferences: {
      session: options.session,
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  });
  const contents = window.webContents;
  // Our own loadURL is not a renderer-initiated navigation, so it does not reach these handlers.
  contents.on("will-frame-navigate", (event) => {
    event.preventDefault();
    log.warn("launcher.navigation-refused", { url: event.url });
  });
  contents.on("will-redirect", (event) => {
    event.preventDefault();
    log.warn("launcher.redirect-refused", { url: event.url });
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    log.warn("launcher.webview-refused");
  });
  contents.setWindowOpenHandler(({ url }) => {
    log.warn("launcher.window-open-refused", { url });
    return { action: "deny" };
  });
  window.once("ready-to-show", () => window.show());
  return window;
}

/** Brings the launcher to the front: shown, restored if minimized, focused. */
export function focusLauncher(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}
