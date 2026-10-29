// Main process entry. Order matters: the partitioning switch, userData and the single-instance lock are settled
// before anything else; `second-instance` and `open-url` are registered right after the lock, and the app:// scheme
// before `ready`.

import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GAME_STATE_CHANNEL,
  type GameStateEvent,
  TASK_PROGRESS_CHANNEL,
  type TaskProgressEvent,
  uuidv7,
} from "@wg-launcher/shared";
import { app, BrowserWindow, ipcMain, Menu, session, shell } from "electron";
import { appMenuTemplate } from "./app-menu.js";
import {
  DEV_LAUNCHER_ORIGIN,
  handleAppProtocol,
  LAUNCHER_ORIGIN,
  LAUNCHER_URL,
  registerAppScheme,
} from "./app-protocol.js";
import { createCovers } from "./covers.js";
import { type Db, openDatabase, type WritableDb } from "./db/database.js";
import { type Dialogs, type ErrorSpec, liveParent, nativeDialogs } from "./dialogs.js";
import { FLAVOR } from "./flavor.js";
import { gameSession, installBaselineHandlers } from "./games/game-session.js";
import type { GameRuntime, GameState } from "./games/lifecycle.js";
import { createHandlers } from "./ipc/handlers/index.js";
import { registerIpc } from "./ipc/register.js";
import { createLaunchQueue, registerDeepLinkScheme } from "./launch-input.js";
import { createGames, wireLaunches } from "./launch-wiring.js";
import {
  createLauncherWindow,
  LAUNCHER_PARTITION,
  setUpLauncherSession,
} from "./launcher-window.js";
import { createLogger, type Logger } from "./log/logger.js";
import { redact } from "./log/redact.js";
import { type AppPaths, appPaths, prepareAppPaths, resolveUserData } from "./paths.js";
import { parseDeepLink, parseLaunchInput } from "./policy/deep-link.js";
import { createShortcut, shortcutsSupported } from "./shortcuts.js";
import { createStorageCheckScheduler } from "./snapshots/check-scheduler.js";
import { clearCache } from "./snapshots/clear-cache.js";
import { deleteLocalSaves } from "./snapshots/delete-saves.js";
import { exportSnapshot } from "./snapshots/export.js";
import { createSnapshotDeps, verifySession } from "./snapshots/jobs.js";
import { recoverAtStartup, retryRecovery } from "./snapshots/recovery.js";
import { runRestore } from "./snapshots/restore.js";
import type { TaskDeps } from "./snapshots/restore-steps.js";
import { runStorageCheck } from "./snapshots/storage-check.js";
import { verifySnapshot } from "./snapshots/verify.js";
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

/** Shows a start-up failure; set once the dialogs exist (before that, only stderr reports it). */
let showStartupError: ((spec: ErrorSpec) => Promise<void>) | null = null;

const STARTUP_FAILED: ErrorSpec = {
  title: "WGLauncher cannot start",
  message:
    "Something went wrong while WGLauncher was starting. It will now quit. The log has the details.",
};
const DATABASE_FAILED: ErrorSpec = {
  title: "WGLauncher cannot open its library",
  message:
    "The library database (library.db) could not be opened: it may be damaged, or updating its format failed and " +
    "was rolled back. Nothing was deleted. WGLauncher will now quit.",
};

/** A start-up failure with the text its error dialog shows. */
class StartupError extends Error {
  constructor(
    readonly dialog: ErrorSpec,
    options: { cause: unknown },
  ) {
    super(dialog.title, options);
    this.name = "StartupError";
  }
}

