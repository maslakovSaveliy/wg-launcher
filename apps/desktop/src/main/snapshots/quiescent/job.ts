// The quiescent job runner (save-transfer.md section 5, steps 1 to 12, QW-1 to QW-10): a hidden window on the game's
// own partition whose documents are our empty stubs, our code in its isolated world, never the game's code.
//
//  1. Lock: the per-game lease (`task` for what the user asked, `background` for a storage check, M5).
//  2. Interceptor: the job's exact stub URLs, 403 for anything else, no network (interceptor.ts).
//  3. Window: hidden, sandboxed, context-isolated, the quiescent preload, subframes only when a key is in an iframe.
//  4. Debugger: `about:blank` first (debugger commands wait forever on a window that never navigated), then attach;
//     the canary watches from here on.
//  5. Service workers: `ServiceWorker.enable` and `stopAllWorkers`, then none may run within 10 s.
//  6. Bypass: `Network.setBypassServiceWorker` and auto-attach (paused) on the page, the same on every child target
//     before it runs; `Debugger` and `Runtime` everywhere for the canary. QW-2: the window must be the session's only
//     `webContents`. Only then the first navigation.
//  7. Navigations of layout.ts, one after another; 8. each frame's storage key resolved through CDP and compared;
//  9. the handshake (handshake.ts) gives each expected frame one end of a `MessageChannelMain`, the other end goes to
//     the plan (the snapshot worker); 10. the plan runs its commands over those ports.
// 11. The canary (canary.ts) aborts the job at its first violation; its verdict is taken after the last navigation.
// 12. Whatever happened: destroy the window, detach the debugger, remove the interceptor, the listeners and the
//     handshake channel, then (after the plan's commit or discard) release the lease. A watchdog ends a job that
//     takes longer than 60 s plus 1 s per MiB the plan reported (Assumed).
//
// Log lines carry the job's game id, step, counts, sizes and codes: never values, key names or URLs with queries
// (QW-9; stub URLs carry the job nonce, so only their origins are logged).
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { Lease, LockRefusal } from "../../games/locks.js";
import type { Logger } from "../../log/logger.js";
import { createCanary } from "./canary.js";
import {
  createHandshake,
  HELLO_CHANNEL,
  type HelloEvent,
  newJobNonce,
  PORT_CHANNEL,
} from "./handshake.js";
import { type InterceptorSession, installInterceptor } from "./interceptor.js";
import { type FrameSlot, type JobKey, layOutNavigations } from "./layout.js";

export type { JobKey } from "./layout.js";

/**
 * Which service-worker bypass the job sends (save-transfer.md section 5, step 6); anything but `all` is a test
 * control.
 */
export type Bypass = "all" | "top-only" | "none";

export interface ConnectedFrame {
  key: JobKey;
  /** The worker's end of the frame's channel (a `MessagePortMain`). */
  port: unknown;
}

export interface JobContext {
  /** Aborted by a cancelled lease (M5), the caller's signal, the canary or the watchdog. */
  signal: AbortSignal;
  /** Bytes the plan moved, for the watchdog's deadline. */
  addBytes(bytes: number): void;
}

export interface JobPlan<T> {
  /** Picks the quiescence code: `EXP_QUIESCENCE_VIOLATION` or `IMP_QUIESCENCE_VIOLATION`. */
  direction: "export" | "import";
  lock: "task" | "background";
  keys: readonly JobKey[];
  /** Called once the lease is held (the IPC handler then answers with a task id). */
  onLocked?(): void;
  /** Runs once per navigation with the frames of that navigation, connected. */
  runFrames(
    frames: readonly ConnectedFrame[],
    context: JobContext,
  ): Promise<Result<void, ErrorCode>>;
  /** After a clean canary verdict and the window's teardown, still under the lease. */
  commit(context: JobContext): Promise<Result<T, ErrorCode>>;
  /** After any failure, instead of `commit`. */
  discard(): Promise<void>;
  /** Test controls only (open check 3); production always sends `all`. */
  bypass?: Bypass;
}

type Listener = (...args: never[]) => void;

export interface JobDebugger {
  attach(protocolVersion: string): void;
  detach(): void;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(event: "message" | "detach", listener: Listener): unknown;
  removeListener(event: "message" | "detach", listener: Listener): unknown;
}

