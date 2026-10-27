// Main process entry. Order matters: the partitioning switch, userData and the single-instance lock are settled
// before anything else, and the app:// scheme is registered before `ready`.

import { join } from "node:path";
import { app, type BrowserWindow, session } from "electron";
import { handleAppProtocol, LAUNCHER_URL, registerAppScheme } from "./app-protocol.js";
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
}

/** Start-up cannot continue: report on stderr (the log may not exist yet) and exit without a dialog. */
function fail(message: string, error: unknown): void {
  console.error(`WGLauncher: ${message}`, redact({ error }));
  app.exit(1);
}

function chooseUserData(): string | null {
  try {
    return resolveUserData(FLAVOR, process.env, {
      userData: app.getPath("userData"),
      appData: app.getPath("appData"),
    });
  } catch (error) {
    fail("cannot choose the userData directory", error);
    return null;
  }
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
  const hooks = testHooks?.installTestHooks({ userData, paths, partitioning }) ?? null;
  const dialogs = hooks?.dialogs ?? nativeDialogs(() => launcher);

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
  return { paths, log, dialogs };
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
