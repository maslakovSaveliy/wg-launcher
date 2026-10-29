// Test hooks of the test flavor only. index.ts imports this module behind `__WG_FLAVOR__ === "test"`, so it is not
// in a prod bundle; scripts/check-prod-bundle.mjs fails if the global's name appears there. The e2e suite reaches
// the hooks through Playwright's `app.evaluate` as `globalThis.__wgTest`.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameInventory } from "@wg-launcher/exporters/wire";
import type { ErrorCode, Result } from "@wg-launcher/shared";
import { uuidv7 } from "@wg-launcher/shared";
import { BrowserWindow, session } from "electron";
import type { Db } from "./db/database.js";
import { readUserVersion } from "./db/migrate.js";
import type { Repos } from "./db/repos/index.js";
import type { PlaySession } from "./db/repos/play-sessions.js";
import type { JournalEntry } from "./db/repos/restore-journal.js";
import type { Snapshot } from "./db/repos/snapshots.js";
import type { StorageCheck } from "./db/repos/storage-checks.js";
import type { WindowState } from "./db/repos/window-state.js";
import type { ConfirmSpec, Dialogs, ErrorSpec, OpenFileSpec, SaveFileSpec } from "./dialogs.js";
import { gameSession } from "./games/game-session.js";
import type { GameRuntime, GameState, LaunchResult } from "./games/lifecycle.js";
import type { AppPaths } from "./paths.js";
import { checkEntryUrl } from "./policy/url-rules.js";
import { clearCache } from "./snapshots/clear-cache.js";
import { deleteLocalSaves } from "./snapshots/delete-saves.js";
import { type ExportTestControls, exportSnapshot, type SnapshotDeps } from "./snapshots/export.js";
import { type FaultHook, faultHook } from "./snapshots/faults.js";
import { isQuiescentWindow } from "./snapshots/jobs.js";
import type { KeyMapping } from "./snapshots/key-check.js";
import type { StorageKeyRef } from "./snapshots/keys.js";
import { knownKeys } from "./snapshots/keys.js";
import type { JobDeps, JobTiming } from "./snapshots/quiescent/job.js";
import { holdQuiescentJob } from "./snapshots/quiescent/job.js";
import { retryRecovery } from "./snapshots/recovery.js";
import { type RestoreOutcome, type RestoreSource, runRestore } from "./snapshots/restore.js";
import { ALL, type TaskDeps } from "./snapshots/restore-steps.js";
import { runStorageCheck } from "./snapshots/storage-check.js";
import { verifySnapshot } from "./snapshots/verify.js";
import { workerSlot } from "./worker/slot.js";

/**
 * What the next quiescent jobs do right after each stub navigation (the canary controls of save-transfer.md section
 * 10): nothing, run a script in the window's main world, start a service worker of the session, or wait.
 */