export interface JobFrame {
  url: string;
  postMessage(channel: string, message: unknown, transfer: unknown[]): void;
}

export interface JobWindow {
  webContents: { loadURL(url: string): Promise<void>; debugger: JobDebugger };
  destroy(): void;
  isDestroyed(): boolean;
}

export interface JobSession extends InterceptorSession {
  serviceWorkers: {
    getAllRunning(): Record<number, unknown>;
    on(event: "running-status-changed", listener: Listener): unknown;
    removeListener(event: "running-status-changed", listener: Listener): unknown;
  };
}

export interface JobDeps {
  locks: { acquire(gameId: string, kind: "task" | "background"): Promise<Lease | LockRefusal> };
  /** The game's session with its policy installed (`gameSession`). */
  session(gameId: string): JobSession;
  createWindow(options: { session: JobSession; preload: string; subframes: boolean }): JobWindow;
  /** How many `webContents` use `session` now (QW-2). */
  contentsOn(session: JobSession): number;
  ipc: {
    on(
      channel: string,
      listener: (event: HelloEvent & { senderFrame: JobFrame | null }, message: unknown) => void,
    ): unknown;
    removeListener(channel: string, listener: Listener): unknown;
  };
  /** `new MessageChannelMain()`. */
  newChannel(): { port1: unknown; port2: unknown };
  /** The quiescent preload's path (also its script URL in CDP, for the canary). */
  preloadPath: string;
  log: Logger;
  timing?: Partial<JobTiming>;
  /** Test flavor only: runs after each stub navigation (the canary controls inject a script or start a worker). */
  afterNavigation?(window: JobWindow, session: JobSession): Promise<void>;
}

export interface JobTiming {
  loadMs: number;
  commandMs: number;
  workersMs: number;
  handshakeMs: number;
  pollMs: number;
  deadlineMs: number;
  deadlinePerMiBMs: number;
}

export const JOB_TIMING: JobTiming = {
  loadMs: 20_000,
  commandMs: 5_000,
  workersMs: 10_000,
  handshakeMs: 10_000,
  pollMs: 50,
  deadlineMs: 60_000,
  deadlinePerMiBMs: 1_000,
};

type Failure = { ok: false; code: ErrorCode; message: string };
const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });
const OK = { ok: true, data: undefined } as const;

class JobStop extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
    this.name = "JobStop";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `<origin>/` or `<origin>/^0<site>`: the two forms of `Storage.getStorageKey` observed (save-transfer.md section
 * 2).
 */
export function parseStorageKey(
  text: string,
): { origin: string; topLevelSite: string | null } | null {
  const canonical = (value: string, port: boolean) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === value &&
        (port || url.port === "")
      );
    } catch {
      return false;
    }
  };
  const split = text.indexOf("/^0");
  if (split === -1) {
    const origin = text.endsWith("/") ? text.slice(0, -1) : "";
    return !text.includes("^") && canonical(origin, true) ? { origin, topLevelSite: null } : null;
  }
  const origin = text.slice(0, split);
  const site = text.slice(split + 3);
  return !site.includes("^") && canonical(origin, true) && canonical(site, false)
    ? { origin, topLevelSite: site }
    : null;
}

/** Collects `{frameId, url}` of a `Page.getFrameTree` result. */
function framesOf(tree: unknown, out: Array<{ id: string; url: string }> = []) {
  const node = tree as { frame?: { id?: unknown; url?: unknown }; childFrames?: unknown[] } | null;
  const { id, url } = node?.frame ?? {};
  if (typeof id === "string" && typeof url === "string") out.push({ id, url });
  for (const child of node?.childFrames ?? []) framesOf(child, out);
  return out;
}

