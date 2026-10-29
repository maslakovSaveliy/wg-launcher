import type { ErrorCode, Result } from "@wg-launcher/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lease, LockRefusal } from "../../games/locks.js";
import { HELLO_CHANNEL, PORT_CHANNEL } from "./handshake.js";
import {
  type ConnectedFrame,
  failureOf,
  holdQuiescentJob,
  type JobContext,
  type JobDeps,
  type JobKey,
  type JobPlan,
  type JobSession,
  JobSlots,
  type JobWindow,
  parseStorageKey,
  runQuiescentJob,
} from "./job.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const PRELOAD = "/app/out/preload/quiescent.cjs";
const TOP: JobKey = { index: 1, origin: "http://localhost:4317", topLevelSite: null, role: "top" };
const FRAME: JobKey = {
  index: 0,
  origin: "http://127.0.0.1:4317",
  topLevelSite: "http://localhost",
  role: "frame",
};
const FAST = {
  loadMs: 500,
  commandMs: 500,
  workersMs: 200,
  handshakeMs: 300,
  pollMs: 5,
  deadlineMs: 5_000,
  deadlinePerMiBMs: 0,
};

type Step =
  | "handle-http"
  | "webRequest"
  | "createWindow"
  | "load-blank"
  | "attach"
  | "ServiceWorker.enable"
  | "Network.setBypassServiceWorker"
  | "navigate"
  | "Storage.getStorageKey"
  | "runFrames"
  | "commit";

interface Options {
  throwAt?: Step;
  /** The storage key Chromium reports for a frame URL (default: the expected one). */
  storageKeyOf?: (key: JobKey) => string;
  /** Run after a stub navigation, with the fake debugger's emitter. */
  duringNavigation?: (emit: (method: string, params: unknown, sessionId?: string) => void) => void;
  contents?: number;
  workersRunning?: boolean;
  refuse?: LockRefusal["code"];
  silentFrame?: boolean;
  slots?: JobSlots;
}

const keyText = (key: JobKey) =>
  `${key.origin}/${key.topLevelSite === null ? "" : `^0${key.topLevelSite}`}`;