export type QuiescentControl = (
  | { kind: "none" }
  | { kind: "main-world-script" }
  | { kind: "start-worker"; scope: string }
  | { kind: "hold"; ms: number }
) & {
  /** Only jobs holding this lease kind (the automatic storage check is `background`); all jobs when absent. */
  lock?: "task" | "background";
};

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
  /** Adds a snapshot row (no file: the row only) for the game and returns its revision id. */
  addSnapshotRecord(gameId: string): string;
  /** How many snapshot rows the game has (its own, not its base revision's). */
  snapshotCount(gameId: string): number;
  /** The game's `window_state` row, or null. */
  windowStateOf(gameId: string): WindowState | null;
  /** The game's `play_sessions` rows and `last_launched_at`. */
  playtimeOf(gameId: string): { sessions: PlaySession[]; lastLaunchedAt: number | null };
  /** Adds a play session with `activeMs` (finished, or left unfinished as a crash leaves it). */
  seedPlaySession(gameId: string, activeMs: number, finished: boolean): void;
  /** Records a storage check (the "Local data" badge's state). */
  saveStorageCheck(gameId: string, hasData: boolean): void;
  /** Exports a snapshot as `snapshot:export` does, with the test controls (limits, the worker fault, the bypass). */
  exportSnapshot(
    gameId: string,
    options?: { frameKeys?: StorageKeyRef[]; test?: ExportTestControls },
  ): Promise<Result<Snapshot, ErrorCode>>;
  runStorageCheck(gameId: string): Promise<Result<StorageCheck, ErrorCode>>;
  /** Sets what quiescent jobs do after each navigation, until set again. */
  setQuiescentControl(control: QuiescentControl): void;
  /** The game's own snapshot rows. */
  snapshotRows(gameId: string): Snapshot[];
  /** Starts the session's service worker for `scope` (the service-worker variant of an export). */
  startServiceWorker(gameId: string, scope: string): Promise<boolean>;
  /** How many service workers of the game's session run now. */
  runningServiceWorkers(gameId: string): number;
  /** The app's windows a user can see or get: every window but the hidden quiescent ones of snapshot jobs. */
  windowCount(): number;
  /**
   * Restores a snapshot as `snapshot:import` does (a queued confirm answers its dialog); `faults` (save-transfer.md
   * section 6, AC-8) apply until set again with `setFaults`.
   */
  restoreSnapshot(
    gameId: string,
    options: { source: RestoreSource; mapping?: KeyMapping[] },
  ): Promise<Result<RestoreOutcome, ErrorCode>>;
  /** `fail:`, `throw:`, `slow:<step>:<ms>` and `crash-after:` specs for the next restores and deletes (faults.ts). */
  setFaults(specs: string[]): void;
  /** The quiescent jobs' timing from now on (job.ts `JobTiming`); null restores the defaults. */
  setJobTiming(timing: Partial<JobTiming> | null): void;
  deleteLocalSaves(gameId: string): Promise<Result<unknown, ErrorCode>>;
  clearCache(gameId: string): Promise<Result<unknown, ErrorCode>>;
  verifySnapshot(gameId: string, revisionId: string): Promise<Result<Snapshot, ErrorCode>>;
  retryRecovery(gameId: string): Promise<Result<unknown, ErrorCode>>;
  /** Every journal entry of the game, oldest first. */
  journalOf(gameId: string): JournalEntry[];
  /** The game's row as the launch rule sees it, or null. */
  gameRow(gameId: string): { needsRecovery: boolean; baseRevisionId: string | null } | null;
  /** Whether start-up recovery has finished (every pending rollback ran). */
  recoveryDone: boolean;
  /**
   * The `contentHash` of everything stored under the game's known keys (generic exporter, no filter), read through a
   * quiescent window and hashed in the worker; nothing is written. Two equal digests mean equal storage.
   */
  storageDigest(gameId: string): Promise<Result<string, ErrorCode>>;
  /**
   * The quiescent inventory of each known key: `origin topLevelSite` to its counts and usage numbers. `entryUrl` is
   * for a game whose entry and orphan row are both gone (its data deleted).
   */
  storageInventory(
    gameId: string,
    entryUrl?: string,
  ): Promise<Result<Record<string, FrameInventory>, ErrorCode>>;
  /** Focuses the game's window (the storage check waits while a game window is focused). */
  focusGameWindow(gameId: string): boolean;
  /** Whether a game window has the focus now, as the storage check scheduler sees it. */
  gameWindowFocused(): boolean;
}

/**
 * Error dialogs of the test flavor are also appended here, one JSON line each, because a start-up failure exits the
 * app before an e2e test could read the hooks.
 */
export const TEST_ERROR_DIALOGS_FILE = "test-error-dialogs.jsonl";

declare global {
  var __wgTest: TestHooks | undefined;
}

/**
 * Dialogs that answer from the queue the e2e test filled, and fail loudly when it is empty or mismatched. Error
 * dialogs need no answer: they are recorded (in the hooks and in `TEST_ERROR_DIALOGS_FILE`).
 */