export async function runQuiescentJob<T>(
  gameId: string,
  plan: JobPlan<T>,
  deps: JobDeps,
  signal?: AbortSignal,
): Promise<Result<T, ErrorCode>> {
  const timing = { ...JOB_TIMING, ...deps.timing };
  const { log } = deps;
  const quiet =
    plan.direction === "export" ? "EXP_QUIESCENCE_VIOLATION" : "IMP_QUIESCENCE_VIOLATION";

  // Step 1.
  const lease = await deps.locks.acquire(gameId, plan.lock);
  if (!("release" in lease)) {
    log.info("snapshot.job.refused", { gameId, code: lease.code });
    return fail(lease.code, refusalMessage(lease.code));
  }
  const abort = new AbortController();
  let stopped: Failure | null = null;
  const stop = (failure: Failure) => {
    if (stopped !== null) return;
    stopped = failure;
    abort.abort(new JobStop(failure));
  };
  const onCancel = () => stop(fail("CANCELLED", "The job was cancelled."));
  lease.signal.addEventListener("abort", onCancel);
  signal?.addEventListener("abort", onCancel);
  if (lease.signal.aborted || signal?.aborted) onCancel();
  let bytes = 0;
  const startedAt = Date.now();
  const watchdog = setInterval(
    () => {
      const allowed = timing.deadlineMs + (timing.deadlinePerMiBMs * bytes) / 2 ** 20;
      if (Date.now() - startedAt > allowed) {
        stop(
          fail(plan.direction === "export" ? "EXP_TIMEOUT" : "INTERNAL", "The job took too long."),
        );
      }
    },
    Math.min(500, timing.deadlineMs),
  );
  const context: JobContext = {
    signal: abort.signal,
    addBytes: (n) => {
      bytes += n;
    },
  };

  try {
    plan.onLocked?.();
    log.info("snapshot.job.start", { gameId, keys: plan.keys.length, lock: plan.lock });
    const windowed = await quiescentWindow(gameId, plan, deps, timing, context, stop, quiet);
    const failure: Failure | null = stopped ?? (windowed.ok ? null : windowed);
    if (failure !== null) {
      await plan
        .discard()
        .catch((error: unknown) => log.error("snapshot.job.discard-failed", { gameId, error }));
      log.warn("snapshot.job.failed", { gameId, code: failure.code });
      return failure;
    }
    let committed: Result<T, ErrorCode>;
    try {
      committed = await plan.commit(context);
    } catch (error) {
      log.error("snapshot.job.commit-threw", { gameId, error });
      committed = fail("INTERNAL", "Something went wrong.");
    }
    const outcome = stopped ?? committed;
    if (outcome.ok) log.info("snapshot.job.done", { gameId });
    else log.warn("snapshot.job.failed", { gameId, code: outcome.code, step: "commit" });
    return outcome;
  } finally {
    clearInterval(watchdog);
    lease.signal.removeEventListener("abort", onCancel);
    signal?.removeEventListener("abort", onCancel);
    lease.release();
  }
}

function refusalMessage(code: LockRefusal["code"]): string {
  switch (code) {
    case "GAME_RUNNING":
      return "Close the game first.";
    case "GAME_BUSY":
      return "Another task for this game is running.";
    case "NEEDS_RECOVERY":
      return "This game needs recovery first.";
    case "INTERNAL":
      return "Something went wrong.";
  }
}

