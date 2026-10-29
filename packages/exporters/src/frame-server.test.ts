import { afterEach, describe, expect, it } from "vitest";
import { type FramePort, serveFrame } from "./frame-server.js";
import { MAX_ENTRY_CHUNK_BYTES } from "./protocol.js";
import type { EntrySource, FrameExporter, FrameSummary } from "./types.js";
import { GENERIC_EXPORTER } from "./types.js";

const nonce = "0123456789abcdef0123456789abcdef";
const other = "fedcba9876543210fedcba9876543210";
const storageKey = { origin: "http://localhost:4317", topLevelSite: null };
const ALL = { localStorage: "all", indexedDB: "all" } as const;
const SUMMARY: FrameSummary = { localStorageItems: 1, databases: [], blobs: 0, notExported: [] };

const open: MessagePort[] = [];
afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

/** A served frame and the worker's end of its channel, recording every reply and whether the frame closed it. */
function setUp(exporter: Partial<FrameExporter>, options: { heartbeatMs?: number } = {}) {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  const replies: Record<string, unknown>[] = [];
  let closed = false;
  const waiters: Array<() => void> = [];
  port1.onmessage = (event: MessageEvent) => {
    replies.push(event.data as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  };
  port1.addEventListener("close", () => {
    closed = true;
    for (const wake of waiters.splice(0)) wake();
  });
  serveFrame(
    port2 as unknown as FramePort,
    { info: GENERIC_EXPORTER, ...exporter } as FrameExporter,
    options,
  );
  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!done() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return {
    send: (message: unknown) => port1.postMessage(message),
    replies,
    closed: () => closed,
    until,
    last: () => replies.at(-1),
  };
}

describe("serveFrame (save-transfer.md section 5, step 10)", () => {
  it("sends a heartbeat with the command's nonce while a command runs, and none after its answer", async () => {
    const frame = setUp(
      {
        wipeSelected: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { ok: true, data: { localStorageItems: 0, databases: [] } };
        },
      },
      { heartbeatMs: 20 },
    );
    frame.send({ type: "wipe-selected", nonce, scope: ALL });
    await frame.until(() => frame.replies.some((r) => r.type === "wiped"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const types = frame.replies.map((r) => r.type);
    expect(types.filter((t) => t === "working").length).toBeGreaterThanOrEqual(2);
    expect(types.at(-1)).toBe("wiped");
    expect(frame.replies.every((r) => r.nonce === nonce)).toBe(true);
  });

  it("answers an inventory with its nonce", async () => {
    const inventory = { localStorageItems: 2, databases: [], usageDetails: { indexedDB: 10 } };
    const frame = setUp({ inventory: async () => ({ ok: true, data: inventory }) });
    frame.send({ type: "inventory", nonce });
    await frame.until(() => frame.replies.length > 0);
    expect(frame.replies).toEqual([{ type: "inventory", nonce, inventory }]);
  });

  it("sends each exported entry in chunks of at most 1 MiB, in order, then the summary", async () => {
    const big = new Uint8Array(2 * MAX_ENTRY_CHUNK_BYTES + 5).map((_, i) => i % 251);
    const frame = setUp({
      exportFrame: async (request, out) => {
        expect(request).toEqual({ keyIndex: 3, storageKey, scope: ALL });
        await out.write("data/3/idb/0/store-0.cbor", big);
        await out.write("data/3/idb/0/schema.cbor", new Uint8Array(0));
        return { ok: true, data: SUMMARY };
      },
    });
    frame.send({ type: "export", nonce, keyIndex: 3, storageKey, scope: ALL });
    await frame.until(() => frame.last()?.type === "summary");
    const entries = frame.replies.filter((reply) => reply.type === "entry");
    expect(
      entries.map(({ path, offset, size, bytes }) => [
        path,
        offset,
        size,
        (bytes as ArrayBuffer).byteLength,
      ]),
    ).toEqual([
      ["data/3/idb/0/store-0.cbor", 0, big.length, MAX_ENTRY_CHUNK_BYTES],
      ["data/3/idb/0/store-0.cbor", MAX_ENTRY_CHUNK_BYTES, big.length, MAX_ENTRY_CHUNK_BYTES],
      ["data/3/idb/0/store-0.cbor", 2 * MAX_ENTRY_CHUNK_BYTES, big.length, 5],
      ["data/3/idb/0/schema.cbor", 0, 0, 0],
    ]);
    for (const entry of entries) expect(entry.bytes).toBeInstanceOf(ArrayBuffer);
    const joined = new Uint8Array(big.length);
    for (const entry of entries.slice(0, 3)) {
      joined.set(new Uint8Array(entry.bytes as ArrayBuffer), entry.offset as number);
    }
    // A plain loop: a deep equality over 2 MiB of bytes takes seconds.
    expect(joined.every((byte, i) => byte === big[i])).toBe(true);
    expect(frame.last()).toEqual({ type: "summary", nonce, summary: SUMMARY });
    expect(frame.replies.every((reply) => reply.nonce === nonce)).toBe(true);
  });

  it("turns a failed command into an error reply with its nonce", async () => {
    const frame = setUp({
      exportFrame: async () => ({
        ok: false,
        error: {
          code: "EXP_UNSUPPORTED_VALUE",
          message: "x".repeat(5000),
          detail: { path: ["a"], type: "[object CryptoKey]" },
        },
      }),
    });
    frame.send({ type: "export", nonce, keyIndex: 0, storageKey, scope: ALL });
    await frame.until(() => frame.replies.length > 0);
    expect(frame.replies).toEqual([
      {
        type: "error",
        nonce,
        code: "EXP_UNSUPPORTED_VALUE",
        message: "x".repeat(1024),
        detail: { path: ["a"], type: "[object CryptoKey]" },
      },
    ]);
  });

  it("assembles an import's chunks into whole entries before the importer reads them", async () => {
    const seen: Array<{ path: string; bytes: number[] }> = [];
    const frame = setUp({
      importFrame: async (source: EntrySource, plan) => {
        expect(plan).toEqual({ keyIndex: 0, storageKey, scope: ALL });
        for await (const entry of source) seen.push({ path: entry.path, bytes: [...entry.bytes] });
        return { ok: true, data: SUMMARY };
      },
    });
    const chunk = (path: string, offset: number, size: number, bytes: number[]) => ({
      type: "entry",
      nonce,
      path,
      offset,
      size,
      bytes: new Uint8Array(bytes).buffer,
    });
    frame.send({ type: "import", nonce, keyIndex: 0, storageKey, scope: ALL });
    frame.send(chunk("data/0/local-storage.cbor", 0, 3, [1, 2, 3]));
    frame.send(chunk("blobs/a", 0, 0, []));
    frame.send({ type: "end", nonce });
    await frame.until(() => frame.replies.length > 0);
    expect(frame.replies).toEqual([{ type: "summary", nonce, summary: SUMMARY }]);
    expect(seen).toEqual([
      { path: "data/0/local-storage.cbor", bytes: [1, 2, 3] },
      { path: "blobs/a", bytes: [] },
    ]);
  });

  it.each([
    ["an unknown command", [{ type: "eval", nonce, code: "1" }]],
    ["a message that is not an object", ["inventory"]],
    ["an entry outside an import", [{ type: "end", nonce }]],
    [
      "an import chunk out of order",
      [
        { type: "import", nonce, keyIndex: 0, storageKey, scope: ALL },
        { type: "entry", nonce, path: "blobs/a", offset: 1, size: 2, bytes: new ArrayBuffer(1) },
      ],
    ],
    [
      "a new entry before the last one is complete",
      [
        { type: "import", nonce, keyIndex: 0, storageKey, scope: ALL },
        { type: "entry", nonce, path: "blobs/a", offset: 0, size: 2, bytes: new ArrayBuffer(1) },
        { type: "entry", nonce, path: "blobs/b", offset: 0, size: 1, bytes: new ArrayBuffer(1) },
      ],
    ],
    [
      "an import chunk with another nonce",
      [
        { type: "import", nonce, keyIndex: 0, storageKey, scope: ALL },
        {
          type: "entry",
          nonce: other,
          path: "blobs/a",
          offset: 0,
          size: 0,
          bytes: new ArrayBuffer(0),
        },
      ],
    ],
    [
      "the end of an import whose last entry is incomplete",
      [
        { type: "import", nonce, keyIndex: 0, storageKey, scope: ALL },
        { type: "entry", nonce, path: "blobs/a", offset: 0, size: 2, bytes: new ArrayBuffer(1) },
        { type: "end", nonce },
      ],
    ],
  ])("closes the port on %s, without running anything", async (_name, messages) => {
    let ran = false;
    const frame = setUp({
      inventory: async () => {
        ran = true;
        return { ok: true, data: { localStorageItems: 0, databases: [], usageDetails: null } };
      },
      importFrame: async () => {
        ran = true;
        return { ok: true, data: SUMMARY };
      },
    });
    for (const message of messages) frame.send(message);
    await frame.until(frame.closed);
    expect(frame.closed()).toBe(true);
    expect(ran).toBe(false);
    expect(frame.replies).toEqual([]);
  });

  it("closes the port when a command arrives while another one runs", async () => {
    let finish: () => void = () => undefined;
    const frame = setUp({
      inventory: () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              data: { localStorageItems: 0, databases: [], usageDetails: null },
            });
        }),
    });
    frame.send({ type: "inventory", nonce });
    frame.send({ type: "inventory", nonce: other });
    await frame.until(frame.closed);
    expect(frame.closed()).toBe(true);
    finish();
  });
});
