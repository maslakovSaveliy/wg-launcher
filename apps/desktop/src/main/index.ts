// Main process entry. Order matters: the partitioning switch, userData and the single-instance lock are settled
// before anything else, and the app:// scheme is registered before `ready`.

import { join } from "node:path";
import { app, type BrowserWindow, session } from "electron";
import { handleAppProtocol, LAUNCHER_URL, registerAppScheme } from "./app-protocol.js";
import { type Db, openDatabase } from "./db/database.js";
import { type Dialogs, nativeDialogs } from "./dialogs.js";
import { FLAVOR } from "./flavor.js";
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

async function start(userData: string): Promise<AppContext> {
  const testHooks = __WG_FLAVOR__ === "test" ? await import("./test-hooks.js") : null;
  await app.whenReady();

  const paths = appPaths(userData);
  await prepareAppPaths(paths);
  const log = createLogger(paths.logs);
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
  return { paths, log, dialogs, db };
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