/** Steps 2 to 12 but the lease. Returns a failure value; throws nothing. */
async function quiescentWindow<T>(
  gameId: string,
  plan: JobPlan<T>,
  deps: JobDeps,
  timing: JobTiming,
  context: JobContext,
  stop: (failure: Failure) => void,
  quiet: ErrorCode,
): Promise<Result<void, ErrorCode>> {
  const { log } = deps;
  const nonce = newJobNonce();
  const layout = layOutNavigations(plan.keys, nonce);
  const bypass = plan.bypass ?? "all";
  const ses = deps.session(gameId);
  const canary = createCanary({
    preloadPath: deps.preloadPath,
    onViolation: (violation, detail) => {
      log.error("snapshot.quiescent.violation", { gameId, violation, ...detail });
      stop(fail(quiet, "Game code started while the save data was read, so the job was stopped."));
    },
  });

  const cleanups: Array<() => void> = [];
  let tearingDown = false;
  /** Rejects as soon as the job is stopped, so no wait outlives it. */
  const guard = <V>(promise: Promise<V>, ms: number, what: string): Promise<V> =>
    new Promise<V>((resolve, reject) => {
      if (context.signal.aborted) {
        reject(context.signal.reason);
        return;
      }
      const timer = setTimeout(
        () => reject(new JobStop(fail("EXP_TIMEOUT", `${what} timed out.`))),
        ms,
      );
      const onAbort = () => reject(context.signal.reason);
      context.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });

  try {
    // Step 2.
    const interceptor = installInterceptor(ses, layout.pages, log);
    cleanups.push(() => interceptor.dispose());

    // Step 3.
    const window = deps.createWindow({
      session: ses,
      preload: deps.preloadPath,
      subframes: layout.subframes,
    });
    cleanups.push(() => {
      if (!window.isDestroyed()) window.destroy();
    });

    // Step 4.
    await guard(window.webContents.loadURL("about:blank"), timing.loadMs, "Opening the job window");
    const dbg = window.webContents.debugger;
    dbg.attach("1.3");
    const children: Array<{ sessionId: string }> = [];
    const send = (method: string, params?: object, sessionId?: string) =>
      guard(dbg.sendCommand(method, params, sessionId), timing.commandMs, method);
    const watch = async (sessionId: string | undefined, withBypass: boolean) => {
      await send("Network.enable", {}, sessionId);
      if (withBypass) await send("Network.setBypassServiceWorker", { bypass: true }, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Debugger.enable", {}, sessionId);
      await send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        sessionId,
      );
    };
    const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
      canary.onDebuggerMessage(method, params, sessionId);
      if (method !== "Target.attachedToTarget") return;
      const { sessionId: child, targetInfo } = params as {
        sessionId: string;
        targetInfo: { type: string };
      };
      // A worker target stays paused: the canary has stopped the job already.
      if (targetInfo.type !== "iframe") return;
      children.push({ sessionId: child });
      watch(child, bypass === "all")
        .then(() => dbg.sendCommand("Runtime.runIfWaitingForDebugger", {}, child))
        .catch(() => {
          if (!tearingDown) stop(fail(quiet, "A frame of the job window could not be watched."));
        });
    };
    const onDetach = () => {
      if (!tearingDown) canary.onDebuggerDetached();
    };
    dbg.on("message", onMessage as Listener);
    dbg.on("detach", onDetach);
    cleanups.push(() => {
      dbg.removeListener("message", onMessage as Listener);
      dbg.removeListener("detach", onDetach);
      try {
        dbg.detach();
      } catch {
        // Destroying the window detached it already.
      }
    });

    // Step 5.
    await send("ServiceWorker.enable");
    await send("ServiceWorker.stopAllWorkers");
    const running = () => Object.keys(ses.serviceWorkers.getAllRunning()).length;
    const until = Date.now() + timing.workersMs;
    while (running() > 0 && Date.now() < until)
      await guard(sleep(timing.pollMs), timing.pollMs * 4, "Waiting");
    if (running() > 0) {
      log.error("snapshot.quiescent.workers-running", { gameId, running: running() });
      return fail(quiet, "A service worker of the game kept running, so its data was not read.");
    }
    const onStatus = (details: { runningStatus: string }) => canary.onWorkerStatus(details);
    ses.serviceWorkers.on("running-status-changed", onStatus as Listener);
    cleanups.push(() =>
      ses.serviceWorkers.removeListener("running-status-changed", onStatus as Listener),
    );

    // Step 6.
    await watch(undefined, bypass !== "none");
    if (deps.contentsOn(ses) !== 1) {
      log.error("snapshot.quiescent.not-exclusive", { gameId, contents: deps.contentsOn(ses) });
      return fail(quiet, "Another window uses the game's storage, so its data was not read.");
    }

    // Steps 7 to 10, one navigation after another.
    let current: ReturnType<typeof createHandshake<FrameSlot>> | null = null;
    const greeted = new Map<string, JobFrame>();
    const onHello = (event: HelloEvent & { senderFrame: JobFrame | null }, message: unknown) => {
      if (current === null) return;
      const accepted = current.accept(event, message);
      if (accepted.ok && event.senderFrame) greeted.set(event.senderFrame.url, event.senderFrame);
      else if (!accepted.ok)
        log.warn("snapshot.quiescent.hello-refused", { gameId, reason: accepted.reason });
    };
    deps.ipc.on(HELLO_CHANNEL, onHello);
    cleanups.push(() => deps.ipc.removeListener(HELLO_CHANNEL, onHello as Listener));

    for (const [step, navigation] of layout.navigations.entries()) {
      greeted.clear();
      current = createHandshake({
        contents: window.webContents,
        jobNonce: nonce,
        frames: new Map(navigation.frames.map((slot) => [slot.url, slot])),
      });
      await guard(
        window.webContents.loadURL(navigation.topUrl),
        timing.loadMs,
        "A stub navigation",
      );
      await deps.afterNavigation?.(window, ses);
      log.info("snapshot.quiescent.navigated", {
        gameId,
        step,
        origin: new URL(navigation.topUrl).origin,
        frames: navigation.frames.length,
      });

      // Step 8.
      const keyed = await resolveKeys(navigation.frames, send, children);
      if (!keyed.ok) {
        log.error("snapshot.quiescent.key-check-failed", { gameId, code: keyed.code });
        return keyed;
      }

      // Step 9.
      const handshake = current;
      const deadline = Date.now() + timing.handshakeMs;
      while (handshake.pending().length > 0 && Date.now() < deadline) {
        await guard(sleep(timing.pollMs), timing.pollMs * 4, "Waiting");
      }
      if (handshake.pending().length > 0) {
        log.error("snapshot.quiescent.handshake-timeout", {
          gameId,
          missing: handshake.pending().length,
        });
        return fail("EXP_TIMEOUT", "A frame of the job window did not answer.");
      }
      const frames = navigation.frames.map((slot): ConnectedFrame => {
        const { port1, port2 } = deps.newChannel();
        (greeted.get(slot.url) as JobFrame).postMessage(PORT_CHANNEL, null, [port1]);
        return { key: slot.key, port: port2 };
      });
      current = null;

      // Step 10.
      const ran = await plan.runFrames(frames, context);
      if (!ran.ok) return ran;
      if (context.signal.aborted) return fail(quiet, "The job was stopped.");
    }

    // Step 11.
    if (canary.violation() !== null)
      return fail(quiet, "Game code started while the save data was read.");
    log.info("snapshot.quiescent.clean", {
      gameId,
      navigations: layout.navigations.length,
      scripts: canary.scripts(),
      refused: interceptor.refused().length,
    });
    return OK;
  } catch (error) {
    if (error instanceof JobStop) return error.failure;
    log.error("snapshot.quiescent.failed", { gameId, error });
    return fail("INTERNAL", "The job window failed.");
  } finally {
    // Step 12 (the lease is released by the caller, after commit or discard).
    tearingDown = true;
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        log.error("snapshot.quiescent.cleanup-failed", { gameId, error });
      }
    }
  }
}

