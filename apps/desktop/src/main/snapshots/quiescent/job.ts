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
//     takes longer than 60 s plus 1 s per MiB the plan reported (Assumed), its commit included: a commit still
//     pending then is left to the plan's discard.
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
import { type JobSlots, SNAPSHOT_JOB_SLOTS } from "./slots.js";
import { type Failure, fail, failureOf, JobStop } from "./stop.js";
import { type JobDebugger, watchTargets } from "./targets.js";
import { WorkerScopes, workerScopeOrigin } from "./worker-scopes.js";

export type { JobKey } from "./layout.js";
export { JobSlots, SNAPSHOT_JOB_SLOTS } from "./slots.js";
export { failureOf } from "./stop.js";
export type { JobDebugger } from "./targets.js";
export { parseStorageKey } from "./targets.js";

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
  /**
   * Called by `commit` right after its result became durable (the export's database transaction): from then on a
   * stop never discards the commit, whose outcome the job waits for.
   */
  committed(): void;
  /**
   * CDP `Storage.clearDataForStorageKey` for a key of the current navigation, with `storageTypes` (a CDP list such as
   * `local_storage,indexeddb`); inside `runFrames` only.
   */
  clearStorage(key: JobKey, storageTypes: string): Promise<void>;
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
  /**
   * After a clean canary verdict and the window's teardown, still under the lease. It must check `context.signal`
   * before it commits anything: its result is the job's.
   */
  commit(context: JobContext): Promise<Result<T, ErrorCode>>;
  /**
   * After any failure, instead of `commit`; also after a `commit` that had not settled when the job was stopped
   * (the watchdog, a cancel): then it must end that commit's work and leave nothing of it behind.
   */
  discard(): Promise<void>;
  /** Test controls only (open check 3); production always sends `all`. */
  bypass?: Bypass;
  /** Another session than the game's (verify's fresh in-memory partition); QW-2 counts its `webContents`. */
  session?: JobSession;
}

type Listener = (...args: never[]) => void;

export interface JobFrame {
  url: string;
  postMessage(channel: string, message: unknown, transfer: unknown[]): void;
}

/** The handshake's IPC as one window's `webContents.ipc` offers it, so a job hears its own window only. */
export interface JobIpc {
  on(
    channel: string,
    listener: (event: HelloEvent & { senderFrame: JobFrame | null }, message: unknown) => void,
  ): unknown;
  removeListener(channel: string, listener: Listener): unknown;
}

export interface JobWindow {
  webContents: { loadURL(url: string): Promise<void>; debugger: JobDebugger; ipc: JobIpc };
  destroy(): void;
  isDestroyed(): boolean;
}

export interface JobSession extends InterceptorSession {
  serviceWorkers: {
    getAllRunning(): Record<number, unknown>;
    /** The scope of a worker version, for the canary's log (its origin only). */
    getInfoFromVersionID(versionId: number): { scope: string } | null | undefined;
    on(event: "running-status-changed", listener: Listener): unknown;
    removeListener(event: "running-status-changed", listener: Listener): unknown;
  };
}

