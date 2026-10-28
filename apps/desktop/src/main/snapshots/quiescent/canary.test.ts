import { describe, expect, it, vi } from "vitest";
import { createCanary } from "./canary.js";

const PRELOAD = "/app/out/preload/quiescent.cjs";
const isolated = { frameId: "F", isDefault: false, type: "isolated" };
const main = { frameId: "F", isDefault: true, type: "default" };

const parsed = (url: string, aux: unknown, length = 100) => ({
  url,
  length,
  executionContextId: 1,
  executionContextAuxData: aux,
});

describe("the quiescence canary (save-transfer.md section 5, step 11)", () => {
  it("lets through only Electron's and our preload's scripts in the isolated world", () => {
    const canary = createCanary({ preloadPath: PRELOAD });
    canary.onDebuggerMessage(
      "Debugger.scriptParsed",
      parsed("electron/js2c/event_emitter_dispatch", isolated),
    );
    canary.onDebuggerMessage("Debugger.scriptParsed", parsed(PRELOAD, isolated));
    // Electron evaluates `void 0` (6 characters, no URL) when it sets up the isolated world.
    canary.onDebuggerMessage("Debugger.scriptParsed", parsed("", isolated, 6), "child-session");
    canary.onDebuggerMessage("Target.attachedToTarget", { targetInfo: { type: "iframe" } });
    canary.onWorkerStatus({ runningStatus: "stopping" });
    canary.onWorkerStatus({ runningStatus: "stopped" });
    expect(canary.violation()).toBeNull();
    expect(canary.scripts()).toEqual({ electron: 1, preload: 1, isolatedWorldSetUp: 1 });
  });

  it.each([
    [
      "a script in the main world",
      "Debugger.scriptParsed",
      parsed("http://localhost:4317/game.js", main),
    ],
    ["our preload's URL in the main world", "Debugger.scriptParsed", parsed(PRELOAD, main)],
    ["an injected script without a URL", "Debugger.scriptParsed", parsed("", main, 6)],
    [
      "a game script in an isolated world",
      "Debugger.scriptParsed",
      parsed("http://localhost:4317/x.js", isolated),
    ],
    ["another isolated script without a URL", "Debugger.scriptParsed", parsed("", isolated, 40)],
    ["a script without context data", "Debugger.scriptParsed", parsed(PRELOAD, undefined)],
    [
      "a service worker target",
      "Target.attachedToTarget",
      { targetInfo: { type: "service_worker" } },
    ],
    ["a dedicated worker target", "Target.attachedToTarget", { targetInfo: { type: "worker" } }],
    [
      "a shared worker target",
      "Target.attachedToTarget",
      { targetInfo: { type: "shared_worker" } },
    ],
  ])("flags %s", (_name, method, params) => {
    const onViolation = vi.fn();
    const canary = createCanary({ preloadPath: PRELOAD, onViolation });
    canary.onDebuggerMessage(method, params);
    expect(canary.violation()).not.toBeNull();
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  it.each(["starting", "running"])("flags a service worker of the session %s", (status) => {
    const canary = createCanary({ preloadPath: PRELOAD });
    canary.onWorkerStatus({ runningStatus: status });
    expect(canary.violation()).toBe("service-worker-started");
  });

  it("flags a debugger that went away, since the canary is then blind", () => {
    const canary = createCanary({ preloadPath: PRELOAD });
    canary.onDebuggerDetached();
    expect(canary.violation()).toBe("debugger-detached");
  });

  it("keeps the first violation and reports once, and its reason holds no URL", () => {
    const onViolation = vi.fn();
    const canary = createCanary({ preloadPath: PRELOAD, onViolation });
    canary.onDebuggerMessage(
      "Debugger.scriptParsed",
      parsed("http://localhost:4317/game.js?token=SECRET", main),
    );
    canary.onWorkerStatus({ runningStatus: "running" });
    expect(canary.violation()).toBe("script-outside-preload");
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onViolation.mock.calls)).not.toContain("SECRET");
  });
});
