// The game session lifecycle of architecture.md section 4: idle → launching → running → closing → exited, and
// running → crashed. One window per game (F-5): a launch while the game is launching or running focuses its window;
// while it is closing nothing opens or shows and the result says `closing` (Assumed: showing a window that already
// shows about:blank would help no one). A window that has not painted after `LAUNCH_SHOW_TIMEOUT_MS` is shown anyway
// (state `running`), so a page that never answers is visible, in its real state, and can be closed (Assumed).
// A game's session lock (`LockManager`, kind `session`) is held from the launch until the window is gone.
//
// Exited and crashed are reported until the next launch, so the library can show a crash; both count as idle for a
// launch. Electron is not imported here: windows come from `deps.openWindow`, so the state machine is unit-tested.

import { isUuidV7, type Result } from "@wg-launcher/shared";
import type { Game } from "../db/repos/games.js";
import type { Dialogs } from "../dialogs.js";
import type { Flavor } from "../flavor.js";
import type { Logger } from "../log/logger.js";
import { checkEntryUrl } from "../policy/url-rules.js";
import type { CloseOutcome } from "./close-procedure.js";
import type { Lease, LockManager } from "./locks.js";

export type GameState = "idle" | "launching" | "running" | "closing" | "exited" | "crashed";

interface EventSource {
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
}

/** The parts of a BrowserWindow the runtime uses. */
export interface GameWindow extends EventSource {
  show(): void;
  focus(): void;
  restore(): void;
  isMinimized(): boolean;
  isVisible(): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  close(): void;
  webContents: EventSource & {
    loadURL(url: string): Promise<void>;
    isLoading(): boolean;
    forcefullyCrashRenderer(): void;
    getOSProcessId(): number;
  };
}

export interface OpenWindowRequest {
  gameId: string;
  title: string;
  entryUrl: URL;
}

export interface RuntimeDeps {
  games: { get(id: string): Pick<Game, "id" | "url" | "title" | "needsRecovery"> | null };
  locks: LockManager;
  log: Logger;
  dialogs: Pick<Dialogs, "confirm">;
  flavor: Flavor;
  /** Sets up the game's session and creates its hidden window with every policy installed. */
  openWindow(request: OpenWindowRequest): GameWindow;
  /** The close procedure (`closeGameWindow`), run after the window's `close` event was prevented. */
  closeWindow(window: GameWindow, gameId: string): Promise<CloseOutcome>;
  /** The text of a NEEDS_RECOVERY refusal, naming the backup that holds the game's saves (save-transfer.md 6). */
  recoveryNotice?(gameId: string): string;
  /** For tests; defaults to `LAUNCH_SHOW_TIMEOUT_MS`. */
  launchShowTimeoutMs?: number;
  /** Called after every state change, once per change (the `game:state` event of architecture.md section 6). */
  onState?(gameId: string, state: GameState): void;
  /** Force close's second step; defaults to `process.kill(pid, "SIGKILL")`. */
  killProcess?(pid: number): void;
  /** For tests; defaults to `FORCE_CLOSE_STEP_MS`. */
  forceCloseStepMs?: number;
}

/** A launching window is shown after this long even without `ready-to-show` (Assumed). */
export const LAUNCH_SHOW_TIMEOUT_MS = 15_000;

/**
 * How long each step of Force close waits for `render-process-gone` before the next one (Assumed): first
 * `forcefullyCrashRenderer`, then a SIGKILL of the renderer's OS process, then the session ends as crashed and the
 * window is destroyed. On a Linux CI runner a `forcefullyCrashRenderer` brought no `render-process-gone` within 15 s
 * (MEMORY.md), so the first step alone cannot be relied on.
 */
export const FORCE_CLOSE_STEP_MS = 3000;

export type LaunchCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "URL_NOT_ALLOWED"
  | "GAME_RUNNING"
  | "GAME_BUSY"
  | "NEEDS_RECOVERY"
  | "INTERNAL";

/** `closing`: the game is going through the close procedure; nothing was opened or shown (relaunch afterwards). */
export type LaunchResult = Result<{ window: "opened" | "focused" | "closing" }, LaunchCode>;

interface Entry {
  state: GameState;
  window: GameWindow | null;
  lease: Lease | null;
  /** Resolves when the window is gone (exited or crashed). */
  done: PromiseWithResolvers<void>;
}

const ACTIVE: ReadonlySet<GameState> = new Set(["launching", "running", "closing"]);

