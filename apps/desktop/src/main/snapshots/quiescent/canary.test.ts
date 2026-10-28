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
    expect(canary.scripts()).toEqual({
      electron: 1,
      preload: 1,
      isolatedWorldSetUp: 1,
      harness: 0,
    });
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

  const created = (id: number, name: string, isDefault = false) => ({
    context: {
      id,
      name,
      origin: "http://localhost:4317",
      auxData: { isDefault, type: isDefault ? "default" : "isolated" },
    },
  });
  const inContext = (id: number, url: string, length = 100) => ({
    ...parsed(url, isolated, length),
    executionContextId: id,
  });

  it("checks the isolated world's name when its context is known", () => {
    const canary = createCanary({ preloadPath: PRELOAD });
    canary.onDebuggerMessage(
      "Runtime.executionContextCreated",
      created(5, "Electron Isolated Context"),
    );
    canary.onDebuggerMessage("Debugger.scriptParsed", inContext(5, PRELOAD));
    expect(canary.violation()).toBeNull();
    // In a cross-site iframe's own target Electron leaves the preload's world unnamed.
    canary.onDebuggerMessage("Runtime.executionContextCreated", created(7, ""), "child");
    canary.onDebuggerMessage("Debugger.scriptParsed", inContext(7, PRELOAD), "child");
    expect(canary.violation()).toBeNull();
    canary.onDebuggerMessage("Runtime.executionContextCreated", created(6, "another world"));
    canary.onDebuggerMessage("Debugger.scriptParsed", inContext(6, PRELOAD));
    expect(canary.violation()).toBe("script-outside-preload");
  });

  it("tells contexts of different sessions apart", () => {
    const canary = createCanary({ preloadPath: PRELOAD });
    canary.onDebuggerMessage(
      "Runtime.executionContextCreated",
      created(5, "another world"),
      "child",
    );
    canary.onDebuggerMessage("Debugger.scriptParsed", inContext(5, PRELOAD));
    expect(canary.violation()).toBeNull();
  });

  it("lets a test harness's own world through only when told to (test flavor), and counts it", () => {
    const world = "__playwright_utility_world_page@0123";
    const strict = createCanary({ preloadPath: PRELOAD });
    strict.onDebuggerMessage("Runtime.executionContextCreated", created(6, world));
    strict.onDebuggerMessage("Debugger.scriptParsed", inContext(6, "", 0));
    expect(strict.violation()).toBe("script-outside-preload");
    const harnessed = createCanary({
      preloadPath: PRELOAD,
      harnessWorld: (name) => name.startsWith("__playwright_utility_world_"),
    });
    harnessed.onDebuggerMessage("Runtime.executionContextCreated", created(6, world));
    harnessed.onDebuggerMessage("Debugger.scriptParsed", inContext(6, "", 0));
    expect(harnessed.violation()).toBeNull();
    expect(harnessed.scripts()).toMatchObject({ harness: 1 });
    // The main world stays off limits for the harness too.
    harnessed.onDebuggerMessage("Runtime.executionContextCreated", created(1, "", true));
    harnessed.onDebuggerMessage("Debugger.scriptParsed", {
      ...parsed("", main, 0),
      executionContextId: 1,
    });
    expect(harnessed.violation()).toBe("script-outside-preload");
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
