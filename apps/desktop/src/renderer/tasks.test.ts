import type { TaskProgressEvent } from "@wg-launcher/shared";
import { describe, expect, it } from "vitest";
import { applyProgress, describeTask, formatBytes, latestTask, type TaskBook } from "./tasks.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const OTHER = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c";
const T1 = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a71";
const T2 = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a72";

const event = (overrides: Partial<TaskProgressEvent>): TaskProgressEvent => ({
  taskId: T1,
  gameId: GAME,
  kind: "export",
  step: "lock",
  status: "running",
  ...overrides,
});

const book = (...events: TaskProgressEvent[]): TaskBook =>
  events.reduce(applyProgress, new Map() as TaskBook);

describe("task progress in the launcher (architecture.md section 6, task:progress)", () => {
  it("keeps the last event of each task and keeps the bytes measured so far", () => {
    const tasks = book(
      event({ step: "lock" }),
      event({ step: "read", bytesDone: 2048 }),
      event({ step: "write" }),
    );
    expect(latestTask(tasks, GAME)).toMatchObject({ step: "write", bytesDone: 2048 });
  });

  it("shows a game's latest task, never another game's", () => {
    const tasks = book(
      event({ taskId: T1, kind: "export", status: "done", step: "write" }),
      event({ taskId: T2, kind: "verify", step: "validate" }),
      event({ taskId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a73", gameId: OTHER, kind: "import" }),
    );
    expect(latestTask(tasks, GAME)).toMatchObject({ taskId: T2, kind: "verify" });
    expect(latestTask(tasks, OTHER)).toMatchObject({ kind: "import" });
    expect(latestTask(book(), GAME)).toBeNull();
  });

  it("does not let a late running event undo a task's outcome", () => {
    const tasks = book(event({ status: "done", step: "write" }), event({ step: "read" }));
    expect(latestTask(tasks, GAME)).toMatchObject({ status: "done", step: "write" });
  });
});

describe("what the launcher says about a task: real steps and measured bytes only", () => {
  it("names the step and the bytes read, with no percentage when the total is unknown", () => {
    const text = describeTask(event({ step: "read", bytesDone: 1536 }));
    expect(text).toBe("Export: reading the saves (1.5 KiB read)");
    expect(text).not.toMatch(/%/);
  });

  it("gives a percentage only when main sent the total", () => {
    expect(describeTask(event({ step: "read", bytesDone: 512, bytesTotal: 2048 }))).toBe(
      "Export: reading the saves (512 B of 2.0 KiB, 25%)",
    );
  });

  it("shows a failure's code and message as text (AC-10)", () => {
    expect(
      describeTask(
        event({
          step: "read",
          status: "failed",
          code: "EXP_UNSUPPORTED_VALUE",
          message: "A value at store x, key 3 is a function.",
        }),
      ),
    ).toBe("Export failed: EXP_UNSUPPORTED_VALUE: A value at store x, key 3 is a function.");
  });

  it("says when a task is done, and names the rollback steps of a restore", () => {
    expect(describeTask(event({ kind: "import", step: "commit", status: "done" }))).toBe(
      "Import: done",
    );
    expect(describeTask(event({ kind: "import", step: "rollback-import" }))).toBe(
      "Import: putting back the saves from before",
    );
  });

  it("formats bytes in B, KiB and MiB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(5 * 1024 * 1024 + 512 * 1024)).toBe("5.5 MiB");
  });
});
