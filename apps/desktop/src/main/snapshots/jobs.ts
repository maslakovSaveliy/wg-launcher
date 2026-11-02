// The Electron side of the snapshot jobs: the quiescent window (save-transfer.md section 5, step 3), the game's
// session, the handshake channel, message channels and the snapshot worker process. Everything that decides
// something lives in quiescent/job.ts, export.ts and storage-check.ts; this module only builds their deps.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  BrowserWindow,
  MessageChannelMain,
  type Session,
  session,
  utilityProcess,
  webContents,
} from "electron";
import type { Repos } from "../db/repos/index.js";
import { gameSession, setUpGameSession } from "../games/game-session.js";
import type { Logger } from "../log/logger.js";
import type { AppPaths } from "../paths.js";
import { startSnapshotWorker } from "../worker/client.js";
import type { SnapshotDeps } from "./export.js";
import type { JobDeps, JobSession, JobWindow } from "./quiescent/job.js";
import type { TaskDeps } from "./restore-steps.js";

export interface SnapshotDepsOptions {
  repos: Repos;
  paths: AppPaths;
  locks: JobDeps["locks"];
  transaction: SnapshotDeps["transaction"];
  log: Logger;
  newId(): string;
  /** Test flavor only (canary controls and the e2e harness's world). */
  afterNavigation?: JobDeps["afterNavigation"];
  harnessWorld?: JobDeps["harnessWorld"];
}

const quiescentWindows = new WeakSet<BrowserWindow>();

/** True for a hidden quiescent window (no user ever sees one; the e2e suite counts the other windows). */
export const isQuiescentWindow = (window: BrowserWindow): boolean => quiescentWindows.has(window);

/**
 * The quiescent window: hidden and not focusable, on the game's partition, sandboxed and context-isolated, the
 * quiescent preload, no background throttling (it is never shown), and the preload in subframes only when a key is
 * in an iframe (QW-6). A renderer-initiated navigation of its main frame is refused (the job navigates with
 * `loadURL` only).
 */
function quiescentWindow(options: { session: JobSession; preload: string; subframes: boolean }) {
  const window = new BrowserWindow({
    show: false,
    // Never key or main: a hidden job window has no reason to take focus from the user's windows (Assumed).
    focusable: false,
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
  quiescentWindows.add(window);
  return window as unknown as JobWindow;
}

/** What export.ts and storage-check.ts run on, with Electron's real objects. */
export function createSnapshotDeps(options: SnapshotDepsOptions): SnapshotDeps {
  const { log } = options;
  const workerPath = join(import.meta.dirname, "snapshot-worker.js");
  return {
    repos: options.repos,
    transaction: options.transaction,
    paths: options.paths,
    job: {
      locks: options.locks,
      session: (gameId) => gameSession(gameId, { log }) as unknown as JobSession,
      createWindow: quiescentWindow,
      contentsOn: (ses) =>
        webContents.getAllWebContents().filter((c) => (c.session as unknown) === ses).length,
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

/**
 * A fresh in-memory partition for `snapshot:verify` (save-transfer.md section 6): `wg-verify-<nonce>` with 128 random
 * bits, no `persist:` prefix (Electron keeps such a partition in memory), the game policy installed; `dispose` clears
 * all of its data. Electron has no API to free a session, so each verify leaves an empty `Session` object (its
 * handlers included) in memory until the app quits: a small cost per verify (Assumed; not measured), bounded by how
 * often the user verifies.
 */
export function verifySession(log: Logger): ReturnType<NonNullable<TaskDeps["verifySession"]>> {
  const ses = session.fromPartition(`wg-verify-${randomBytes(16).toString("hex")}`);
  setUpGameSession(ses, "verify", { log });
  return {
    session: ses as unknown as JobSession,
    dispose: () => ses.clearStorageData(),
  };
}
