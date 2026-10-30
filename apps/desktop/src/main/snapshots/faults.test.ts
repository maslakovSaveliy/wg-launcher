import { describe, expect, it, vi } from "vitest";
import { faultHook, InjectedFault, parseFault } from "./faults.js";

describe("the restore fault hook (AC-8, Review Focus 2)", () => {
  it("fails a step when it starts and crashes after a step has finished", () => {
    const crash = vi.fn();
    const hook = faultHook(["fail:import", "crash-after:wipe"], crash);
    expect(() => hook("wipe", "start")).not.toThrow();
    expect(crash).not.toHaveBeenCalled();
    hook("wipe", "end");
    expect(crash).toHaveBeenCalledTimes(1);
    expect(() => hook("import", "start")).toThrow(InjectedFault);
    expect(() => hook("import", "end")).not.toThrow();
    expect(() => hook("rollback-import", "start")).not.toThrow();
  });

  it("knows the restore and rollback steps only", () => {
    expect(parseFault("fail:rollback-verify")).toEqual({
      mode: "fail",
      point: "rollback-verify",
      ms: 0,
    });
    for (const bad of ["fail:delete", "crash-before:wipe", "fail", "fail:wipe:x"]) {
      expect(parseFault(bad)).toBeNull();
    }
    expect(() => faultHook(["boom:wipe"], () => undefined)).toThrow(TypeError);
  });

  it("throws a plain Error for throw:<step> and gives a delay inside the window for slow:<step>:<ms>", () => {
    const hook = faultHook(["throw:commit", "slow:import:6000"], () => undefined);
    let thrown: unknown;
    try {
      hook("commit", "start");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(InjectedFault);
    expect(hook("import", "window")).toBe(6000);
    expect(hook("wipe", "window")).toBe(0);
    expect(parseFault("slow:import")).toBeNull();
    expect(parseFault("slow:import:x")).toBeNull();
  });
});
