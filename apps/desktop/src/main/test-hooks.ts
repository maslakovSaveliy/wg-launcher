// Test hooks of the test flavor only. index.ts imports this module behind `__WG_FLAVOR__ === "test"`, so it is not
// in a prod bundle; scripts/check-prod-bundle.mjs fails if the global's name appears there. The e2e suite reaches
// the hooks through Playwright's `app.evaluate` as `globalThis.__wgTest`.

import { uuidv7 } from "@wg-launcher/shared";
import { BrowserWindow, session } from "electron";
import type { Db } from "./db/database.js";
import { readUserVersion } from "./db/migrate.js";
import type { Repos } from "./db/repos/index.js";
import type { ConfirmSpec, Dialogs, OpenFileSpec, SaveFileSpec } from "./dialogs.js";
import type { GameRuntime, GameState, LaunchResult } from "./games/lifecycle.js";
import type { AppPaths } from "./paths.js";
import { checkEntryUrl } from "./policy/url-rules.js";

type DialogKind = keyof Dialogs;
type DialogAnswer =
  | { kind: "confirm"; value: boolean }
  | { kind: "openFile" | "saveFile"; value: string | null };

export interface ConsoleRecord {
  level: string;
  message: string;
  sourceId: string;
}

export interface WarningRecord {
  name: string;
  message: string;
}

export interface TestHooks {
  flavor: "test";
  userData: string;
  paths: AppPaths;
  /** The --disable-features value before and after fixPartitioningSwitch, or null when it changed nothing. */
  partitioning: { before: string; after: string } | null;
  /** Every console message of the launcher page, from before its first load. */
  launcherConsole: ConsoleRecord[];
  secondInstances: number;
  /** Every process warning since the main module loaded (node:sqlite must add none in Electron 45). */
  warnings: WarningRecord[];
  /** The library database as opened by the main process, or null before it is open. */
  database: { readOnly: boolean; userVersion: number } | null;
  /** Titles of the dialogs shown, in order. */
  dialogsShown: Array<{ kind: DialogKind; title: string }>;
  queueDialogAnswer(answer: DialogAnswer): void;
  /**
   * Opens a plain test window (sandboxed, no preload, an in-memory partition of its own, every permission and new
   * window denied) at `url`. Not a game window (those come with the window factory); used to check the browser
   * behavior the app sets up, such as storage partitioning.
   */
  openTestWindow(url: string): Promise<number>;
  /** Every URL the app handed to `shell.openExternal`; the test flavor records it and opens nothing. */
  externalOpened: string[];
  /** Adds a library entry (the entry-URL rule applies) and returns its new id. */
  addGame(url: string, title?: string): string;
  launchGame(gameId: string): Promise<LaunchResult>;
  gameState(gameId: string): GameState;
  /** The game window's webContents id, or null when the game has no window. */
  gameWebContentsId(gameId: string): number | null;
  /** Closes the game window the way the user does (its `close` event, so the close procedure runs). */
  closeGame(gameId: string): boolean;
  /** The game's `storage_targets` rows as `top frame` origin pairs. */
  storageTargets(gameId: string): string[];
}

declare global {
  var __wgTest: TestHooks | undefined;
}

/** Dialogs that answer from the queue the e2e test filled, and fail loudly when it is empty or mismatched. */
function queuedDialogs(hooks: Pick<TestHooks, "dialogsShown">, queue: DialogAnswer[]): Dialogs {
  const next = (kind: DialogKind, title: string): DialogAnswer => {
    hooks.dialogsShown.push({ kind, title });
    const answer = queue.shift();
    if (answer === undefined || answer.kind !== kind) {
      throw new Error(`Test dialog "${title}" (${kind}) has no queued answer of that kind.`);
    }
    return answer;
  };
  return {
    confirm: async (spec: ConfirmSpec) => next("confirm", spec.title).value === true,
    openFile: async (spec: OpenFileSpec) => next("openFile", spec.title).value as string | null,
    saveFile: async (spec: SaveFileSpec) => next("saveFile", spec.title).value as string | null,
  };
}

export function installTestHooks(init: {
  userData: string;
  paths: AppPaths;
  partitioning: { before: string; after: string } | null;
  warnings: WarningRecord[];
}): {
  dialogs: Dialogs;
  openExternal(url: string): Promise<void>;
  watchGames(games: { runtime: GameRuntime; repos: Repos }): void;
  watchLauncher(window: BrowserWindow): void;
  watchDatabase(db: Db): void;
  onSecondInstance(): void;
} {
  const queue: DialogAnswer[] = [];
  let testWindows = 0;
  let games: { runtime: GameRuntime; repos: Repos } | null = null;
  const needGames = () => {
    if (!games) throw new Error("The game runtime is not up (read-only database?).");
    return games;
  };
  const hooks: TestHooks = {
    flavor: "test",
    userData: init.userData,
    paths: init.paths,
    partitioning: init.partitioning,
    launcherConsole: [],
    secondInstances: 0,
    warnings: init.warnings,
    database: null,
    dialogsShown: [],
    queueDialogAnswer: (answer) => {
      queue.push(answer);
    },
    async openTestWindow(url) {
      testWindows += 1;
      const ses = session.fromPartition(`test-window-${testWindows}`);
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      const window = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      await window.loadURL(url);
      return window.webContents.id;
    },
    externalOpened: [],
    addGame(url, title) {
      const checked = checkEntryUrl(url, "test");
      if (!checked.ok) throw new Error(`addGame: ${checked.code}`);
      const id = uuidv7();
      needGames().repos.games.insert({ id, url: checked.data, title: title ?? new URL(url).host });
      return id;
    },
    launchGame: (gameId) => needGames().runtime.launch(gameId),
    gameState: (gameId) => needGames().runtime.state(gameId),
    gameWebContentsId(gameId) {
      const window = needGames().runtime.windowOf(gameId) as BrowserWindow | null;
      return window && !window.isDestroyed() ? window.webContents.id : null;
    },
    storageTargets: (gameId) =>
      needGames()
        .repos.storageTargets.listForGame(gameId)
        .map((row) => `${row.topOrigin} ${row.frameOrigin}`),
    closeGame(gameId) {
      const window = needGames().runtime.windowOf(gameId);
      if (!window || window.isDestroyed()) return false;
      window.close();
      return true;
    },
  };
  globalThis.__wgTest = hooks;

  return {
    dialogs: queuedDialogs(hooks, queue),
    async openExternal(url) {
      hooks.externalOpened.push(url);
    },
    watchGames(value) {
      games = value;
    },
    watchLauncher(window) {
      window.webContents.on("console-message", (event) => {
        hooks.launcherConsole.push({
          level: event.level,
          message: event.message,
          sourceId: event.sourceId,
        });
      });
    },
    watchDatabase(db) {
      hooks.database = { readOnly: db.readOnly, userVersion: readUserVersion(db.raw) };
    },
    onSecondInstance() {
      hooks.secondInstances += 1;
    },
  };
}