/** Every fake Electron object the job touches, with what is registered on each at any moment. */
function fakes(options: Options = {}) {
  const boom = (step: Step) => {
    if (options.throwAt === step) throw new Error(`boom at ${step}`);
  };
  const registered = {
    protocols: new Set<string>(),
    webRequest: false,
    debuggerListeners: 0,
    attached: false,
    workerListeners: 0,
    ipcListeners: 0,
    windows: 0,
    released: false,
  };
  const leaseController = new AbortController();
  const lease: Lease = {
    gameId: GAME,
    kind: "task",
    signal: leaseController.signal,
    release: () => {
      registered.released = true;
    },
  };
  const ipcListeners = new Set<(event: unknown, message: unknown) => void>();
  const helloChannels: string[] = [];
  const debuggerListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emit = (method: string, params: unknown, sessionId?: string) => {
    for (const listener of debuggerListeners.get("message") ?? [])
      listener({}, method, params, sessionId);
  };
  const posted: Array<{ url: string; channel: string }> = [];
  let frameUrls: Array<{ url: string; key: JobKey | null }> = [];
  const commands: string[] = [];

  const session: JobSession = {
    protocol: {
      handle: (scheme) => {
        if (scheme === "http") boom("handle-http");
        registered.protocols.add(scheme);
      },
      unhandle: (scheme) => void registered.protocols.delete(scheme),
    },
    webRequest: {
      onBeforeRequest: (listener) => {
        if (listener !== null) boom("webRequest");
        registered.webRequest = listener !== null;
      },
    },
    serviceWorkers: {
      getAllRunning: () => (options.workersRunning ? { 1: {} } : {}),
      getInfoFromVersionID: () => ({ scope: "http://localhost:4317/" }),
      on: () => {
        registered.workerListeners += 1;
      },
      removeListener: () => {
        registered.workerListeners -= 1;
      },
    },
  };

  let window: JobWindow | null = null;
  const createWindow: JobDeps["createWindow"] = () => {
    boom("createWindow");
    registered.windows += 1;
    let destroyed = false;
    const contents = {
      ipc: {
        on: (_channel: string, listener: (event: unknown, message: unknown) => void) => {
          helloChannels.push(_channel);
          ipcListeners.add(listener);
          registered.ipcListeners += 1;
        },
        removeListener: (
          _channel: string,
          listener: (event: unknown, message: unknown) => void,
        ) => {
          if (ipcListeners.delete(listener)) registered.ipcListeners -= 1;
        },
      },
      async loadURL(url: string) {
        if (url === "about:blank") {
          boom("load-blank");
          return;
        }
        boom("navigate");
        const parsed = new URL(url);
        const top = { url, key: parsed.searchParams.has("key") ? keyFor(url) : null };
        frameUrls = [top, ...iframesOf(url)];
        for (const frame of frameUrls) {
          if (frame.key === null || options.silentFrame) continue;
          for (const listener of ipcListeners) {
            listener(
              {
                sender: contents,
                senderFrame: {
                  url: frame.url,
                  postMessage: (channel: string) => posted.push({ url: frame.url, channel }),
                },
              },
              { job: parsed.searchParams.get("job") },
            );
          }
        }
        options.duringNavigation?.(emit);
      },
      debugger: {
        attach: () => {
          boom("attach");
          registered.attached = true;
        },
        detach: () => {
          registered.attached = false;
        },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          if (!debuggerListeners.has(event)) debuggerListeners.set(event, new Set());
          debuggerListeners.get(event)?.add(listener);
          registered.debuggerListeners += 1;
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          if (debuggerListeners.get(event)?.delete(listener)) registered.debuggerListeners -= 1;
        },
        async sendCommand(method: string, params?: { frameId?: string }) {
          commands.push(method);
          if (method === "ServiceWorker.enable") boom("ServiceWorker.enable");
          if (method === "Network.setBypassServiceWorker") boom("Network.setBypassServiceWorker");
          if (method === "Page.getFrameTree") {
            const [top, ...rest] = frameUrls;
            return {
              frameTree: {
                frame: { id: "frame-0", url: top?.url ?? "about:blank" },
                childFrames: rest.map((f, i) => ({ frame: { id: `frame-${i + 1}`, url: f.url } })),
              },
            };
          }
          if (method === "Storage.getStorageKey") {
            boom("Storage.getStorageKey");
            const index = Number(params?.frameId?.slice("frame-".length));
            const key = frameUrls[index]?.key as JobKey;
            return { storageKey: (options.storageKeyOf ?? keyText)(key) };
          }
          return {};
        },
      },
    };
    window = {
      webContents: contents as unknown as JobWindow["webContents"],
      destroy: () => {
        destroyed = true;
      },
      isDestroyed: () => destroyed,
    };
    return window as JobWindow;
  };
  const keys = [FRAME, TOP];
  const keyFor = (url: string) => keys[Number(new URL(url).searchParams.get("key"))] ?? null;
  const iframesOf = (topUrl: string) =>
    new URL(topUrl).origin === TOP.origin
      ? [{ url: topUrl.replace(TOP.origin, FRAME.origin).replace("key=1", "key=0"), key: FRAME }]
      : [];

  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const deps: JobDeps = {
    locks: {
      acquire: async () => (options.refuse ? { code: options.refuse } : lease),
    },
    session: () => session,
    createWindow,
    contentsOn: () => options.contents ?? 1,
    slots: options.slots ?? new JobSlots(2),
    newChannel: () => ({ port1: { end: 1 }, port2: { end: 2 } }),
    preloadPath: PRELOAD,
    log,
    timing: FAST,
  };
  const ran: ConnectedFrame[][] = [];
  const plan = {
    direction: "export",
    lock: "task",
    keys,
    runFrames: vi.fn(async (frames: readonly ConnectedFrame[], _context: JobContext) => {
      boom("runFrames");
      ran.push([...frames]);
      return { ok: true as const, data: undefined };
    }),
    commit: vi.fn(async (_context: JobContext): Promise<Result<string, ErrorCode>> => {
      boom("commit");
      return { ok: true as const, data: "committed" };
    }),
    discard: vi.fn(async () => undefined),
  } satisfies JobPlan<string>;
  const nothingLeft = () => ({
    protocols: [...registered.protocols],
    webRequest: registered.webRequest,
    debuggerListeners: registered.debuggerListeners,
    attached: registered.attached,
    workerListeners: registered.workerListeners,
    ipcListeners: registered.ipcListeners,
    windowDestroyed: window === null || window.isDestroyed(),
    released: registered.released,
  });
  return {
    deps,
    plan,
    ran,
    posted,
    commands,
    log,
    leaseController,
    nothingLeft,
    emit,
    helloChannels,
  };
}

