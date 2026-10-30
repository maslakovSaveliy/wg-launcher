import { describe, expect, it, vi } from "vitest";
import type { SnapshotWorker } from "./client.js";
import { workerSlot } from "./slot.js";

function fakeWorker() {
  return { begin: vi.fn(), kill: vi.fn(async () => undefined) } as unknown as SnapshotWorker & {
    begin: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
}

describe("workerSlot: one snapshot worker per job, always killed", () => {
  it("starts the worker once, begins it once, and kills it on dispose", async () => {
    const worker = fakeWorker();
    const start = vi.fn(async () => worker);
    const slot = workerSlot(start, { maxTotalBytes: 10 });
    const signal = new AbortController().signal;
    expect(await slot.get(signal)).toBe(worker);
    expect(await slot.get(signal)).toBe(worker);
    expect(start).toHaveBeenCalledTimes(1);
    expect(worker.begin).toHaveBeenCalledExactlyOnceWith({ maxTotalBytes: 10 });
    await slot.dispose();
    expect(worker.kill).toHaveBeenCalled();
  });

  it("kills a worker that finishes starting after the job was stopped and disposed", async () => {
    const worker = fakeWorker();
    const started = Promise.withResolvers<SnapshotWorker>();
    const slot = workerSlot(() => started.promise, {});
    const stop = new AbortController();
    const getting = slot.get(stop.signal);
    stop.abort();
    const disposed = slot.dispose();
    started.resolve(worker);
    await disposed;
    expect(await getting).toBeNull();
    expect(worker.kill).toHaveBeenCalled();
  });

  it("gives no worker once the signal is aborted, and kills the one it started", async () => {
    const worker = fakeWorker();
    const stop = new AbortController();
    const slot = workerSlot(async () => {
      stop.abort();
      return worker;
    }, {});
    expect(await slot.get(stop.signal)).toBeNull();
    expect(worker.kill).toHaveBeenCalled();
  });

  it("dispose waits until the killed worker has exited", async () => {
    const exited = Promise.withResolvers<void>();
    const worker = fakeWorker();
    worker.kill.mockReturnValue(exited.promise);
    const slot = workerSlot(async () => worker, {});
    await slot.get(new AbortController().signal);
    let disposed = false;
    const disposing = slot.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disposed).toBe(false);
    exited.resolve();
    await disposing;
    expect(disposed).toBe(true);
  });

  it("disposes without a worker when none was started", async () => {
    const start = vi.fn();
    await workerSlot(start, {}).dispose();
    expect(start).not.toHaveBeenCalled();
  });
});
