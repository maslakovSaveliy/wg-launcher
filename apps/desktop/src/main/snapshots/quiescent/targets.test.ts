import { describe, expect, it, vi } from "vitest";
import { createCanary } from "./canary.js";
import { JobStop } from "./stop.js";
import { type JobDebugger, watchTargets } from "./targets.js";

function setUp(send: (method: string, params?: object, sessionId?: string) => Promise<unknown>) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const dbg = {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async () => ({})),
    on: (event: string, listener: (...args: unknown[]) => void) =>
      void listeners.set(event, listener),
    removeListener: vi.fn(),
  } as unknown as JobDebugger;
  const watch = watchTargets({
    debugger: dbg,
    canary: createCanary({ preloadPath: "/p.cjs" }),
    send,
    bypassChildren: true,
    onLost: vi.fn(),
  });
  const emit = (method: string, params: unknown) =>
    listeners.get("message")?.({}, method, params, "");
  return { watch, emit };
}

describe("the job window's targets (save-transfer.md section 5, steps 6 and 8)", () => {
  it("forgets a child target once it detaches", async () => {
    const { watch, emit } = setUp(async () => ({}));
    emit("Target.attachedToTarget", { sessionId: "child-1", targetInfo: { type: "iframe" } });
    emit("Target.attachedToTarget", { sessionId: "child-2", targetInfo: { type: "iframe" } });
    expect(watch.children()).toEqual(["child-1", "child-2"]);
    emit("Target.detachedFromTarget", { sessionId: "child-1" });
    expect(watch.children()).toEqual(["child-2"]);
  });

  it("lets a stopped job's JobStop through while it reads the child targets' frames", async () => {
    const stopped = new JobStop({ ok: false, code: "CANCELLED", message: "stopped" });
    const { watch, emit } = setUp(async (method, _params, sessionId) => {
      if (method === "Page.getFrameTree" && sessionId === "child-1") throw stopped;
      return { frameTree: { frame: { id: "F", url: "about:blank" } } };
    });
    emit("Target.attachedToTarget", { sessionId: "child-1", targetInfo: { type: "iframe" } });
    await expect(watch.resolveKeys([])).rejects.toBe(stopped);
  });

  it("skips a child target that fails for another reason (it is going away)", async () => {
    const { watch, emit } = setUp(async (method, _params, sessionId) => {
      if (method === "Page.getFrameTree" && sessionId === "child-1") throw new Error("No target");
      return { frameTree: { frame: { id: "F", url: "about:blank" } } };
    });
    emit("Target.attachedToTarget", { sessionId: "child-1", targetInfo: { type: "iframe" } });
    await expect(watch.resolveKeys([])).resolves.toEqual({ ok: true, data: undefined });
  });
});