export interface JobDeps {
  locks: {
    acquire(gameId: string, kind: "task" | "background"): Promise<Lease | LockRefusal>;
    /** A `task` lease although the game is marked `needs_recovery` (the rollback that clears the mark). */
    acquireForRecovery?(gameId: string): Promise<Lease | LockRefusal>;
  };
  /** The game's session with its policy installed (`gameSession`). */
  session(gameId: string): JobSession;
  createWindow(options: { session: JobSession; preload: string; subframes: boolean }): JobWindow;
  /** How many `webContents` use `session` now (QW-2). */
  contentsOn(session: JobSession): number;
  /** `new MessageChannelMain()`. */
  newChannel(): { port1: unknown; port2: unknown };
  /** The quiescent preload's path (also its script URL in CDP, for the canary). */
  preloadPath: string;
  log: Logger;
  timing?: Partial<JobTiming>;
  /** Test flavor only: runs after each stub navigation (the canary controls inject a script or start a worker). */
  afterNavigation?(
    window: JobWindow,
    session: JobSession,
    lock: "task" | "background",
  ): Promise<void>;
  /** Test flavor only: the e2e harness's own isolated world (canary.ts). */
  harnessWorld?(name: string): boolean;
  /** The cap on jobs running at once; the process-wide one unless a test passes its own. */
  slots?: JobSlots;
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

const OK = { ok: true, data: undefined } as const;

/** `JobContext.clearStorage` outside `runFrames`: there is no frame (or no window) to clear through. */
const noFrames: JobContext["clearStorage"] = async () => {
  throw new JobStop(fail("INTERNAL", "No frame of this navigation resolves that key."));
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A lease and a job slot held across several quiescent windows (a restore runs R4 to R7 under one lock, R3). */
export interface QuiescentHold {
  readonly gameId: string;
  readonly lock: "task" | "background";
  /** Aborted when the hold is cancelled (a launch cancelling a background lease, the caller's signal). */
  readonly signal: AbortSignal;
  /** Runs steps 2 to 12 of one quiescent window under this hold; the plan's `lock` is ignored. */
  run<T>(plan: JobPlan<T>): Promise<Result<T, ErrorCode>>;
  /** Gives the slot back, then the lease. Idempotent. */
  release(): void;
}

/**
 * Step 1 alone: the game's lease (`recovery` takes it although the game is marked `needs_recovery`, for the
 * rollback that clears the mark) and a job slot. The caller runs windows with `run` and must `release`.
 */
export async function holdQuiescentJob(
  gameId: string,
  lock: "task" | "background",
  deps: JobDeps,
  options: { signal?: AbortSignal; recovery?: boolean } = {},
): Promise<Result<QuiescentHold, ErrorCode>> {
  const { log } = deps;
  const { signal } = options;
  const lease =
    options.recovery && deps.locks.acquireForRecovery
      ? await deps.locks.acquireForRecovery(gameId)
      : await deps.locks.acquire(gameId, lock);
  if (!("release" in lease)) {
    log.info("snapshot.job.refused", { gameId, code: lease.code });
    return fail(lease.code, refusalMessage(lease.code));
  }
  const cancelled = new AbortController();
  const onCancel = () => {
    if (!cancelled.signal.aborted) {
      cancelled.abort(new JobStop(fail("CANCELLED", "The job was cancelled.")));
    }
  };
  // A user task may take a background job's slot (slots.ts): the background job is then cancelled like this.
  const slots = deps.slots ?? SNAPSHOT_JOB_SLOTS;
  const slot = await slots.take(lock, onCancel);
  if (!slot.ok) {
    lease.release();
    if (slot.code === "INTERNAL") {
      log.error("snapshot.job.slot-not-released", { gameId, waitedMs: slots.releaseTimeoutMs });
      return fail("INTERNAL", "Something went wrong.");
    }
    log.info("snapshot.job.refused", { gameId, code: "GAME_BUSY", reason: "job-cap" });
    return fail(
      "GAME_BUSY",
      "Two snapshot jobs are running already; try again when one has finished.",
    );
  }
  lease.signal.addEventListener("abort", onCancel);
  signal?.addEventListener("abort", onCancel);
  if (lease.signal.aborted || signal?.aborted) onCancel();
  let released = false;
  return {
    ok: true,
    data: {
      gameId,
      lock,
      signal: cancelled.signal,
      run: (plan) => runWindow(gameId, lock, plan, deps, cancelled.signal),
      release() {
        if (released) return;
        released = true;
        lease.signal.removeEventListener("abort", onCancel);
        signal?.removeEventListener("abort", onCancel);
        slot.give();
        lease.release();
      },
    },
  };
}

export async function runQuiescentJob<T>(
  gameId: string,
  plan: JobPlan<T>,
  deps: JobDeps,
  signal?: AbortSignal,
): Promise<Result<T, ErrorCode>> {
  const held = await holdQuiescentJob(gameId, plan.lock, deps, signal ? { signal } : {});
  if (!held.ok) return held;
  try {
    plan.onLocked?.();
    return await held.data.run(plan);
  } finally {
    held.data.release();
  }
}

/** Steps 2 to 12 of one window, its commit or discard, under a hold whose `holdSignal` cancels it. */
async function runWindow<T>(
  gameId: string,
  lock: "task" | "background",
  plan: JobPlan<T>,
  deps: JobDeps,
  holdSignal: AbortSignal,
): Promise<Result<T, ErrorCode>> {
  const timing = { ...JOB_TIMING, ...deps.timing };
  const { log } = deps;
  const quiet =
    plan.direction === "export" ? "EXP_QUIESCENCE_VIOLATION" : "IMP_QUIESCENCE_VIOLATION";
  const abort = new AbortController();
  let stopped: Failure | null = null;
  const stop = (failure: Failure) => {
    if (stopped !== null) return;
    stopped = failure;
    abort.abort(new JobStop(failure));
  };
  const onCancel = () => stop(failureOf(holdSignal));
  holdSignal.addEventListener("abort", onCancel);
  if (holdSignal.aborted) onCancel();
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
  let durable = false;
  let clear: JobContext["clearStorage"] = noFrames;
  const context: JobContext = {
    signal: abort.signal,
    addBytes: (n) => {
      bytes += n;
    },
    committed: () => {
      durable = true;
    },
    clearStorage: (key, storageTypes) => clear(key, storageTypes),
  };
  const setClear = (next: JobContext["clearStorage"]) => {
    clear = next;
  };
  const planLocked = { ...plan, lock };

  try {
    log.info("snapshot.job.start", { gameId, keys: plan.keys.length, lock });
    const windowed = await quiescentWindow(
      gameId,
      planLocked,
      deps,
      timing,
      context,
      stop,
      quiet,
      setClear,
    );
    const failure: Failure | null = stopped ?? (windowed.ok ? null : windowed);
    if (failure !== null) {
      await plan
        .discard()
        .catch((error: unknown) => log.error("snapshot.job.discard-failed", { gameId, error }));
      log.warn("snapshot.job.failed", { gameId, lock, code: failure.code });
      return failure;
    }
    // The commit honors the context's signal itself, and once it has committed its outcome stands. A commit that
    // has not settled when the job is stopped (the watchdog, a cancel) is left: the plan's `discard` ends its work.
    const committing = plan.commit(context).catch((error: unknown) => {
      log.error("snapshot.job.commit-threw", { gameId, error });
      return fail("INTERNAL", "Something went wrong.");
    });
    const stoppedFirst = new Promise<"stopped">((resolve) => {
      if (abort.signal.aborted) resolve("stopped");
      abort.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    let settled = await Promise.race([committing, stoppedFirst]);
    // A commit that recorded its result before the stop landed stands: wait for it instead of discarding it.
    if (settled === "stopped" && durable) settled = await committing;
    let outcome: Result<T, ErrorCode>;
    if (settled === "stopped") {
      outcome = stopped ?? fail("CANCELLED", "The job was cancelled.");
      await plan
        .discard()
        .catch((error: unknown) => log.error("snapshot.job.discard-failed", { gameId, error }));
    } else {
      outcome = settled;
    }
    if (outcome.ok) log.info("snapshot.job.done", { gameId, lock });
    else log.warn("snapshot.job.failed", { gameId, lock, code: outcome.code, step: "commit" });
    return outcome;
  } finally {
    clearInterval(watchdog);
    holdSignal.removeEventListener("abort", onCancel);
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
  setClear: (clear: JobContext["clearStorage"]) => void,
): Promise<Result<void, ErrorCode>> {
  const { log } = deps;
  const nonce = newJobNonce();
  const layout = layOutNavigations(plan.keys, nonce);
  const bypass = plan.bypass ?? "all";
  const ses = plan.session ?? deps.session(gameId);
  const canary = createCanary({
    preloadPath: deps.preloadPath,
    ...(deps.harnessWorld ? { harnessWorld: deps.harnessWorld } : {}),
    onViolation: (violation, detail) => {
      log.error("snapshot.quiescent.violation", { gameId, violation, ...detail });
      stop(fail(quiet, "Game code started while the save data was read, so the job was stopped."));
    },
  });

  const cleanups: Array<() => void> = [];
  /** Rejects as soon as the job is stopped, so no wait outlives it, and after `ms` unless that is null. */
  const guard = <V>(promise: Promise<V>, ms: number | null, what: string): Promise<V> =>
    new Promise<V>((resolve, reject) => {
      if (context.signal.aborted) {
        reject(context.signal.reason);
        return;
      }
      const timer =
        ms === null
          ? undefined
          : setTimeout(() => reject(new JobStop(fail("EXP_TIMEOUT", `${what} timed out.`))), ms);
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
    const send = (method: string, params?: object, sessionId?: string) =>
      guard(dbg.sendCommand(method, params, sessionId), timing.commandMs, method);
    const workerScopes = new WorkerScopes();
    const targets = watchTargets({
      debugger: dbg,
      canary,
      send,
      bypassChildren: bypass === "all",
      onLost: () => stop(fail(quiet, "A frame of the job window could not be watched.")),
      onEvent: (method, params) => workerScopes.onEvent(method, params),
    });
    cleanups.push(() => targets.dispose());

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
    const onStatus = (details: { runningStatus: string; versionId: number }) => {
      const active = details.runningStatus === "starting" || details.runningStatus === "running";
      if (active) {
        // Which worker it is, by the origin of its scope (logged; the canary stops the job either way).
        const scopeOrigin =
          workerScopes.originOf(details.versionId) ?? workerScopeOrigin(ses, details.versionId);
        log.warn("snapshot.quiescent.worker-status", {
          gameId,
          status: details.runningStatus,
          scopeOrigin,
        });
        canary.onWorkerStatus({ runningStatus: details.runningStatus, scopeOrigin });
      } else {
        canary.onWorkerStatus(details);
      }
    };
    ses.serviceWorkers.on("running-status-changed", onStatus as Listener);
    cleanups.push(() =>
      ses.serviceWorkers.removeListener("running-status-changed", onStatus as Listener),
    );

    // Step 6.
    await targets.watchPage(bypass !== "none");
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
    const ipc = window.webContents.ipc;
    ipc.on(HELLO_CHANNEL, onHello);
    cleanups.push(() => ipc.removeListener(HELLO_CHANNEL, onHello as Listener));

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
      log.info("snapshot.quiescent.navigated", {
        gameId,
        lock: plan.lock,
        step,
        origin: new URL(navigation.topUrl).origin,
        frames: navigation.frames.length,
      });
      if (deps.afterNavigation) {
        await guard(deps.afterNavigation(window, ses, plan.lock), null, "The test control");
      }

      // Step 8.
      const chromiumKeys = new Map<string, string>();
      const keyed = await targets.resolveKeys(navigation.frames, chromiumKeys);
      if (!keyed.ok) {
        log.error("snapshot.quiescent.key-check-failed", { gameId, code: keyed.code });
        return keyed;
      }
      // R5's wipe of a frame's whole key: the Chromium key string is used here only, never stored or logged.
      setClear(async (key, storageTypes) => {
        const slot = navigation.frames.find((frame) => frame.key.index === key.index);
        const storageKey = slot === undefined ? undefined : chromiumKeys.get(slot.url);
        if (storageKey === undefined) {
          throw new JobStop(fail("INTERNAL", "No frame of this navigation resolves that key."));
        }
        await guard(
          dbg.sendCommand("Storage.clearDataForStorageKey", { storageKey, storageTypes }),
          timing.loadMs,
          "Clearing a storage key",
        );
      });

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
      // A stopped job (a launch cancelling a storage check, the canary, the watchdog) stops waiting at once.
      const ran = await guard(plan.runFrames(frames, context), null, "Reading").finally(() =>
        setClear(noFrames),
      );
      if (!ran.ok) return ran;
      if (context.signal.aborted) return fail(quiet, "The job was stopped.");
    }

    // Step 11.
    if (canary.violation() !== null)
      return fail(quiet, "Game code started while the save data was read.");
    log.info("snapshot.quiescent.clean", {
      gameId,
      lock: plan.lock,
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
    setClear(noFrames);
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        log.error("snapshot.quiescent.cleanup-failed", { gameId, error });
      }
    }
  }
}
