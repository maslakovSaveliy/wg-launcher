import { describe, expect, it } from "vitest";
import { decideFlushState, type FlushObservation } from "./flush.js";

// AC-12 (save-transfer.md section 7) with a fake hook: only a success without input and with a prompt close is
// `confirmed`.
const success: FlushObservation = {
  hook: "emscripten-idbfs",
  timeoutMs: 5000,
  viaFlushFlow: true,
  run: { kind: "returned", value: true, startedAt: 1000, finishedAt: 1400 },
  inputAt: [],
  closedByLauncherAt: 2000,
};

const withRun = (run: FlushObservation["run"]): FlushObservation => ({ ...success, run });

describe("decideFlushState (AC-12)", () => {
  it("confirms a hook that returned true, with no input after its start and a prompt close", () => {
    expect(decideFlushState(success)).toBe("confirmed");
  });

  it("leaves a snapshot without a declared hook unconfirmed", () => {
    expect(decideFlushState({ ...success, hook: "none" })).toBe("unconfirmed");
    expect(decideFlushState({ ...withRun({ kind: "not-run" }), hook: "none" })).toBe("unconfirmed");
  });

  it("leaves it unconfirmed when the export was not requested through the flush flow", () => {
    expect(decideFlushState({ ...success, viaFlushFlow: false })).toBe("unconfirmed");
  });

  it("leaves it unconfirmed when the hook did not run, threw or timed out", () => {
    expect(decideFlushState(withRun({ kind: "not-run" }))).toBe("unconfirmed");
    expect(decideFlushState(withRun({ kind: "threw", startedAt: 1000, finishedAt: 1100 }))).toBe(
      "unconfirmed",
    );
    expect(decideFlushState(withRun({ kind: "timed-out", startedAt: 1000 }))).toBe("unconfirmed");
  });

  it("treats a true that arrived after the timeout as a timeout", () => {
    const late = { kind: "returned", value: true, startedAt: 1000, finishedAt: 6001 } as const;
    expect(decideFlushState({ ...withRun(late), closedByLauncherAt: 6500 })).toBe("unconfirmed");
    const onTime = { ...late, finishedAt: 6000 };
    expect(decideFlushState({ ...withRun(onTime), closedByLauncherAt: 6500 })).toBe("confirmed");
  });

  it.each([
    ["1", 1],
    ["the string true", "true"],
    ["an object", {}],
    ["undefined", undefined],
    ["a boxed true", Object(true)],
  ])("leaves it unconfirmed when the hook returned %s instead of true", (_name, value) => {
    const run = { kind: "returned", value, startedAt: 1000, finishedAt: 1400 } as const;
    expect(decideFlushState(withRun(run))).toBe("unconfirmed");
  });

  it("leaves it unconfirmed when user input reached the game between the hook's start and the close", () => {
    for (const at of [1000, 1200, 1400, 1900, 2000]) {
      expect(decideFlushState({ ...success, inputAt: [at] })).toBe("unconfirmed");
    }
    expect(decideFlushState({ ...success, inputAt: [10, 999, 2001] })).toBe("confirmed");
  });

  it("leaves it unconfirmed after a late close, a close before the hook finished or no launcher close", () => {
    expect(decideFlushState({ ...success, closedByLauncherAt: 3400 })).toBe("confirmed");
    expect(decideFlushState({ ...success, closedByLauncherAt: 3401 })).toBe("unconfirmed");
    expect(decideFlushState({ ...success, closedByLauncherAt: 1399 })).toBe("unconfirmed");
    expect(decideFlushState({ ...success, closedByLauncherAt: null })).toBe("unconfirmed");
  });

  it("leaves it unconfirmed for times that are not finite numbers", () => {
    expect(decideFlushState({ ...success, closedByLauncherAt: Number.NaN })).toBe("unconfirmed");
    const run = { kind: "returned", value: true, startedAt: Number.NaN, finishedAt: 1400 } as const;
    expect(decideFlushState(withRun(run))).toBe("unconfirmed");
    expect(decideFlushState({ ...success, inputAt: [Number.NaN] })).toBe("unconfirmed");
    expect(decideFlushState({ ...success, timeoutMs: Number.POSITIVE_INFINITY })).toBe(
      "unconfirmed",
    );
  });
});
