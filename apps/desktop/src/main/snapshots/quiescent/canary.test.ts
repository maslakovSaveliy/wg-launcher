import { describe, expect, it, vi } from "vitest";
import { type Canary, createCanary } from "./canary.js";

const PRELOAD = "/app/out/preload/quiescent.cjs";
const EMITTER = "electron/js2c/event_emitter_dispatch";
const isolated = { frameId: "F", isDefault: false, type: "isolated" };
const main = { frameId: "F", isDefault: true, type: "default" };

const created = (id: number, name: string, isDefault = false) => ({
  context: {
    id,
    name,
    origin: "http://localhost:4317",
    auxData: { isDefault, type: isDefault ? "default" : "isolated" },
  },
});
const parsed = (id: number, url: string, length = 100, aux: unknown = isolated) => ({
  url,
  length,
  executionContextId: id,
  executionContextAuxData: aux,
});

/** A canary that has seen the preload's world (context 2 of the page) and an iframe target's (context 3). */
function withWorlds(options: Partial<Parameters<typeof createCanary>[0]> = {}): Canary {
  const canary = createCanary({ preloadPath: PRELOAD, ...options });
  canary.onDebuggerMessage("Runtime.executionContextCreated", created(1, "", true));
  canary.onDebuggerMessage(
    "Runtime.executionContextCreated",
    created(2, "Electron Isolated Context"),
  );
  canary.onDebuggerMessage("Runtime.executionContextCreated", created(3, ""), "child");
  return canary;
}

describe("the quiescence canary (save-transfer.md section 5, step 11)", () => {
  it("lets through exactly the calibrated scripts in the preload's world", () => {
    const canary = withWorlds();
    canary.onDebuggerMessage("Debugger.scriptParsed", parsed(2, EMITTER));
    canary.onDebuggerMessage("Debugger.scriptParsed", parsed(2, PRELOAD));
    // Electron evaluates `void 0` (6 characters, no URL) when it sets up the isolated world.
    canary.onDebuggerMessage("Debugger.scriptParsed", parsed(2, "", 6));
    // In a cross-site iframe's own target the preload's world has no name.
    canary.onDebuggerMessage("Debugger.scriptParsed", parsed(3, PRELOAD), "child");
    canary.onDebuggerMessage("Target.attachedToTarget", { targetInfo: { type: "iframe" } });
    canary.onWorkerStatus({ runningStatus: "stopping" });
    canary.onWorkerStatus({ runningStatus: "stopped" });
    expect(canary.violation()).toBeNull();
    expect(canary.scripts()).toEqual({
      electron: 1,
      preload: 2,
      isolatedWorldSetUp: 1,
      harness: 0,
    });
  });

  it.each([
    ["a script in the main world", 1, "http://localhost:4317/game.js", 10, main, undefined],
    ["our preload's URL in the main world", 1, PRELOAD, 10, main, undefined],
    ["an injected script without a URL", 1, "", 6, main, undefined],
    [
      "a game script in the preload's world",
      2,
      "http://localhost:4317/x.js",
      10,
      isolated,
      undefined,
    ],
    [
      "another Electron module than the calibrated one",
      2,
      "electron/js2c/other",
      10,
      isolated,
      undefined,
    ],
    ["another script without a URL", 2, "", 40, isolated, undefined],
    ["a script without context data", 2, PRELOAD, 10, null, undefined],
    ["a script in a context never announced", 9, PRELOAD, 10, isolated, undefined],
    ["the page's own unnamed isolated world", 4, PRELOAD, 10, isolated, "page-unnamed"],
    ["a world with another name", 5, PRELOAD, 10, isolated, "other-name"],
  ] as const)("flags %s", (_name, id, url, length, aux, extra) => {
    const onViolation = vi.fn();
    const canary = withWorlds({ onViolation });
    if (extra === "page-unnamed") {
      canary.onDebuggerMessage("Runtime.executionContextCreated", created(4, ""));
    }
    if (extra === "other-name") {
      canary.onDebuggerMessage("Runtime.executionContextCreated", created(5, "another world"));
    }
    canary.onDebuggerMessage("Debugger.scriptParsed", parsed(id, url, length, aux));
    expect(canary.violation()).toBe("script-outside-preload");
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  it.each(["service_worker", "worker", "shared_worker"])("flags a %s target", (type) => {
    const canary = withWorlds();
    canary.onDebuggerMessage("Target.attachedToTarget", { targetInfo: { type } });
    expect(canary.violation()).toBe("worker-target");
  });

  it("tells contexts of different sessions apart", () => {
    const canary = withWorlds();
    // Context 3 is the iframe target's world; the same id on the page is unknown.
    canary.onDebuggerMessage("Debugger.scriptParsed", parsed(3, PRELOAD));
    expect(canary.violation()).toBe("script-outside-preload");
  });

  it("lets a test harness's own world through only when told to (test flavor), and counts it", () => {
    const world = "__playwright_utility_world_page@0123";
    const strict = withWorlds();
    strict.onDebuggerMessage("Runtime.executionContextCreated", created(6, world));
    strict.onDebuggerMessage("Debugger.scriptParsed", parsed(6, "", 0));
    expect(strict.violation()).toBe("script-outside-preload");
    const harnessed = withWorlds({
      harnessWorld: (name) => name.startsWith("__playwright_utility_world_"),
    });
    harnessed.onDebuggerMessage("Runtime.executionContextCreated", created(6, world));
    harnessed.onDebuggerMessage("Debugger.scriptParsed", parsed(6, "", 0));
    expect(harnessed.violation()).toBeNull();
    expect(harnessed.scripts()).toMatchObject({ harness: 1 });
    // The main world stays off limits for the harness too.
    harnessed.onDebuggerMessage("Debugger.scriptParsed", parsed(1, "", 0, main));
    expect(harnessed.violation()).toBe("script-outside-preload");
  });

  it.each(["starting", "running"])(
    "flags a service worker of the session %s, with its origin",
    (status) => {
      const onViolation = vi.fn();
      const canary = withWorlds({ onViolation });
      canary.onWorkerStatus({ runningStatus: status, scopeOrigin: "http://127.0.0.1:4317" });
      expect(canary.violation()).toBe("service-worker-started");
      expect(onViolation).toHaveBeenCalledWith("service-worker-started", {
        scopeOrigin: "http://127.0.0.1:4317",
      });
    },
  );

  it("flags a debugger that went away, since the canary is then blind", () => {
    const canary = withWorlds();
    canary.onDebuggerDetached();
    expect(canary.violation()).toBe("debugger-detached");
  });

  it("keeps the first violation and reports once, and its reason holds no URL", () => {
    const onViolation = vi.fn();
    const canary = withWorlds({ onViolation });
    canary.onDebuggerMessage(
      "Debugger.scriptParsed",
      parsed(1, "http://localhost:4317/game.js?token=SECRET", 10, main),
    );
    canary.onWorkerStatus({ runningStatus: "running", scopeOrigin: null });
    expect(canary.violation()).toBe("script-outside-preload");
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onViolation.mock.calls)).not.toContain("SECRET");
  });
});
