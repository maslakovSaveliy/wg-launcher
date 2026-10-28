// The quiescence canary (save-transfer.md section 5, step 11): the evidence that no game code ran while a job read
// or wrote a game's storage. It watches the job window's debugger on every target and the session's service
// workers, from the moment the debugger is attached until the job ends:
// - every `Debugger.scriptParsed` must be in an isolated world (not the default one) and be one of the scripts
//   Electron's sandboxed preload runs there: Electron's own `electron/js2c/*` modules, our preload file, and the
//   6-character `void 0` with no URL that Electron evaluates when it sets the world up. This allowlist is the
//   calibration of a real job in Electron 45 (e2e/quiescent.spec.ts asserts it);
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
  onWorkerStatus(details: { runningStatus: string }): void;
  onDebuggerDetached(): void;
  violation(): Violation | null;
  /** How many allowed scripts of each kind parsed (the calibration the e2e test checks). */
  scripts(): Record<"electron" | "preload" | "isolatedWorldSetUp", number>;
}

interface ScriptParsed {
  url?: unknown;
  length?: unknown;
  executionContextAuxData?: { isDefault?: unknown; type?: unknown } | null;
}

/** Electron's isolated-world set-up script: `void 0`. */
const SET_UP_LENGTH = 6;

export function createCanary(options: {
  /** The quiescent preload's file path, as CDP reports its URL. */
  preloadPath: string;
  onViolation?: (violation: Violation, detail: Record<string, unknown>) => void;
}): Canary {
  let first: Violation | null = null;
  const counts = { electron: 0, preload: 0, isolatedWorldSetUp: 0 };
  const flag = (violation: Violation, detail: Record<string, unknown> = {}) => {
    if (first !== null) return;
    first = violation;
    options.onViolation?.(violation, detail);
  };

  const onScript = (params: ScriptParsed) => {
    const aux = params.executionContextAuxData;
    const url = typeof params.url === "string" ? params.url : null;
    const inIsolatedWorld = aux?.isDefault === false && aux.type === "isolated";
    if (inIsolatedWorld && url !== null) {
      if (url === options.preloadPath) {
        counts.preload += 1;
        return;
      }
      if (url.startsWith("electron/js2c/")) {
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
    });
  };

  return {
    onDebuggerMessage(method, params) {
      if (method === "Debugger.scriptParsed") onScript((params ?? {}) as ScriptParsed);
      else if (method === "Target.attachedToTarget") {
        const type = (params as { targetInfo?: { type?: unknown } } | null)?.targetInfo?.type;
        if (type !== "iframe")
          flag("worker-target", { type: typeof type === "string" ? type : "unknown" });
      }
    },
    onWorkerStatus({ runningStatus }) {
      if (runningStatus === "starting" || runningStatus === "running")
        flag("service-worker-started");
    },
    onDebuggerDetached() {
      flag("debugger-detached");
    },
    violation: () => first,
    scripts: () => ({ ...counts }),
  };
}
