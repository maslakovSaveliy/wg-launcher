// The close procedure of architecture.md section 4 (MUST, AC-13, spike finding H16). The window's `close` event is
// prevented by the caller, which then runs `closeGameWindow`:
// 1. hide the window and stop playtime, so time spent here is not counted;
// 2. load `about:blank` in the same `webContents`, so the game's `beforeunload`, `pagehide` and `unload` handlers
//    run and can save. A `beforeunload` trap (`will-prevent-unload`) asks the user; on "Stay" the window is shown
//    again and the game keeps running, on "Leave" (or when the dialog fails) the unload runs again with the trap
//    ignored. An unload that does not finish within `unloadMs` cannot block closing (Assumed bound: 2 s);
// 3. attach `webContents.debugger`, send `ServiceWorker.enable` and `ServiceWorker.stopAllWorkers`, wait until the
//    session has no running service worker (at most `workersMs`, 2 s), then `ServiceWorker.stopWorker` for each
//    version still running, and log `SW_STOP_FAILED` if that does not help either;
// 4. destroy the window.

import type { Dialogs } from "../dialogs.js";
import type { Logger } from "../log/logger.js";

/** The parts of a BrowserWindow the procedure uses (a structural type, so the unit test can pass a fake). */
export interface ClosableWindow {
  hide(): void;
  show(): void;
  destroy(): void;
  isDestroyed(): boolean;
  webContents: {
    loadURL(url: string): Promise<void>;
    on(
      event: "will-prevent-unload",
      listener: (event: { preventDefault(): void }) => void,
    ): unknown;
    off(
      event: "will-prevent-unload",
      listener: (event: { preventDefault(): void }) => void,
    ): unknown;
    debugger: {
      attach(protocolVersion?: string): void;
      detach(): void;
      isAttached(): boolean;
      sendCommand(method: string, commandParams?: object): Promise<unknown>;
    };
    session: { serviceWorkers: { getAllRunning(): Record<number, unknown> } };
  };
}

export interface CloseTiming {
  unloadMs: number;
  workersMs: number;
  pollMs: number;
}

export const CLOSE_TIMING: CloseTiming = { unloadMs: 2000, workersMs: 2000, pollMs: 50 };
/** A CDP command that does not answer within this time is given up (a hung renderer must not block closing). */
const COMMAND_TIMEOUT_MS = 1000;

export interface CloseDeps {
  gameId: string;
  log: Logger;
  dialogs: Pick<Dialogs, "confirm">;
  /** Step 1: stop counting playtime (wired with the playtime recorder). */
  stopPlaytime?: () => void;
  timing?: CloseTiming;
}

export type CloseOutcome = "closed" | "stayed";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Step 2. Resolves "stayed" when the user chose to stay in the game. */
async function unload(window: ClosableWindow, deps: CloseDeps, timing: CloseTiming) {
  const contents = window.webContents;
  let leave = false;
  let trapped = false;
  const onTrap = (event: { preventDefault(): void }) => {
    if (leave) event.preventDefault();
    else trapped = true;
  };
  contents.on("will-prevent-unload", onTrap);
  try {
    for (;;) {
      trapped = false;
      const result = await within(
        contents.loadURL("about:blank").then(
          () => "loaded" as const,
          (error: unknown) => error,
        ),
        timing.unloadMs,
      );
      if (result === "timeout") {
        deps.log.warn("game.close.unload-timeout", {
          gameId: deps.gameId,
          waitedMs: timing.unloadMs,
        });
        return "unloaded";
      }
      if (!trapped || leave) return "unloaded";
      // The page refused to unload: the user decides (the dialog is modal to the launcher, the game stays hidden).
      deps.log.info("game.close.unload-prevented", { gameId: deps.gameId });
      let stay: boolean;
      try {
        stay = !(await deps.dialogs.confirm({
          title: "Leave the game?",
          message: "The game asks you to stay. Progress it has not saved may be lost if you leave.",
          confirmLabel: "Leave",
          cancelLabel: "Stay",
        }));
      } catch (error) {
        deps.log.error("game.close.dialog-failed", { gameId: deps.gameId, error });
        stay = false;
      }
      if (stay) return "stayed";
      leave = true;
    }
  } finally {
    contents.off("will-prevent-unload", onTrap);
  }
}

/** Step 3. */
async function stopServiceWorkers(window: ClosableWindow, deps: CloseDeps, timing: CloseTiming) {
  const contents = window.webContents;
  const running = () => Object.keys(contents.session.serviceWorkers.getAllRunning());
  const waitForNone = async (ms: number) => {
    const until = Date.now() + ms;
    while (running().length > 0 && Date.now() < until) await sleep(timing.pollMs);
    return running();
  };
  const debug = contents.debugger;
  const send = async (method: string, params?: object) => {
    const result = await within(debug.sendCommand(method, params), COMMAND_TIMEOUT_MS);
    if (result === "timeout") throw new Error(`${method} did not answer`);
  };
  let attached = false;
  try {
    debug.attach("1.3");
    attached = true;
    await send("ServiceWorker.enable");
    await send("ServiceWorker.stopAllWorkers");
    let left = await waitForNone(timing.workersMs);
    if (left.length > 0) {
      deps.log.warn("game.close.workers-left", { gameId: deps.gameId, running: left.length });
      for (const versionId of left) await send("ServiceWorker.stopWorker", { versionId });
      left = await waitForNone(timing.workersMs);
      if (left.length > 0)
        deps.log.error("SW_STOP_FAILED", { gameId: deps.gameId, running: left.length });
    }
  } catch (error) {
    deps.log.error("game.close.debugger-failed", { gameId: deps.gameId, error });
  } finally {
    if (attached) {
      try {
        debug.detach();
      } catch {
        // The window may already be going away; nothing is left to clean up.
      }
    }
  }
}

export async function closeGameWindow(
  window: ClosableWindow,
  deps: CloseDeps,
): Promise<CloseOutcome> {
  const timing = deps.timing ?? CLOSE_TIMING;
  window.hide();
  deps.stopPlaytime?.();
  if (window.isDestroyed()) return "closed";

  if ((await unload(window, deps, timing)) === "stayed") {
    if (!window.isDestroyed()) window.show();
    return "stayed";
  }
  if (!window.isDestroyed()) await stopServiceWorkers(window, deps, timing);
  if (!window.isDestroyed()) window.destroy();
  return "closed";
}
