import { describe, expect, it } from "vitest";
import { createPlaytime, keepSession, type PlaytimeEvent } from "./playtime.js";

// AC-15 (architecture.md section 10): with a fake clock and window events, playtime accrues only
// while the window is visible, focused, not minimized, not suspended and not locked.

/** A fake monotonic clock that drives one playtime machine. */
function setup(start = 1_000) {
  let now = start;
  const machine = createPlaytime(now);
  return {
    send(...events: PlaytimeEvent[]) {
      for (const e of events) machine.on(e, now);
    },
    advance(ms: number) {
      now += ms;
    },
    setNow(ms: number) {
      now = ms;
    },
    active: () => machine.activeMs(now),
  };
}

describe("playtime accrual", () => {
  it("accrues nothing until the window has been shown and focused", () => {
    const t = setup();
    t.advance(5_000);
    expect(t.active()).toBe(0);
    t.send("show");
    t.advance(5_000);
    expect(t.active()).toBe(0);
    t.send("focus");
    t.advance(2_000);
    expect(t.active()).toBe(2_000);
  });

  it("does not accrue while focused but never shown", () => {
    const t = setup();
    t.send("focus");
    t.advance(4_000);
    expect(t.active()).toBe(0);
  });

  it("stops on blur and resumes on focus", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(3_000);
    t.send("blur");
    t.advance(60_000);
    expect(t.active()).toBe(3_000);
    t.send("focus");
    t.advance(1_000);
    expect(t.active()).toBe(4_000);
  });

  it("stops on minimize and resumes on restore", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(3_000);
    t.send("minimize");
    t.advance(60_000);
    expect(t.active()).toBe(3_000);
    t.send("restore");
    t.advance(500);
    expect(t.active()).toBe(3_500);
  });

  it("stops while the window is hidden", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(1_000);
    t.send("hide");
    t.advance(10_000);
    expect(t.active()).toBe(1_000);
    t.send("show");
    t.advance(1_000);
    expect(t.active()).toBe(2_000);
  });

  it("stops on system suspend and resumes on resume", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(2_000);
    t.send("suspend");
    t.advance(3_600_000);
    expect(t.active()).toBe(2_000);
    t.send("resume");
    t.advance(1_000);
    expect(t.active()).toBe(3_000);
  });

  it("stops on screen lock and resumes on unlock", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(2_000);
    t.send("lock-screen");
    t.advance(600_000);
    expect(t.active()).toBe(2_000);
    t.send("unlock-screen");
    t.advance(1_000);
    expect(t.active()).toBe(3_000);
  });

  it("needs every condition: leaving one blocker does not resume while another holds", () => {
    const t = setup();
    t.send("show", "focus", "blur", "lock-screen");
    t.advance(1_000);
    t.send("unlock-screen");
    t.advance(1_000);
    expect(t.active()).toBe(0);
    t.send("focus");
    t.advance(1_000);
    expect(t.active()).toBe(1_000);
    t.send("suspend");
    t.advance(1_000);
    t.send("minimize", "resume");
    t.advance(1_000);
    expect(t.active()).toBe(1_000);
    t.send("restore");
    t.advance(1_000);
    expect(t.active()).toBe(2_000);
  });

  it("lets a window event arrive while suspended without accruing", () => {
    const t = setup();
    t.send("show", "suspend", "focus");
    t.advance(5_000);
    expect(t.active()).toBe(0);
    t.send("resume");
    t.advance(500);
    expect(t.active()).toBe(500);
  });

  it("is idempotent for repeated events", () => {
    const t = setup();
    t.send("show", "show", "focus", "focus");
    t.advance(1_000);
    t.send("focus");
    t.advance(1_000);
    expect(t.active()).toBe(2_000);
    t.send("blur", "blur", "blur");
    t.advance(1_000);
    t.send("focus");
    t.advance(1_000);
    expect(t.active()).toBe(3_000);
    t.send("suspend", "suspend");
    t.advance(1_000);
    t.send("resume");
    t.advance(1_000);
    expect(t.active()).toBe(4_000);
  });

  it("reads activeMs without side effects", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(1_500);
    expect(t.active()).toBe(1_500);
    expect(t.active()).toBe(1_500);
    t.advance(500);
    expect(t.active()).toBe(2_000);
  });

  it("freezes at closed and ignores every later event", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(7_000);
    t.send("closed");
    t.advance(60_000);
    expect(t.active()).toBe(7_000);
    t.send("focus", "show", "restore", "resume", "unlock-screen", "closed");
    t.advance(60_000);
    expect(t.active()).toBe(7_000);
  });

  it("counts the time up to closed when the window closes while blurred", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(4_000);
    t.send("blur");
    t.advance(9_000);
    t.send("closed");
    expect(t.active()).toBe(4_000);
  });

  it("never goes negative or lowers banked time when the clock goes backwards", () => {
    const t = setup(10_000);
    t.send("show", "focus");
    t.advance(2_000);
    t.send("focus"); // banks the 2 000 ms (a repeated event changes nothing else)
    t.setNow(5_000);
    expect(t.active()).toBe(2_000);
    t.send("blur");
    expect(t.active()).toBe(2_000);
    t.send("focus");
    t.advance(1_000);
    expect(t.active()).toBe(3_000);
  });

  it("treats a backwards step as zero elapsed time, then continues from the new reading", () => {
    const t = setup(10_000);
    t.send("show", "focus");
    t.advance(2_000);
    t.send("focus");
    t.setNow(1_000);
    t.send("blur", "focus");
    t.advance(500);
    expect(t.active()).toBe(2_500);
  });

  it("counts a backwards step before any banking as zero, not a negative amount", () => {
    const t = setup(10_000);
    t.send("show", "focus");
    t.setNow(4_000);
    expect(t.active()).toBe(0);
    t.send("blur");
    expect(t.active()).toBe(0);
  });
});

describe("keepSession", () => {
  it("drops a session under 10 000 ms of active time and keeps 10 000 ms", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(9_999);
    expect(keepSession(t.active())).toBe(false);
    t.advance(1);
    expect(keepSession(t.active())).toBe(true);
  });

  it("judges active time, not wall time", () => {
    const t = setup();
    t.send("show", "focus");
    t.advance(5_000);
    t.send("blur");
    t.advance(600_000);
    t.send("closed");
    expect(keepSession(t.active())).toBe(false);
  });

  it("drops zero", () => {
    expect(keepSession(0)).toBe(false);
  });
});