/** Step 8: each frame's Chromium storage key, parsed and compared with the key the job expects there. */
async function resolveKeys(
  slots: readonly FrameSlot[],
  send: (method: string, params?: object, sessionId?: string) => Promise<unknown>,
  children: ReadonlyArray<{ sessionId: string }>,
): Promise<Result<void, ErrorCode>> {
  const where = new Map<string, { frameId: string; sessionId?: string }>();
  for (const frame of framesOf(
    ((await send("Page.getFrameTree")) as { frameTree?: unknown }).frameTree,
  )) {
    where.set(frame.url, { frameId: frame.id });
  }
  // A cross-site iframe is a target of its own; its frame is asked through its session.
  for (const { sessionId } of children) {
    let tree: unknown;
    try {
      tree = ((await send("Page.getFrameTree", {}, sessionId)) as { frameTree?: unknown })
        .frameTree;
    } catch {
      continue; // a frame of an earlier navigation, gone
    }
    for (const frame of framesOf(tree)) where.set(frame.url, { frameId: frame.id, sessionId });
  }
  for (const slot of slots) {
    const location = where.get(slot.url);
    if (location === undefined) return fail("EXP_TIMEOUT", "A frame of the job window is missing.");
    const { storageKey } = (await send(
      "Storage.getStorageKey",
      { frameId: location.frameId },
      location.sessionId,
    )) as { storageKey?: unknown };
    const parsed = typeof storageKey === "string" ? parseStorageKey(storageKey) : null;
    if (parsed === null) {
      return fail("EXP_UNSUPPORTED_STORAGE_KEY", "A frame has a storage key of an unknown form.");
    }
    if (parsed.origin !== slot.key.origin || parsed.topLevelSite !== slot.key.topLevelSite) {
      return fail(
        "EXP_STORAGE_KEY_MISMATCH",
        "A frame's storage key differs from the expected one.",
      );
    }
  }
  return OK;
}
