// Main process entry. Order matters: the partitioning switch, userData and the single-instance lock are settled
// before anything else, and the app:// scheme is registered before `ready`.

import { join } from "node:path";
import { app, type BrowserWindow, session, shell } from "electron";
import { handleAppProtocol, LAUNCHER_URL, registerAppScheme } from "./app-protocol.js";
import { type Db, openDatabase, type WritableDb } from "./db/database.js";
import { createRepos } from "./db/repos/index.js";
import { type Dialogs, nativeDialogs } from "./dialogs.js";
import { FLAVOR } from "./flavor.js";
import { closeGameWindow } from "./games/close-procedure.js";
import { recordFrames } from "./games/frames.js";
import { gameSession, installBaselineHandlers } from "./games/game-session.js";
import { GameRuntime } from "./games/lifecycle.js";
import { LockManager } from "./games/locks.js";
import { createExternalOpener, createGameWindow } from "./games/window-factory.js";
import {
  createLauncherWindow,
  focusLauncher,
  LAUNCHER_PARTITION,
  setUpLauncherSession,
} from "./launcher-window.js";
import { createLogger, type Logger } from "./log/logger.js";
import { redact } from "./log/redact.js";
import { type AppPaths, appPaths, prepareAppPaths, resolveUserData } from "./paths.js";
import { fixPartitioningSwitch } from "./start-up.js";

/** What later parts of the main process (database, IPC, jobs) are built on. */
export interface AppContext {
  paths: AppPaths;
  log: Logger;
  dialogs: Dialogs;
  /** The library database; read-only when a newer app wrote it (the launcher must then show `reason`, not write). */
  db: Db;
  /** The game windows and their lifecycle; null while the database is read-only (nothing can be launched). */
  games: GameRuntime | null;
}

/** Start-up cannot continue: report on stderr (the log may not exist yet) and exit without a dialog. */
function fail(message: string, error: unknown): void {
  console.error(`WGLauncher: ${message}`, redact({ error }));
  app.exit(1);
}

function chooseUserData(): string | null {
  try {
    // Pass `app` itself: reading app.getPath("userData") creates that directory, so it is read only when used.
    return resolveUserData(FLAVOR, process.env, app);
  } catch (error) {
    fail("cannot choose the userData directory", error);
    return null;
  }
}

// Test flavor: record process warnings from the first moment, so a warning printed while a module loads (such as
// node:sqlite's ExperimentalWarning in plain Node) is caught. ES module imports run before this body, but Node emits
// a warning on the next tick, so the listener is in place in time (the e2e control run checks the recorder).
const earlyWarnings: Array<{ name: string; message: string }> = [];
if (__WG_FLAVOR__ === "test") {
  process.on("warning", (warning) =>
    earlyWarnings.push({ name: warning.name, message: warning.message }),
  );
}

const partitioning = fixPartitioningSwitch(app.commandLine);

/** The game runtime with the real windows, sessions and close procedure (architecture.md sections 4 and 5). */
function createGames(
  db: WritableDb,
  log: Logger,
  dialogs: Dialogs,
  openExternal: (url: string) => Promise<void>,
) {
  const repos = createRepos(db);
  const runtime = new GameRuntime({
    games: repos.games,
    locks: new LockManager({ log }),
    log,
    dialogs,
    flavor: FLAVOR,
    openWindow: ({ gameId, title, entryUrl }) => {
      // The session's handlers exist before the window, so the page never meets Electron's allow-all default.
      gameSession(gameId, { log });
      const askExternal = createExternalOpener({ gameId, dialogs, openExternal, log });
      const window = createGameWindow({
        gameId,
        title,
        entryUrl,
        flavor: FLAVOR,
        log,
        askExternal: (url) => void askExternal(url),
      });
      recordFrames(window.webContents, gameId, repos.storageTargets, log);
      return window;
    },
    closeWindow: (window, gameId) =>
      closeGameWindow(window as BrowserWindow, { gameId, log, dialogs }),
  });
  return { runtime, repos };
}

async function start(userData: string): Promise<AppContext> {
  const testHooks = __WG_FLAVOR__ === "test" ? await import("./test-hooks.js") : null;
  // Before ready, so the default session (created at ready) gets the deny-all baseline too.
  let logger: Logger | null = null;
  installBaselineHandlers(app, { warn: (event, fields) => logger?.warn(event, fields) });
  await app.whenReady();

  const paths = appPaths(userData);
  await prepareAppPaths(paths);
  const log = createLogger(paths.logs);
  logger = log;
  log.info("app.start", {
    flavor: FLAVOR,
    version: app.getVersion(),
    electron: process.versions.electron,
    partitioningRestored: partitioning !== null,
  });

  let launcher: BrowserWindow | null = null;
  const hooks =
    testHooks?.installTestHooks({ userData, paths, partitioning, warnings: earlyWarnings }) ?? null;
  const dialogs = hooks?.dialogs ?? nativeDialogs(() => launcher);

  // The main process is the only writer of the library database (AGENTS.md data-safety invariant 9).
  const db = openDatabase(paths.db, {
    now: Date.now,
    backupDir: paths.backups,
    tmpDir: paths.tmp,
  });
  if (db.readOnly) log.error("db.read-only", { reason: db.reason, userVersion: db.userVersion });
  else log.info("db.open");
  hooks?.watchDatabase(db);
  app.on("will-quit", () => db.close());

  const openExternal = hooks?.openExternal ?? ((url: string) => shell.openExternal(url));
  const games = db.readOnly ? null : createGames(db, log, dialogs, openExternal);
  if (games) hooks?.watchGames(games);
  // App quit runs the close procedure of every open game window in parallel, at most 3 s (architecture.md 4).
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !games || games.runtime.openGames().length === 0) return;
    event.preventDefault();
    quitting = true;
    log.info("app.quit-closing-games", { count: games.runtime.openGames().length });
    // The log is flushed first, so the records of the procedure survive the exit.
    void games.runtime
      .closeAll(3000)
      .then(() => log.flush())
      .finally(() => app.quit());
  });

  const launcherSession = session.fromPartition(LAUNCHER_PARTITION);
  setUpLauncherSession(launcherSession, log);
  handleAppProtocol(launcherSession, join(import.meta.dirname, "../renderer"), paths.covers);

  const window = createLauncherWindow({
    session: launcherSession,
    preload: join(import.meta.dirname, "../preload/launcher.cjs"),
    log,
  });
  launcher = window;
  hooks?.watchLauncher(window);

  app.on("second-instance", () => {
    log.info("app.second-instance");
    hooks?.onSecondInstance();
    focusLauncher(window);
  });
  app.on("window-all-closed", () => app.quit());

  const devUrl = FLAVOR === "dev" ? process.env.ELECTRON_RENDERER_URL : undefined;
  await window.loadURL(devUrl ?? LAUNCHER_URL);
  return { paths, log, dialogs, db, games: games?.runtime ?? null };
}

const userData = chooseUserData();
if (userData !== null) {
  // Before the lock: Chromium's single-instance lock lives in the userData directory.
  app.setPath("userData", userData);
  // A second instance hands over to the first one (which focuses its window) and exits.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    registerAppScheme();
    start(userData).catch((error: unknown) => fail("start-up failed", error));
  }
}
