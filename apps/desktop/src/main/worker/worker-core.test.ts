import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  type FrameExporter,
  type FramePort,
  GENERIC_EXPORTER,
  serveFrame,
} from "@wg-launcher/exporters/wire";
import { encodeLocalStorage } from "@wg-launcher/snapshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerPort } from "./frame-client.js";
import type { ManifestFields, WorkerEvent } from "./protocol.js";
import { createWorkerCore } from "./worker-core.js";

const storageKey = { origin: "http://localhost:4317", topLevelSite: null };
const ALL = { localStorage: "all", indexedDB: "all" } as const;
const LOCAL = encodeLocalStorage([["k", "v".repeat(3 * 1024 * 1024)]]) as Uint8Array;

const MANIFEST: ManifestFields = {
  format: "wgsnap",
  formatVersion: 1,
  gameId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b",
  revisionId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c",
  parentRevisionId: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  deviceId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7d",
  exporter: { id: "generic-web-storage", version: "1.0.0" },
  adapter: null,
  gameVersion: null,
  flushState: "unconfirmed",
  storageKeys: [{ ...storageKey, role: "top" }],
};

const exporter: Partial<FrameExporter> = {
  exportFrame: async (_request, out) => {
    await out.write("data/0/local-storage.cbor", LOCAL);
    return {
      ok: true,
      data: { localStorageItems: 1, databases: [], blobs: 0, notExported: ["cacheStorage"] },
    };
  },
};

let dir: string;
const open: MessagePort[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wg-worker-"));
  await mkdir(join(dir, "tmp"));
  await mkdir(join(dir, "snapshots"));
});
afterEach(async () => {
  for (const port of open.splice(0)) port.close();
  await rm(dir, { recursive: true, force: true });
});

function framePort(): WorkerPort {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  serveFrame(
    port2 as unknown as FramePort,
    { info: GENERIC_EXPORTER, ...exporter } as FrameExporter,
  );
  return {
    onMessage: (listener) => {
      port1.on("message", listener);
    },
    onClose: (listener) => {
      port1.on("close", listener);
    },
    postMessage: (message) => port1.postMessage(message),
    close: () => port1.close(),
  };
}

function setUp(allowFaults = false) {
  const events: WorkerEvent[] = [];
  const core = createWorkerCore({ post: (event) => events.push(event), allowFaults });
  const exportFrame = () =>
    core.handle(
      {
        type: "frame",
        jobId: 1,
        requestId: 2,
        op: { op: "export", keyIndex: 0, storageKey, scope: ALL },
      },
      [framePort()],
    );
  const write = (fault?: "fail-write") =>
    core.handle(
      {
        type: "write",
        jobId: 1,
        requestId: 3,
        manifest: MANIFEST,
        partialPath: join(dir, "tmp", "x.wgsnap.partial"),
        finalPath: join(dir, "snapshots", "x.wgsnap"),
        ...(fault ? { fault } : {}),
      },
      [],
    );
  return { core, events, exportFrame, write };
}

describe("the snapshot worker's commands", () => {
  it("collects a frame's export, reports measured bytes, and writes the validated file", async () => {
    const { core, events, exportFrame, write } = setUp();
    await core.handle({ type: "begin", jobId: 1, limits: {} }, []);
    await exportFrame();
    await write();
    expect(events.filter((e) => e.type === "received").map((e) => e.bytes)).toEqual([
      1024 * 1024,
      2 * 1024 * 1024,
      3 * 1024 * 1024,
      LOCAL.length,
    ]);
    expect(events.find((e) => e.type === "exported")).toEqual({
      type: "exported",
      requestId: 2,
      summary: {
        localStorageItems: 1,
        databases: 0,
        records: 0,
        blobs: 0,
        notExported: ["cacheStorage"],
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "written", requestId: 3, entries: 1 });
    expect(await readdir(join(dir, "snapshots"))).toEqual(["x.wgsnap"]);
    expect(await readdir(join(dir, "tmp"))).toEqual([]);
  });

  it("fails the frame with the limit's code as soon as an entry declares too many bytes", async () => {
    const { core, events, exportFrame } = setUp();
    await core.handle({ type: "begin", jobId: 1, limits: { maxEntryBytes: 1024 } }, []);
    await exportFrame();
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      requestId: 2,
      code: "SNAP_ENTRY_TOO_LARGE",
    });
    expect(events.some((e) => e.type === "received")).toBe(false);
  });

  it("honors the fail-write fault only when faults are allowed (test flavor)", async () => {
    for (const allowFaults of [true, false]) {
      const { core, events, exportFrame, write } = setUp(allowFaults);
      await core.handle({ type: "begin", jobId: 1, limits: {} }, []);
      await exportFrame();
      await write("fail-write");
      expect(events.at(-1)?.type).toBe(allowFaults ? "failed" : "written");
      await rm(join(dir, "snapshots", "x.wgsnap"), { force: true });
    }
  });

  it("refuses a message it does not know, and a write of a job it has not begun", async () => {
    const { core, events, write } = setUp();
    await expect(core.handle({ type: "eval", code: "1" }, [])).rejects.toThrow(TypeError);
    // The job is forgotten after its write, whatever the outcome; there is no other way to drop it.
    await expect(core.handle({ type: "discard", jobId: 1 }, [])).rejects.toThrow(TypeError);
    await write();
    expect(events.at(-1)).toEqual({
      type: "failed",
      requestId: 3,
      code: "INTERNAL",
      message: "No such job.",
    });
  });
});