const MESSAGES: Record<LaunchCode, string> = {
  INVALID_ARGUMENT: "That is not a game id.",
  NOT_FOUND: "The game is not in the library.",
  URL_NOT_ALLOWED: "This build cannot open the game's address.",
  GAME_RUNNING: "The game is running.",
  GAME_BUSY: "The game is busy with a task. Try again when it is done.",
  NEEDS_RECOVERY: "The game's saves need recovery before it can start.",
  INTERNAL: "The game could not be started.",
};

const fail = (code: LaunchCode): LaunchResult => ({ ok: false, code, message: MESSAGES[code] });

export class GameRuntime {
  readonly #entries = new Map<string, Entry>();
  readonly #deps: RuntimeDeps;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
  }

  state(gameId: string): GameState {
    return this.#entries.get(gameId)?.state ?? "idle";
  }

  /** Ids of games whose window exists (launching, running or closing). */
  openGames(): string[] {
    return [...this.#entries].filter(([, entry]) => ACTIVE.has(entry.state)).map(([id]) => id);
  }

  windowOf(gameId: string): GameWindow | null {
    const entry = this.#entries.get(gameId);
    return entry && ACTIVE.has(entry.state) ? entry.window : null;
  }

  #refuse(gameId: string, code: LaunchCode): LaunchResult {
    const notice = code === "NEEDS_RECOVERY" ? this.#deps.recoveryNotice?.(gameId) : undefined;
    return notice === undefined ? fail(code) : { ok: false, code, message: notice };
  }

  async launch(gameId: string): Promise<LaunchResult> {
    const { log } = this.#deps;
    if (!isUuidV7(gameId)) return fail("INVALID_ARGUMENT");
    const existing = this.#entries.get(gameId);
    if (existing && ACTIVE.has(existing.state)) {
      log.info("game.launch-while-active", { gameId, state: existing.state });
      if (existing.state === "closing") return { ok: true, data: { window: "closing" } };
      this.focus(gameId);
      return { ok: true, data: { window: "focused" } };
    }
    const game = this.#deps.games.get(gameId);
    if (!game) return fail("NOT_FOUND");
    if (game.needsRecovery) return this.#refuse(gameId, "NEEDS_RECOVERY");
    const checked = checkEntryUrl(game.url, this.#deps.flavor);
    if (!checked.ok) return fail("URL_NOT_ALLOWED");

    // Claimed before the first await, so a second launch (double click, deep link) sees `launching`.
    const entry: Entry = {
      state: "launching",
      window: null,
      lease: null,
      done: Promise.withResolvers<void>(),
    };
    this.#entries.set(gameId, entry);
    this.#deps.onState?.(gameId, "launching");
    const lease = await this.#deps.locks.acquire(gameId, "session");
    if (!("release" in lease)) {
      this.#entries.delete(gameId);
      this.#deps.onState?.(gameId, "idle");
      log.info("game.launch-refused", { gameId, code: lease.code });
      return this.#refuse(gameId, lease.code);
    }
    entry.lease = lease;

    let window: GameWindow;
    try {
      window = this.#deps.openWindow({
        gameId,
        title: game.title,
        entryUrl: new URL(checked.data),
      });
    } catch (error) {
      log.error("game.window-failed", { gameId, error });
      this.#finish(gameId, entry, "exited");
      return fail("INTERNAL");
    }
    entry.window = window;
    this.#watch(gameId, entry, window);
    log.info("game.launching", { gameId, url: checked.data });
    window.webContents.loadURL(checked.data).catch((error: unknown) => {
      if (window.isDestroyed() || entry.state !== "launching" || window.webContents.isLoading()) {
        return;
      }
      // Load aborted before anything was shown (a refused redirect, a network error): launching → exited.
      log.warn("game.load-failed", { gameId, error });
      window.destroy();
    });
    return { ok: true, data: { window: "opened" } };
  }

  /** Shows (restores if minimized) and focuses a running game's window. False when there is none to focus. */
  focus(gameId: string): boolean {
    const entry = this.#entries.get(gameId);
    const window = entry?.window;
    if (!entry || !window || window.isDestroyed()) return false;
    // A launching window shows itself when ready; a closing one is hidden on purpose.
    if (entry.state !== "running") return true;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
    return true;
  }

  /** App quit: runs the close procedure of every open game in parallel, at most `timeoutMs`, then destroys the rest. */
  async closeAll(timeoutMs = 3000): Promise<void> {
    const entries = [...this.#entries.values()].filter((entry) => ACTIVE.has(entry.state));
    for (const entry of entries) {
      if (entry.state !== "closing" && entry.window && !entry.window.isDestroyed()) {
        entry.window.close();
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(entries.map((entry) => entry.done.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    for (const entry of entries) {
      if (entry.window && !entry.window.isDestroyed()) {
        this.#deps.log.warn("game.close-timeout", { timeoutMs });
        entry.window.destroy();
      }
    }
  }

  #watch(gameId: string, entry: Entry, window: GameWindow): void {
    const { log, dialogs } = this.#deps;
    const showNow = () => {
      if (entry.state !== "launching" || window.isDestroyed()) return;
      this.#set(gameId, entry, "running");
      log.info("game.running", { gameId });
      window.show();
      window.focus();
    };
    window.once("ready-to-show", showNow);
    const waitMs = this.#deps.launchShowTimeoutMs ?? LAUNCH_SHOW_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (entry.state !== "launching" || window.isDestroyed()) return;
      log.warn("game.show-timeout", { gameId, waitedMs: waitMs });
      showNow();
    }, waitMs);
    entry.done.promise.then(() => clearTimeout(timer));
    window.on("close", (event: { preventDefault(): void }) => {
      event.preventDefault();
      if (entry.state === "closing") return;
      this.#set(gameId, entry, "closing");
      log.info("game.closing", { gameId });
      this.#deps.closeWindow(window, gameId).then(
        (outcome) => {
          if (outcome === "stayed" && !window.isDestroyed()) {
            // The procedure showed the window again.
            this.#set(gameId, entry, "running");
            log.info("game.close-cancelled", { gameId });
          }
        },
        (error: unknown) => {
          log.error("game.close-failed", { gameId, error });
          if (!window.isDestroyed()) window.destroy();
        },
      );
    });
    window.on("closed", () => this.#finish(gameId, entry, "exited"));
    window.webContents.on(
      "render-process-gone",
      (_event: unknown, details: { reason: string; exitCode: number }) => {
        if (entry.state === "closing" || entry.state === "exited") return;
        log.error("game.crashed", { gameId, reason: details.reason, exitCode: details.exitCode });
        this.#finish(gameId, entry, "crashed");
        if (!window.isDestroyed()) window.destroy();
      },
    );
    let asking = false;
    window.on("unresponsive", () => {
      if (asking || !ACTIVE.has(entry.state)) return;
      asking = true;
      log.warn("game.unresponsive", { gameId });
      dialogs
        .confirm({
          title: "The game is not responding",
          message:
            "You can wait for it, or force it to close. Progress it has not saved may be lost.",
          confirmLabel: "Force close",
          cancelLabel: "Wait",
        })
        .then(
          (force) => {
            if (force && !window.isDestroyed() && ACTIVE.has(entry.state)) {
              log.warn("game.force-close", { gameId });
              this.#forceClose(gameId, entry, window);
            }
          },
          (error: unknown) => log.error("game.unresponsive-dialog-failed", { gameId, error }),
        )
        .finally(() => {
          asking = false;
        });
    });
  }

  /**
   * Force close: each step runs only while the session is still active after the step before it (the
   * `render-process-gone` handler ends it as crashed and destroys the window).
   */
  #forceClose(gameId: string, entry: Entry, window: GameWindow): void {
    const { log } = this.#deps;
    const stepMs = this.#deps.forceCloseStepMs ?? FORCE_CLOSE_STEP_MS;
    const kill = this.#deps.killProcess ?? ((pid: number) => process.kill(pid, "SIGKILL"));
    const stillOpen = () => ACTIVE.has(entry.state) && !window.isDestroyed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    entry.done.promise.then(() => clearTimeout(timer));
    window.webContents.forcefullyCrashRenderer();
    timer = setTimeout(() => {
      if (!stillOpen()) return;
      log.warn("game.force-close-kill", { gameId });
      try {
        const pid = window.webContents.getOSProcessId();
        if (pid > 0) kill(pid);
      } catch (error) {
        log.warn("game.force-close-kill-failed", { gameId, error });
      }
      timer = setTimeout(() => {
        if (!stillOpen()) return;
        log.error("game.force-close-destroy", { gameId });
        this.#finish(gameId, entry, "crashed");
        window.destroy();
      }, stepMs);
    }, stepMs);
  }

  #set(gameId: string, entry: Entry, state: GameState): void {
    entry.state = state;
    this.#deps.onState?.(gameId, state);
  }

  #finish(gameId: string, entry: Entry, state: "exited" | "crashed"): void {
    if (entry.state === "exited" || entry.state === "crashed") return;
    this.#set(gameId, entry, state);
    entry.lease?.release();
    entry.lease = null;
    entry.done.resolve();
    if (state === "exited") this.#deps.log.info("game.exited", { gameId });
  }
}