const CLEAN = {
  protocols: [],
  webRequest: false,
  debuggerListeners: 0,
  attached: false,
  workerListeners: 0,
  ipcListeners: 0,
  windowDestroyed: true,
  released: true,
};

afterEach(() => vi.useRealTimers());

describe("runQuiescentJob (save-transfer.md section 5)", () => {
  it("runs steps 1 to 12: connects each expected frame, commits, and leaves nothing behind", async () => {
    const { deps, plan, ran, posted, commands, nothingLeft, log } = fakes();
    expect(await runQuiescentJob(GAME, plan, deps)).toEqual({ ok: true, data: "committed" });
    expect(ran).toEqual([
      [
        { key: TOP, port: { end: 2 } },
        { key: FRAME, port: { end: 2 } },
      ],
    ]);
    expect(posted.map((p) => p.channel)).toEqual([PORT_CHANNEL, PORT_CHANNEL]);
    expect(plan.discard).not.toHaveBeenCalled();
    expect(nothingLeft()).toEqual(CLEAN);
    // Workers are stopped before the bypass, and the bypass before the first navigation.
    expect(commands.indexOf("ServiceWorker.stopAllWorkers")).toBeLessThan(
      commands.indexOf("Network.setBypassServiceWorker"),
    );
    expect(commands.indexOf("Network.setBypassServiceWorker")).toBeLessThan(
      commands.indexOf("Page.getFrameTree"),
    );
    // QW-9: no stub URL (it carries the job nonce) and no path or query in any log line.
    const logged = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    expect(logged).not.toContain("__wg_quiescent__");
    expect(logged).not.toMatch(/job=/);
  });

  it.each<Step>([
    "handle-http",
    "webRequest",
    "createWindow",
    "load-blank",
    "attach",
    "ServiceWorker.enable",
    "Network.setBypassServiceWorker",
    "navigate",
    "Storage.getStorageKey",
    "runFrames",
    "commit",
  ])("leaves nothing registered and releases the lease when %s throws (QW-3)", async (throwAt) => {
    const { deps, plan, nothingLeft } = fakes({ throwAt });
    const result = await runQuiescentJob(GAME, plan, deps);
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(nothingLeft()).toEqual(CLEAN);
    if (throwAt !== "commit") expect(plan.commit).not.toHaveBeenCalled();
  });

  it("refuses with the lock's code before anything is registered (AC-11)", async () => {
    const { deps, plan, nothingLeft } = fakes({ refuse: "GAME_RUNNING" });
    expect(await runQuiescentJob(GAME, plan, deps)).toMatchObject({
      ok: false,
      code: "GAME_RUNNING",
    });
    expect(nothingLeft()).toEqual({ ...CLEAN, released: false });
    expect(plan.runFrames).not.toHaveBeenCalled();
  });

  it("stops at a script outside the preload's world, discards, and never commits (step 11)", async () => {
    const { deps, plan, nothingLeft } = fakes({
      duringNavigation: (emit) =>
        emit("Debugger.scriptParsed", {
          url: "http://localhost:4317/game.js",
          length: 10,
          executionContextAuxData: { isDefault: true, type: "default" },
        }),
    });
    expect(await runQuiescentJob(GAME, plan, deps)).toMatchObject({
      ok: false,
      code: "EXP_QUIESCENCE_VIOLATION",
    });
    expect(plan.commit).not.toHaveBeenCalled();
    expect(plan.discard).toHaveBeenCalledTimes(1);
    expect(nothingLeft()).toEqual(CLEAN);
  });

  it("refuses a frame whose storage key differs or has another form (step 8)", async () => {
    const mismatch = fakes({ storageKeyOf: (key) => `${key.origin}/^0http://elsewhere` });
    expect(await runQuiescentJob(GAME, mismatch.plan, mismatch.deps)).toMatchObject({
      code: "EXP_STORAGE_KEY_MISMATCH",
    });
    const unknown = fakes({ storageKeyOf: (key) => `${key.origin}/^1nonce` });
    expect(await runQuiescentJob(GAME, unknown.plan, unknown.deps)).toMatchObject({
      code: "EXP_UNSUPPORTED_STORAGE_KEY",
    });
    expect(unknown.plan.runFrames).not.toHaveBeenCalled();
  });

  it("refuses when another webContents uses the session (QW-2) or a worker keeps running (step 5)", async () => {
    const shared = fakes({ contents: 2 });
    expect(await runQuiescentJob(GAME, shared.plan, shared.deps)).toMatchObject({
      code: "EXP_QUIESCENCE_VIOLATION",
    });
    expect(shared.commands).not.toContain("Page.getFrameTree");
    const workers = fakes({ workersRunning: true });
    expect(await runQuiescentJob(GAME, workers.plan, workers.deps)).toMatchObject({
      code: "EXP_QUIESCENCE_VIOLATION",
    });
    expect(workers.nothingLeft()).toEqual(CLEAN);
  });

  it("gives up with EXP_TIMEOUT when an expected frame never says hello (step 9)", async () => {
    const { deps, plan, nothingLeft } = fakes({ silentFrame: true });
    expect(await runQuiescentJob(GAME, plan, deps)).toMatchObject({ code: "EXP_TIMEOUT" });
    expect(nothingLeft()).toEqual(CLEAN);
  });

  it("is cancelled through its lease (M5): CANCELLED, discarded, released", async () => {
    const setUp = fakes();
    setUp.plan.runFrames.mockImplementationOnce(async () => {
      setUp.leaseController.abort();
      return { ok: true, data: undefined };
    });
    expect(await runQuiescentJob(GAME, setUp.plan, setUp.deps)).toMatchObject({
      ok: false,
      code: "CANCELLED",
    });
    expect(setUp.plan.discard).toHaveBeenCalled();
    expect(setUp.nothingLeft()).toEqual(CLEAN);
  });

  it("listens for hellos on the job window's own IPC, on the handshake channel only", async () => {
    const { deps, plan, helloChannels } = fakes();
    await runQuiescentJob(GAME, plan, deps);
    expect(helloChannels).toEqual([HELLO_CHANNEL]);
  });

  it("runs at most two jobs at once: a third is refused with GAME_BUSY and its lease released (security.md 8)", async () => {
    const slots = new JobSlots(2);
    const gates: Array<() => void> = [];
    const blocked = () => {
      const setUp = fakes({ slots });
      setUp.plan.runFrames.mockImplementation(
        () => new Promise((resolve) => gates.push(() => resolve({ ok: true, data: undefined }))),
      );
      return setUp;
    };
    const first = blocked();
    const second = blocked();
    const running = [
      runQuiescentJob(GAME, first.plan, first.deps),
      runQuiescentJob(GAME, second.plan, second.deps),
    ];
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(slots.running).toBe(2);
    const third = fakes({ slots });
    const refused = await runQuiescentJob(GAME, third.plan, third.deps);
    expect(refused).toMatchObject({ ok: false, code: "GAME_BUSY" });
    expect((refused as { message: string }).message).toMatch(/two snapshot jobs/i);
    expect(third.nothingLeft()).toEqual(CLEAN);
    expect(third.plan.runFrames).not.toHaveBeenCalled();
    for (const open of gates) open();
    await Promise.all(running);
    expect(slots.running).toBe(0);
    expect((await runQuiescentJob(GAME, third.plan, third.deps)).ok).toBe(true);
  });

  it("gives a user task the slot of a background job: the job is cancelled and the task runs (architecture.md 4)", async () => {
    const slots = new JobSlots(2);
    const gate = Promise.withResolvers<void>();
    const task = fakes({ slots });
    task.plan.runFrames.mockImplementation(async () => {
      await gate.promise;
      return { ok: true, data: undefined };
    });
    const background = fakes({ slots });
    // Reads until it is stopped (the job's guard ends the wait when the job's signal is aborted).
    background.plan.runFrames.mockImplementation(async () => {
      await gate.promise;
      return { ok: true, data: undefined };
    });
    const backgroundPlan = { ...background.plan, lock: "background" as const };
    const running = [
      runQuiescentJob(GAME, task.plan, task.deps),
      runQuiescentJob(GAME, backgroundPlan, background.deps),
    ];
    await vi.waitFor(() => expect(background.plan.runFrames).toHaveBeenCalled());
    expect(slots.running).toBe(2);
    const user = fakes({ slots });
    expect(await runQuiescentJob(GAME, user.plan, user.deps)).toEqual({
      ok: true,
      data: "committed",
    });
    expect(await running[1]).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(background.plan.discard).toHaveBeenCalled();
    expect(background.plan.commit).not.toHaveBeenCalled();
    expect(background.nothingLeft()).toEqual(CLEAN);
    gate.resolve();
    await running[0];
    expect(slots.running).toBe(0);
  });

  it("refuses the user task with INTERNAL when the background job does not give its slot back in time", async () => {
    const slots = new JobSlots(2, 50);
    const gates: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => gates.push(resolve));
    const task = fakes({ slots });
    task.plan.runFrames.mockImplementation(async () => {
      await hold();
      return { ok: true, data: undefined };
    });
    const background = fakes({ slots });
    background.plan.runFrames.mockImplementation(async () => {
      await hold();
      return { ok: true, data: undefined };
    });
    background.plan.discard.mockImplementation(async () => {
      await hold();
      return undefined;
    });
    const backgroundPlan = { ...background.plan, lock: "background" as const };
    const running = [
      runQuiescentJob(GAME, task.plan, task.deps),
      runQuiescentJob(GAME, backgroundPlan, background.deps),
    ];
    await vi.waitFor(() => expect(background.plan.runFrames).toHaveBeenCalled());
    const user = fakes({ slots });
    expect(await runQuiescentJob(GAME, user.plan, user.deps)).toMatchObject({
      ok: false,
      code: "INTERNAL",
    });
    expect(user.plan.runFrames).not.toHaveBeenCalled();
    expect(user.nothingLeft()).toEqual(CLEAN);
    expect(user.log.error).toHaveBeenCalledWith("snapshot.job.slot-not-released", {
      gameId: GAME,
      waitedMs: 50,
    });
    while (gates.length > 0) for (const open of gates.splice(0)) open();
    await Promise.all(running);
    expect(slots.running).toBe(0);
  });

  it("never gives a background job's slot to another background job", async () => {
    const slots = new JobSlots(1);
    const gate = Promise.withResolvers<void>();
    const first = fakes({ slots });
    first.plan.runFrames.mockImplementation(async () => {
      await gate.promise;
      return { ok: true, data: undefined };
    });
    const running = runQuiescentJob(GAME, { ...first.plan, lock: "background" }, first.deps);
    await vi.waitFor(() => expect(first.plan.runFrames).toHaveBeenCalled());
    const second = fakes({ slots });
    expect(
      await runQuiescentJob(GAME, { ...second.plan, lock: "background" }, second.deps),
    ).toMatchObject({ ok: false, code: "GAME_BUSY" });
    gate.resolve();
    expect((await running).ok).toBe(true);
  });

  it("puts a hung commit under the watchdog: EXP_TIMEOUT, the plan's discard, lease and slot given back", async () => {
    const slots = new JobSlots(2);
    const setUp = fakes({ slots });
    setUp.deps.timing = { ...FAST, deadlineMs: 100 };
    setUp.plan.commit.mockImplementationOnce(() => new Promise(() => {}));
    expect(await runQuiescentJob(GAME, setUp.plan, setUp.deps)).toMatchObject({
      ok: false,
      code: "EXP_TIMEOUT",
    });
    expect(setUp.plan.discard).toHaveBeenCalledOnce();
    expect(setUp.nothingLeft()).toEqual(CLEAN);
    expect(slots.running).toBe(0);
    expect(setUp.log.warn).toHaveBeenCalledWith("snapshot.job.failed", {
      gameId: GAME,
      lock: "task",
      code: "EXP_TIMEOUT",
      step: "commit",
    });
  });

  it("keeps a commit that has recorded its result although the job is stopped before the commit settles", async () => {
    const setUp = fakes();
    setUp.plan.commit.mockImplementationOnce(async (context) => {
      // The row is recorded here (the export's transaction); then a stop lands before the commit has returned.
      context.committed();
      setUp.leaseController.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, data: "committed" };
    });
    expect(await runQuiescentJob(GAME, setUp.plan, setUp.deps)).toEqual({
      ok: true,
      data: "committed",
    });
    expect(setUp.plan.discard).not.toHaveBeenCalled();
    expect(setUp.nothingLeft()).toEqual(CLEAN);
  });

  it("aborts the job's signal with the watchdog's EXP_TIMEOUT, which a commit can read", async () => {
    const setUp = fakes();
    setUp.deps.timing = { ...FAST, deadlineMs: 100 };
    setUp.plan.commit.mockImplementationOnce(async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return failureOf(context.signal);
    });
    expect(await runQuiescentJob(GAME, setUp.plan, setUp.deps)).toMatchObject({
      code: "EXP_TIMEOUT",
    });
  });
});

