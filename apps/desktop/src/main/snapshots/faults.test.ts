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
    expect(parseFault("fail:rollback-verify")).toEqual({ mode: "fail", point: "rollback-verify" });
    for (const bad of ["fail:delete", "crash-before:wipe", "fail", "fail:wipe:x"]) {
      expect(parseFault(bad)).toBeNull();
    }
    expect(() => faultHook(["boom:wipe"], () => undefined)).toThrow(TypeError);
  });
});
