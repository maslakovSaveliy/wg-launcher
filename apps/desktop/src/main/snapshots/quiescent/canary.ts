// The quiescence canary (save-transfer.md section 5, step 11): the evidence that no game code ran while a job read
// or wrote a game's storage. It watches the job window's debugger on every target and the session's service
// workers, from the moment the debugger is attached until the job ends:
// - every `Debugger.scriptParsed` must be in a context the canary saw announced (`Runtime.executionContextCreated`),
//   isolated (not the default world), named as Electron names the preload's world (PRELOAD_WORLD on the page,
//   unnamed only in a cross-site iframe's own target), and be one of the scripts Electron's sandboxed preload runs
//   there: Electron's `electron/js2c/event_emitter_dispatch`, our preload file, and the 6-character `void 0` with no
//   URL that Electron evaluates when it sets the world up. This allowlist is the calibration of a real job in
//   Electron 45 (e2e/quiescent.spec.ts asserts it). The test flavor may name a harness world (Playwright creates a
//   utility world in every page it attaches to, the quiescent window included); its scripts are counted apart;
// - a worker target of any kind (service, dedicated, shared) is a violation; only iframe targets are expected;
// - a service worker of the session `starting` or `running` is a violation;
// - a debugger that detaches leaves the canary blind, which is a violation too.
// The first violation is kept and reported once; its reason is a fixed word, never a URL (QW-9).

export type Violation =
  | "script-outside-preload"
  | "worker-target"
  | "service-worker-started"
  | "debugger-detached";

export interface Canary {
  onDebuggerMessage(method: string, params: unknown, sessionId?: string): void;
  /** `scopeOrigin`: the origin of the worker's scope, when it is known (logged; origins only, QW-9). */
  onWorkerStatus(details: { runningStatus: string; scopeOrigin?: string | null }): void;
  onDebuggerDetached(): void;
  violation(): Violation | null;
  /** How many allowed scripts of each kind parsed (the calibration the e2e test checks). */
  scripts(): Record<"electron" | "preload" | "isolatedWorldSetUp" | "harness", number>;
}

interface ScriptParsed {
  executionContextId?: unknown;
  url?: unknown;
  length?: unknown;
  executionContextAuxData?: { isDefault?: unknown; type?: unknown } | null;
}

/** Electron's isolated-world set-up script: `void 0`. */
const SET_UP_LENGTH = 6;

/**
 * The name Electron 45 gives the preload's isolated world in `Runtime.executionContextCreated` of the page's own
 * session; in a cross-site iframe's own target (a child session) the world has no name (Verified 2026-10-28,
 * e2e/export.spec.ts).
 */
export const PRELOAD_WORLD = "Electron Isolated Context";

/** The one Electron module the calibration saw in the preload's world (Verified 2026-10-28, e2e/quiescent.spec.ts). */
export const ELECTRON_MODULE = "electron/js2c/event_emitter_dispatch";

export function createCanary(options: {
  /** The quiescent preload's file path, as CDP reports its URL. */
  preloadPath: string;
  /** Test flavor only: the name of a test harness's own isolated world, whose scripts are allowed. */
  harnessWorld?: (name: string) => boolean;
  onViolation?: (violation: Violation, detail: Record<string, unknown>) => void;
}): Canary {
  let first: Violation | null = null;
  const counts = { electron: 0, preload: 0, isolatedWorldSetUp: 0, harness: 0 };
  /** World names of the contexts seen, per session (`<sessionId>:<contextId>`). */
  const worlds = new Map<string, string>();
  const flag = (violation: Violation, detail: Record<string, unknown> = {}) => {
    if (first !== null) return;
    first = violation;
    options.onViolation?.(violation, detail);
  };

  const onScript = (params: ScriptParsed, sessionId: string) => {
    const aux = params.executionContextAuxData;
    const url = typeof params.url === "string" ? params.url : null;
    const inIsolatedWorld = aux?.isDefault === false && aux.type === "isolated";
    const world = worlds.get(`${sessionId}:${String(params.executionContextId)}`);
    if (inIsolatedWorld && world !== undefined && options.harnessWorld?.(world)) {
      counts.harness += 1;
      return;
    }
    // A context the canary never saw announced is not ours to trust; the unnamed world only in a child target.
    const preloadWorld = world === PRELOAD_WORLD || (world === "" && sessionId !== "");
    if (inIsolatedWorld && url !== null && preloadWorld) {
      if (url === options.preloadPath) {
        counts.preload += 1;
        return;
      }
      if (url === ELECTRON_MODULE) {
        counts.electron += 1;
        return;
      }
      if (url === "" && params.length === SET_UP_LENGTH) {
        counts.isolatedWorldSetUp += 1;
        return;
      }
    }
    flag("script-outside-preload", {
      world: aux?.isDefault === true ? "default" : inIsolatedWorld ? "isolated" : "unknown",
      // The script's size and whether it has a URL, never the URL (it may hold a query, QW-9).
      length: typeof params.length === "number" ? params.length : null,
      hasUrl: url !== null && url !== "",
      // Isolated worlds are named by Chromium, Electron or a harness, never by a page.
      worldName: world === undefined ? null : world.slice(0, 64),
    });
  };

  return {
    onDebuggerMessage(method, params, sessionId = "") {
      if (method === "Runtime.executionContextCreated") {
        const context = (params as { context?: { id?: unknown; name?: unknown } } | null)?.context;
        if (typeof context?.name === "string")
          worlds.set(`${sessionId}:${String(context.id)}`, context.name);
      } else if (method === "Debugger.scriptParsed")
        onScript((params ?? {}) as ScriptParsed, sessionId);
      else if (method === "Target.attachedToTarget") {
        const type = (params as { targetInfo?: { type?: unknown } } | null)?.targetInfo?.type;
        if (type !== "iframe")
          flag("worker-target", { type: typeof type === "string" ? type : "unknown" });
      }
    },
    onWorkerStatus({ runningStatus, scopeOrigin }) {
      if (runningStatus === "starting" || runningStatus === "running") {
        flag("service-worker-started", { scopeOrigin: scopeOrigin ?? null });
      }
    },
    onDebuggerDetached() {
      flag("debugger-detached");
    },
    violation: () => first,
    scripts: () => ({ ...counts }),
  };
}