function queuedDialogs(
  hooks: Pick<TestHooks, "dialogsShown" | "userData">,
  queue: DialogAnswer[],
): Dialogs {
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
    notify: async (spec: ErrorSpec) => {
      hooks.dialogsShown.push({ kind: "notify", title: spec.title });
    },
    showError: async (spec: ErrorSpec) => {
      hooks.dialogsShown.push({ kind: "showError", title: spec.title });
      appendFileSync(
        join(hooks.userData, TEST_ERROR_DIALOGS_FILE),
        `${JSON.stringify({ title: spec.title, message: spec.message })}\n`,
      );
    },
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
  watchSnapshots(deps: SnapshotDeps): void;
  watchTasks(deps: TaskDeps): void;
  faults: FaultHook;
  recoveryFinished(): void;
  afterNavigation: NonNullable<JobDeps["afterNavigation"]>;
  harnessWorld: NonNullable<JobDeps["harnessWorld"]>;
  onSecondInstance(): void;
} {
  const queue: DialogAnswer[] = [];
  let testWindows = 0;
  let games: { runtime: GameRuntime; repos: Repos } | null = null;
  let snapshots: SnapshotDeps | null = null;
  let tasks: TaskDeps | null = null;
  let database: Db | null = null;
  let faults: FaultHook = () => undefined;
  const needTasks = () => {
    if (!tasks) throw new Error("The restore jobs are not up (read-only database?).");
    return tasks;
  };
  /** Runs one quiescent window over the game's known keys under a task lease (digest and inventory). */
  const readKnown = async <T>(
    gameId: string,
    perFrame: (
      worker: Awaited<ReturnType<SnapshotDeps["startWorker"]>>,
      frame: { key: { index: number; origin: string; topLevelSite: string | null }; port: unknown },
    ) => Promise<Result<void, ErrorCode>>,
    finish: (
      worker: Awaited<ReturnType<SnapshotDeps["startWorker"]>>,
      keys: ReturnType<typeof knownKeys>,
    ) => Promise<Result<T, ErrorCode>>,
    entryUrl?: string,
  ): Promise<Result<T, ErrorCode>> => {
    const deps = needTasks();
    const url =
      deps.repos.games.get(gameId)?.url ?? deps.repos.orphans.get(gameId)?.url ?? entryUrl;
    if (url === undefined) return { ok: false, code: "NOT_FOUND", message: "No such game." };
    const keys = knownKeys(url, deps.repos.storageTargets.listForGame(gameId));
    const held = await holdQuiescentJob(gameId, "task", deps.job);
    if (!held.ok) return held;
    const workers = workerSlot(deps.startWorker, {});
    try {
      return await held.data.run<T>({
        direction: "export",
        lock: "task",
        keys,
        async runFrames(frames, context) {
          const worker = await workers.get(context.signal);
          if (worker === null) return { ok: false, code: "CANCELLED", message: "Stopped." };
          for (const frame of frames) {
            const done = await perFrame(worker, frame);
            if (!done.ok) return done;
          }
          return { ok: true, data: undefined };
        },
        async commit(context) {
          const worker = await workers.get(context.signal);
          if (worker === null) return { ok: false, code: "CANCELLED", message: "Stopped." };
          return finish(worker, keys);
        },
        async discard() {},
      });
    } finally {
      await workers.dispose();
      held.data.release();
    }
  };
  let control: QuiescentControl = { kind: "none" };
  const needSnapshots = () => {
    if (!snapshots) throw new Error("The snapshot jobs are not up (read-only database?).");
    return snapshots;
  };
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
    addSnapshotRecord(gameId) {
      const { repos } = needGames();
      const revisionId = uuidv7();
      repos.snapshots.addIfAbsent({
        revisionId,
        gameId,
        kind: "export",
        manifestGameId: gameId,
        parentRevisionId: null,
        createdAt: new Date().toISOString(),
        deviceId: repos.device.ensure().id,
        exporterId: "e2e-record",
        exporterVersion: "0.0.0",
        contentHash: "0".repeat(64),
        sizeBytes: 0,
        path: "snapshots/e2e-record.wgsnap",
        flushState: "unconfirmed",
      });
      return revisionId;
    },
    snapshotCount: (gameId) => needGames().repos.snapshots.listForGame(gameId, null).length,
    windowStateOf: (gameId) => needGames().repos.windowState.get(gameId),
    playtimeOf: (gameId) => ({
      sessions: needGames().repos.playSessions.listForGame(gameId),
      lastLaunchedAt: needGames().repos.games.get(gameId)?.lastLaunchedAt ?? null,
    }),
    seedPlaySession(gameId, activeMs, finished) {
      const sessions = needGames().repos.playSessions;
      const { id } = sessions.start(gameId);
      if (finished) sessions.end(id, activeMs);
      else sessions.checkpoint(id, activeMs);
    },
    saveStorageCheck: (gameId, hasData) => needGames().repos.storageChecks.save(gameId, hasData),
    exportSnapshot: (gameId, options = {}) =>
      exportSnapshot(
        gameId,
        {
          ...(options.frameKeys ? { frameKeys: options.frameKeys } : {}),
          ...(options.test ? { test: options.test } : {}),
        },
        needSnapshots(),
      ),
    runStorageCheck: (gameId) => runStorageCheck(gameId, undefined, needSnapshots()),
    setQuiescentControl(next) {
      control = next;
    },
    snapshotRows: (gameId) => needGames().repos.snapshots.listForGame(gameId, null),
    async startServiceWorker(gameId, scope) {
      try {
        await session
          .fromPartition(`persist:game:${gameId}`)
          .serviceWorkers.startWorkerForScope(scope);
        return true;
      } catch {
        return false;
      }
    },
    windowCount: () => BrowserWindow.getAllWindows().filter((w) => !isQuiescentWindow(w)).length,
    focusGameWindow(gameId) {
      const window = needGames().runtime.windowOf(gameId) as BrowserWindow | null;
      if (!window || window.isDestroyed()) return false;
      window.focus();
      return true;
    },
    gameWindowFocused() {
      const focused = BrowserWindow.getFocusedWindow();
      const { runtime } = needGames();
      return focused !== null && runtime.openGames().some((id) => runtime.windowOf(id) === focused);
    },
    runningServiceWorkers: (gameId) =>
      Object.keys(session.fromPartition(`persist:game:${gameId}`).serviceWorkers.getAllRunning())
        .length,
    restoreSnapshot: (gameId, options) =>
      runRestore(
        {
          gameId,
          source: options.source,
          ...(options.mapping ? { mapping: options.mapping } : {}),
        },
        needTasks(),
      ),
    setFaults(specs) {
      // A crash is a crash: no clean-up, no log flush (Review Focus 2).
      faults = faultHook(specs, () => process.kill(process.pid, "SIGKILL"));
    },
    setJobTiming(timing) {
      // The restore jobs share this object with export and the storage check.
      const { job } = needSnapshots();
      if (timing === null) delete job.timing;
      else job.timing = timing;
    },
    deleteLocalSaves: (gameId) => deleteLocalSaves(gameId, needTasks()),
    clearCache: (gameId) => {
      const deps = needTasks();
      return clearCache(gameId, {
        games: deps.repos.games,
        locks: deps.job.locks,
        confirm: deps.confirm,
        session: (id) => gameSession(id, { log: deps.log }),
        log: deps.log,
      });
    },
    verifySnapshot: (gameId, revisionId) => verifySnapshot(gameId, revisionId, needTasks()),
    retryRecovery: (gameId) => retryRecovery(gameId, needTasks()),
    journalOf(gameId) {
      if (!database) return [];
      return (
        database.raw
          .prepare("SELECT id FROM restore_journal WHERE game_id = ? ORDER BY started_at, id")
          .all(gameId) as Array<{ id: string }>
      ).flatMap(({ id }) => {
        const entry = needTasks().repos.restoreJournal.get(id);
        return entry ? [{ ...entry }] : [];
      });
    },
    gameRow(gameId) {
      const game = needGames().repos.games.get(gameId);
      return game
        ? { needsRecovery: game.needsRecovery, baseRevisionId: game.baseRevisionId }
        : null;
    },
    recoveryDone: false,
    storageDigest: (gameId) =>
      readKnown(
        gameId,
        async (worker, frame) => {
          const exported = await worker.exportFrame(frame.port, {
            keyIndex: frame.key.index,
            storageKey: { origin: frame.key.origin, topLevelSite: frame.key.topLevelSite },
            scope: ALL,
          });
          return exported.ok ? { ok: true, data: undefined } : exported;
        },
        (worker, keys) =>
          worker.digest(
            keys.map(({ origin, topLevelSite, role }) => ({ origin, topLevelSite, role })),
          ),
      ),
    storageInventory(gameId, entryUrl) {
      const found: Record<string, FrameInventory> = {};
      return readKnown(
        gameId,
        async (worker, frame) => {
          const inventory = await worker.inventory(frame.port);
          if (!inventory.ok) return inventory;
          found[`${frame.key.origin} ${frame.key.topLevelSite ?? ""}`.trim()] = inventory.data;
          return { ok: true, data: undefined };
        },
        async () => ({ ok: true, data: found }),
        entryUrl,
      );
    },
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
      database = db;
      hooks.database = { readOnly: db.readOnly, userVersion: readUserVersion(db.raw) };
    },
    watchSnapshots(deps) {
      snapshots = deps;
    },
    watchTasks(deps) {
      tasks = deps;
    },
    faults: (point, when) => faults(point, when),
    recoveryFinished() {
      hooks.recoveryDone = true;
    },
    // Playwright's `_electron` attaches to every page, the quiescent window included, and evaluates an empty script
    // in its own utility world there; that world is the harness, not the game (canary.ts).
    harnessWorld: (name) => name.startsWith("__playwright_utility_world_"),
    async afterNavigation(window, ses, lock) {
      const current = control;
      if (current.lock !== undefined && current.lock !== lock) return;
      if (current.kind === "main-world-script") {
        await (window as unknown as BrowserWindow).webContents.executeJavaScript(
          "void 'injected';",
        );
      } else if (current.kind === "start-worker") {
        await (ses as unknown as Electron.Session).serviceWorkers
          .startWorkerForScope(current.scope)
          .catch(() => undefined);
      } else if (current.kind === "hold") {
        await new Promise((resolve) => setTimeout(resolve, current.ms));
      }
    },
    onSecondInstance() {
      hooks.secondInstances += 1;
    },
  };
}