/** Start-up cannot continue: report on stderr, show an error dialog when the dialogs exist, and exit 1. */
function fail(message: string, error: unknown): void {
  console.error(`WGLauncher: ${message}`, redact({ error }));
  const show = showStartupError;
  if (!show) {
    app.exit(1);
    return;
  }
  const spec = error instanceof StartupError ? error.dialog : STARTUP_FAILED;
  void show(spec)
    .catch(() => undefined)
    .finally(() => app.exit(1));
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

/** Launch requests (argv, `second-instance`, `open-url`), held until the runtime and the launcher are up. */
const launchQueue = createLaunchQueue();

async function start(userData: string): Promise<AppContext> {
  const testHooks = __WG_FLAVOR__ === "test" ? await import("./test-hooks.js") : null;
  // Before ready, so the default session (created at ready) gets the deny-all baseline too.
  let logger: Logger | null = null;
  installBaselineHandlers(app, { warn: (event, fields) => logger?.warn(event, fields) });
  await app.whenReady();
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, FLAVOR)));
  registerDeepLinkScheme(FLAVOR, app.isPackaged, (scheme) =>
    app.setAsDefaultProtocolClient(scheme),
  );

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
  showStartupError = (spec) => dialogs.showError(spec);

  // The main process is the only writer of the library database (AGENTS.md data-safety invariant 9).
  let db: Db;
  try {
    db = openDatabase(paths.db, { now: Date.now, backupDir: paths.backups, tmpDir: paths.tmp });
  } catch (error) {
    log.error("db.open-failed", { error });
    await log.flush();
    throw new StartupError(DATABASE_FAILED, { cause: error });
  }
  if (db.readOnly) log.error("db.read-only", { reason: db.reason, userVersion: db.userVersion });
  else log.info("db.open");
  hooks?.watchDatabase(db);
  app.on("will-quit", () => db.close());

  const openExternal = hooks?.openExternal ?? ((url: string) => shell.openExternal(url));
  /** Set once the storage check scheduler exists: a game window exited. */
  let onExited: ((gameId: string) => void) | null = null;
  // game:state goes to the launcher page only (architecture.md section 6).
  const sendState = (gameId: string, state: GameState) => {
    if (state === "exited") onExited?.(gameId);
    if (!launcher || launcher.isDestroyed()) return;
    const event: GameStateEvent = { gameId, state, at: Date.now() };
    launcher.webContents.send(GAME_STATE_CHANNEL, event);
  };
  const games = db.readOnly ? null : createGames(db, log, dialogs, openExternal, sendState);
  if (games) hooks?.watchGames(games);
  // Snapshot jobs share the runtime's lock manager, so a job and a game window never meet (AC-11, M5).
  const snapshotDeps = games
    ? createSnapshotDeps({
        repos: games.repos,
        transaction: (fn) => (db as WritableDb).transaction(fn),
        paths,
        locks: games.locks,
        log,
        newId: () => uuidv7(),
        ...(hooks
          ? { afterNavigation: hooks.afterNavigation, harnessWorld: hooks.harnessWorld }
          : {}),
      })
    : null;
  if (snapshotDeps) hooks?.watchSnapshots(snapshotDeps);
  // The "Local data" check after a game exits, never while a game window is focused (architecture.md section 11).
  const checks =
    games && snapshotDeps
      ? createStorageCheckScheduler({
          run: (gameId, signal) => runStorageCheck(gameId, signal, snapshotDeps),
          gameWindowFocused: () => {
            const focused = BrowserWindow.getFocusedWindow();
            return (
              focused !== null &&
              games.runtime.openGames().some((id) => games.runtime.windowOf(id) === focused)
            );
          },
          log,
        })
      : null;
  // Restore, delete, verify and recovery (save-transfer.md section 6) on the same deps as export.
  const taskDeps: TaskDeps | null =
    games && snapshotDeps
      ? {
          ...snapshotDeps,
          repos: games.repos,
          paths,
          fileOf: (relative) => join(userData, relative),
          confirm: (spec) => dialogs.confirm(spec),
          recovery: {
            mark: (gameId) => games.locks.markNeedsRecovery(gameId),
            clear: (gameId) => games.locks.clearNeedsRecovery(gameId),
          },
          // "Local data" is checked again after an import or a delete (architecture.md section 11).
          afterChange: (gameId) => checks?.gameExited(gameId),
          verifySession: () => verifySession(log),
          ...(hooks ? { faults: hooks.faults } : {}),
        }
      : null;
  if (taskDeps) hooks?.watchTasks(taskDeps);
  // Before any launch: an import or delete a crash interrupted is rolled back first; its game is refused until then.
  if (taskDeps) {
    const recovery = recoverAtStartup(taskDeps);
    if (recovery.pending.length > 0)
      log.warn("snapshot.recovery.at-start", { games: recovery.pending.length });
    void recovery.done.then(() => hooks?.recoveryFinished());
  } else {
    hooks?.recoveryFinished();
  }
  if (checks) {
    onExited = (gameId) => checks.gameExited(gameId);
    for (const event of ["browser-window-focus", "browser-window-blur"] as const) {
      app.on(event as "browser-window-focus", () => checks.focusChanged());
    }
  }
  // task:progress goes to the launcher page only (architecture.md section 6).
  const sendProgress = (event: TaskProgressEvent) => {
    if (!launcher || launcher.isDestroyed()) return;
    launcher.webContents.send(TASK_PROGRESS_CHANNEL, event);
  };
  // App quit runs the close procedure of every open game window in parallel, at most 3 s (architecture.md 4).
  let quitting = false;
  app.on("before-quit", (event) => {
    checks?.stop();
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

  const newLauncher = () => {
    const created = createLauncherWindow({
      session: launcherSession,
      preload: join(import.meta.dirname, "../preload/launcher.cjs"),
      log,
    });
    launcher = created;
    hooks?.watchLauncher(created);
    return created;
  };
  const window = newLauncher();

  // Before the first load, so the page never calls a channel that has no handler.
  registerIpc({
    ipc: ipcMain,
    launcher: () => liveParent(launcher)?.webContents ?? null,
    handlers: createHandlers({
      library: games ? { repos: games.repos, runtime: games.runtime, locks: games.locks } : null,
      ...(db.readOnly ? { readOnlyReason: db.reason } : {}),
      dialogs,
      covers: createCovers({ coversDir: paths.covers, tmpDir: paths.tmp }),
      snapshots:
        snapshotDeps && taskDeps && games
          ? {
              export: (gameId, options) => exportSnapshot(gameId, options, snapshotDeps),
              restore: (request, taskHooks) => runRestore({ ...request, ...taskHooks }, taskDeps),
              verify: (gameId, revisionId, taskHooks) =>
                verifySnapshot(gameId, revisionId, taskDeps, taskHooks),
              recover: (gameId, taskHooks) => retryRecovery(gameId, taskDeps, taskHooks),
              deleteSaves: (gameId, taskHooks) => deleteLocalSaves(gameId, taskDeps, taskHooks),
              clearCache: (gameId) =>
                clearCache(gameId, {
                  games: games.repos.games,
                  locks: games.locks,
                  confirm: (spec) => dialogs.confirm(spec),
                  session: (id) => gameSession(id, { log }),
                  log,
                }),
              sendProgress,
              fileOf: (path) => join(userData, path),
              copy: (from, to) => copyFile(from, to),
            }
          : null,
      shortcuts: {
        supported: shortcutsSupported(process.platform),
        create: (game) =>
          createShortcut(game, {
            platform: process.platform,
            execPath: process.execPath,
            desktopDir: app.getPath("desktop"),
            dialogs,
            writeFile: (path, content) => writeFile(path, content, "utf8"),
            writeShortcutLink: (path, operation, options) =>
              shell.writeShortcutLink(path, operation, options),
            log,
          }),
      },
      flavor: FLAVOR,
      log,
      newId: () => uuidv7(),
    }),
    log,
    origin: FLAVOR === "dev" ? DEV_LAUNCHER_ORIGIN : LAUNCHER_ORIGIN,
  });

  app.on("window-all-closed", () => app.quit());

  const devUrl = FLAVOR === "dev" ? process.env.ELECTRON_RENDERER_URL : undefined;
  const launcherUrl = devUrl ?? LAUNCHER_URL;
  await window.loadURL(launcherUrl);

  wireLaunches({
    log,
    dialogs,
    games,
    launchQueue,
    launcher: () => launcher,
    newLauncher,
    launcherUrl,
    ...(hooks ? { onSecondInstance: () => hooks.onSecondInstance() } : {}),
  });
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
    // Right after the lock, before `ready`: a request that arrives while this instance starts is queued, not lost.
    app.on("second-instance", (_event, argv) =>
      launchQueue.push({ source: "second-instance", input: parseLaunchInput(argv) }),
    );
    app.on("open-url", (event, url) => {
      event.preventDefault();
      launchQueue.push({ source: "open-url", input: parseDeepLink(url) });
    });
    launchQueue.push({ source: "argv", input: parseLaunchInput(process.argv) });
    registerAppScheme();
    start(userData).catch((error: unknown) => fail("start-up failed", error));
  }
}
