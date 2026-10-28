// The Electron side of the snapshot jobs: the quiescent window (save-transfer.md section 5, step 3), the game's
// session, the handshake channel, message channels and the snapshot worker process. Everything that decides
// something lives in quiescent/job.ts, export.ts and storage-check.ts; this module only builds their deps.
import { join } from "node:path";
import {
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  type Session,
  utilityProcess,
  webContents,
} from "electron";
import type { Repos } from "../db/repos/index.js";
import { gameSession } from "../games/game-session.js";
import type { Logger } from "../log/logger.js";
import type { AppPaths } from "../paths.js";
import { startSnapshotWorker } from "../worker/client.js";
import type { SnapshotDeps } from "./export.js";
import type { JobDeps, JobSession, JobWindow } from "./quiescent/job.js";

export interface SnapshotDepsOptions {
  repos: Repos;
  paths: AppPaths;
  locks: JobDeps["locks"];
  log: Logger;
  newId(): string;
  /** Test flavor only (canary controls and the e2e harness's world). */
  afterNavigation?: JobDeps["afterNavigation"];
  harnessWorld?: JobDeps["harnessWorld"];
}

/**
 * The quiescent window: hidden, on the game's partition, sandboxed and context-isolated, the quiescent preload, no
 * background throttling (it is never shown), and the preload in subframes only when a key is in an iframe (QW-6).
 * A renderer-initiated navigation of its main frame is refused (the job navigates with `loadURL` only).
 */
function quiescentWindow(options: { session: JobSession; preload: string; subframes: boolean }) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: options.session as unknown as Session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: options.subframes,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
      preload: options.preload,
    },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  return window as unknown as JobWindow;
}

/** What export.ts and storage-check.ts run on, with Electron's real objects. */
export function createSnapshotDeps(options: SnapshotDepsOptions): SnapshotDeps {
  const { log } = options;
  const workerPath = join(import.meta.dirname, "snapshot-worker.js");
  return {
    repos: options.repos,
    paths: options.paths,
    job: {
      locks: options.locks,
      session: (gameId) => gameSession(gameId, { log }) as unknown as JobSession,
      createWindow: quiescentWindow,
      contentsOn: (ses) =>
        webContents.getAllWebContents().filter((c) => (c.session as unknown) === ses).length,
      ipc: ipcMain as unknown as JobDeps["ipc"],
      newChannel: () => new MessageChannelMain(),
      preloadPath: join(import.meta.dirname, "../preload/quiescent.cjs"),
      log,
      ...(options.afterNavigation ? { afterNavigation: options.afterNavigation } : {}),
      ...(options.harnessWorld ? { harnessWorld: options.harnessWorld } : {}),
    },
    startWorker: () =>
      startSnapshotWorker({
        fork: () =>
          utilityProcess.fork(workerPath, [], { serviceName: "WGLauncher snapshot worker" }),
        log,
      }),
    log,
    newId: options.newId,
    now: Date.now,
  };
}