describe("holdQuiescentJob: one lease and one slot over several windows (restore R3 to R7)", () => {
  it("runs two windows under one lease and one slot and gives both back once", async () => {
    const slots = new JobSlots(1);
    const { deps, plan, nothingLeft } = fakes({ slots });
    const held = await holdQuiescentJob(GAME, "task", deps);
    if (!held.ok) throw new Error(held.code);
    expect(await held.data.run(plan)).toEqual({ ok: true, data: "committed" });
    // The slot stays taken between the windows: another job is refused meanwhile.
    expect(slots.running).toBe(1);
    expect(await held.data.run(plan)).toEqual({ ok: true, data: "committed" });
    expect(nothingLeft()).toMatchObject({ windowDestroyed: true, released: false });
    held.data.release();
    held.data.release();
    expect(slots.running).toBe(0);
    expect(nothingLeft()).toEqual(CLEAN);
  });

  it("clears a frame's whole key through CDP with the key Chromium reported, inside runFrames only", async () => {
    const { deps, plan, commands } = fakes();
    let outside: unknown;
    plan.runFrames.mockImplementation(
      async (frames: readonly ConnectedFrame[], context: JobContext) => {
        for (const frame of frames)
          await context.clearStorage(frame.key, "local_storage,indexeddb");
        return { ok: true as const, data: undefined };
      },
    );
    plan.commit.mockImplementation(async (context: JobContext) => {
      outside = await context.clearStorage(TOP, "local_storage").catch((error: unknown) => error);
      return { ok: true, data: "committed" };
    });
    expect(await runQuiescentJob(GAME, plan, deps)).toEqual({ ok: true, data: "committed" });
    expect(commands.filter((c) => c === "Storage.clearDataForStorageKey")).toHaveLength(2);
    expect(outside).toBeInstanceOf(Error);
  });

  it("runs a window a cancel cannot stop when asked to (the rollback), while a plain window is cancelled", async () => {
    const { deps, plan, leaseController } = fakes();
    const held = await holdQuiescentJob(GAME, "task", deps);
    if (!held.ok) throw new Error(held.code);
    leaseController.abort();
    expect(held.data.signal.aborted).toBe(true);
    expect(await held.data.run(plan)).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(await held.data.run(plan, { cancellable: false })).toEqual({
      ok: true,
      data: "committed",
    });
    held.data.release();
  });

  it("refuses with the lock's code and takes no slot", async () => {
    const slots = new JobSlots(2);
    const { deps } = fakes({ refuse: "NEEDS_RECOVERY", slots });
    expect(await holdQuiescentJob(GAME, "task", deps)).toMatchObject({
      ok: false,
      code: "NEEDS_RECOVERY",
    });
    expect(slots.running).toBe(0);
  });

  it("takes the recovery lease when asked to (the rollback of a game marked needs_recovery)", async () => {
    const { deps } = fakes({ refuse: "NEEDS_RECOVERY" });
    const recovery = vi.fn(deps.locks.acquire);
    let granted = false;
    deps.locks.acquireForRecovery = async () => {
      granted = true;
      return {
        gameId: GAME,
        kind: "task",
        signal: new AbortController().signal,
        release: () => undefined,
      };
    };
    const held = await holdQuiescentJob(GAME, "task", deps, { recovery: true });
    expect(held.ok).toBe(true);
    expect(granted).toBe(true);
    expect(recovery).not.toHaveBeenCalled();
    if (held.ok) held.data.release();
  });
});

describe("parseStorageKey (save-transfer.md section 2)", () => {
  it.each([
    ["http://localhost:4417/", { origin: "http://localhost:4417", topLevelSite: null }],
    [
      "http://127.0.0.1:4417/^0http://localhost",
      { origin: "http://127.0.0.1:4417", topLevelSite: "http://localhost" },
    ],
    [
      "https://a.example/^0https://b.example",
      { origin: "https://a.example", topLevelSite: "https://b.example" },
    ],
  ])("parses %s", (text, key) => {
    expect(parseStorageKey(text)).toEqual(key);
  });

  it.each([
    "http://localhost:4417",
    "http://localhost:4417/^1nonce",
    "http://localhost:4417/^0http://localhost^3x",
    "http://LOCALHOST:4417/",
    "http://localhost:4417/path/",
    "http://127.0.0.1:4417/^0http://localhost:80",
    "file:///x/",
    "",
  ])("refuses %s", (text) => {
    expect(parseStorageKey(text)).toBeNull();
  });
});
