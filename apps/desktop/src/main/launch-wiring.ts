// The game runtime with its real windows and sessions, and the wiring of launch requests to it: what the main entry
// (index.ts) composes once the database is open and the launcher window exists.

import { app, type BrowserWindow, powerMonitor, screen } from "electron";
import type { WritableDb } from "./db/database.js";
import { createRepos } from "./db/repos/index.js";
import { type Dialogs, liveParent } from "./dialogs.js";
import { FLAVOR } from "./flavor.js";
import { closeGameWindow } from "./games/close-procedure.js";
import { recordFrames } from "./games/frames.js";
import { wireFullscreen } from "./games/fullscreen.js";
import { gameSession } from "./games/game-session.js";
import { GameRuntime, type GameState } from "./games/lifecycle.js";
import { LockManager } from "./games/locks.js";
import {
  createPlaytimeHub,
  type PlaytimeRecorder,
  settleUnfinishedSessions,
} from "./games/playtime-recorder.js";
import { createExternalOpener, createGameWindow } from "./games/window-factory.js";
import {
  applySavedFlags,
  displayAreas,
  initialBounds,
  trackWindowState,
} from "./games/window-state.js";
import { type createLaunchQueue, createNoticeChain, handleLaunchRequest } from "./launch-input.js";
import { focusLauncher } from "./launcher-window.js";
import type { Logger } from "./log/logger.js";
import { recoveryNotice } from "./snapshots/recovery.js";

/** The game runtime with the real windows, sessions and close procedure (architecture.md sections 4 and 5). */
export function createGames(
  db: WritableDb,
  log: Logger,
  dialogs: Dialogs,
  openExternal: (url: string) => Promise<void>,
  onState: (gameId: string, state: GameState) => void,
) {
  const repos = createRepos(db);
  // Before any launch: sessions a crash left unfinished (architecture.md section 10).
  settleUnfinishedSessions(repos.playSessions, log);
  const locks = new LockManager({ log });
  const playtime = createPlaytimeHub({
    sessions: repos.playSessions,
    games: repos.games,
    clock: () => performance.now(),
    log,
    isScreenLocked: () => powerMonitor.getSystemIdleState(1) === "locked",
  });
  for (const event of ["suspend", "resume", "lock-screen", "unlock-screen"] as const) {
    powerMonitor.on(event as "suspend", () => playtime.power(event));
  }
  const recorders = new Map<string, PlaytimeRecorder>();
  const runtime = new GameRuntime({
    games: repos.games,
    locks,
    onState,
    log,
    dialogs,
    flavor: FLAVOR,
    openWindow: ({ gameId, title, entryUrl }) => {
      // The session's handlers exist before the window, so the page never meets Electron's allow-all default.
      gameSession(gameId, { log });
      const askExternal = createExternalOpener({ gameId, dialogs, openExternal, log });
      const saved = repos.windowState.get(gameId);
      const window = createGameWindow({
        gameId,
        title,
        entryUrl,
        flavor: FLAVOR,
        log,
        askExternal: (url) => void askExternal(url),
        bounds: initialBounds(saved, displayAreas(screen)),
      });
      recordFrames(window.webContents, gameId, repos.storageTargets, log);
      const fullscreen = wireFullscreen(window, { gameId, log });
      // Before the runtime's own listeners, so the first `close` saves the state the user saw (architecture.md 9).
      trackWindowState(window, {
        gameId,
        save: (state) => repos.windowState.save(state),
        displayIdOf: (bounds) => String(screen.getDisplayMatching(bounds).id),
        log,
        isPageFullscreen: fullscreen.isPageFullscreen,
      });
      applySavedFlags(window, saved, { gameId, log });
      const recorder = playtime.attach(gameId, window);
      recorders.set(gameId, recorder);
      window.once("closed", () => {
        if (recorders.get(gameId) === recorder) recorders.delete(gameId);
      });
      return window;
    },
    // A refused launch of a game that needs recovery names the backup (save-transfer.md section 6).
    recoveryNotice: (gameId) => recoveryNotice(repos, gameId),
    // Step 1 of the close procedure stops playtime, so the procedure's time is not counted (architecture.md 4).
    closeWindow: (window, gameId) =>
      closeGameWindow(window as BrowserWindow, {
        gameId,
        log,
        dialogs,
        stopPlaytime: () => recorders.get(gameId)?.pause(),
      }),
  });
  return { runtime, repos, locks };
}

export type Games = ReturnType<typeof createGames>;

export interface LaunchWiring {
  log: Logger;
  dialogs: Dialogs;
  games: Games | null;
  launchQueue: ReturnType<typeof createLaunchQueue>;
  /** The launcher window now, or null when the user closed it. */
  launcher: () => BrowserWindow | null;
  /** Opens a new launcher window (its page not loaded yet). */
  newLauncher: () => BrowserWindow;
  launcherUrl: string;
  /** Test flavor: counts second instances. */
  onSecondInstance?: () => void;
}

/**
 * "Show the library" (the launcher window to the front, opened again if the user closed it while a game ran), the
 * macOS Dock click, the notice chain and the launch queue, which starts handling the requests queued so far.
 */
export function wireLaunches(wiring: LaunchWiring): void {
  const { log, dialogs, games, launchQueue, launcherUrl } = wiring;
  // "Show the library": the launcher window to the front, opened again if the user closed it while a game ran.
  let reopening: Promise<void> | null = null;
  const showLibrary = (): Promise<void> => {
    const current = liveParent(wiring.launcher());
    if (current) {
      focusLauncher(current);
      return Promise.resolve();
    }
    reopening ??= (async () => {
      log.info("launcher.reopened");
      try {
        await wiring.newLauncher().loadURL(launcherUrl);
      } catch (error) {
        log.error("launcher.reopen-failed", { error });
      } finally {
        reopening = null;
      }
    })();
    return reopening;
  };
  // macOS: a click on the Dock icon while only game windows are open brings the library back.
  app.on("activate", () => {
    if (!liveParent(wiring.launcher())) void showLibrary();
  });
  // Notices wait for the library window and for each other, never for the launch queue.
  const notices = createNoticeChain(async (spec) => {
    await showLibrary();
    await dialogs.notify(spec);
  }, log);

  // The window manager is up: handle the launch requests queued so far, then each as it comes.
  launchQueue.start(
    (request) => {
      if (request.source === "second-instance") {
        log.info("app.second-instance");
        wiring.onSecondInstance?.();
      }
      return handleLaunchRequest(request, {
        log,
        focusLauncher: () => void showLibrary(),
        notify: (spec) => notices.notify(spec),
        games: games
          ? {
              has: (gameId) => games.repos.games.get(gameId) !== null,
              launch: (gameId) => games.runtime.launch(gameId),
            }
          : null,
      });
    },
    (source) => log.warn("launch.dropped", { source }),
  );
}
