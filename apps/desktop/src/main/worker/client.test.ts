import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startSnapshotWorker, type UtilityProcessLike } from "./client.js";

/** A utility process that is ready at once and exits only when the test says so. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & UtilityProcessLike & { posted: unknown[] };
  child.posted = [];
  child.postMessage = (message: unknown) => {
    child.posted.push(message);
  };
  child.kill = vi.fn(() => true);
  return child;
}

const MANIFEST = {} as Parameters<
  Awaited<ReturnType<typeof startSnapshotWorker>>["write"]
>[0]["manifest"];

async function started() {
  const child = fakeChild();
  const log = { error: vi.fn(), warn: vi.fn() };
  const starting = startSnapshotWorker({ fork: () => child, log });
  child.emit("message", { type: "ready" });
  return { child, log, worker: await starting };
}

describe("the snapshot worker client", () => {
  it("kill resolves once the process has exited, and only then fails a pending write", async () => {
    const { child, log, worker } = await started();
    let written: unknown = null;
    const writing = worker
      .write({ manifest: MANIFEST, partialPath: "p", finalPath: "f" })
      .then((result) => {
        written = result;
      });
    let killed = false;
    const killing = worker.kill().then(() => {
      killed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(child.kill).toHaveBeenCalled();
    // The process may still write or rename until it has exited.
    expect(killed).toBe(false);
    expect(written).toBeNull();
    child.emit("exit", 0);
    await Promise.all([killing, writing]);
    expect(written).toMatchObject({ ok: false, code: "INTERNAL" });
    // A kill the job asked for is not an unexpected exit.
    expect(log.warn).not.toHaveBeenCalled();
    // A request after the kill fails at once.
    expect(
      await worker.write({ manifest: MANIFEST, partialPath: "p", finalPath: "f" }),
    ).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  it("kill gives up waiting after a bound when the process never reports its exit", async () => {
    vi.useFakeTimers();
    try {
      const { log, worker } = await started();
      let killed = false;
      void worker.kill().then(() => {
        killed = true;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(killed).toBe(true);
      expect(log.warn).toHaveBeenCalledWith("snapshot.worker-kill-timeout", { waitedMs: 2000 });
    } finally {
      vi.useRealTimers();
    }
  });
});
