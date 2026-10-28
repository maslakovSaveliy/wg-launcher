import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  type FrameExporter,
  type FramePort,
  GENERIC_EXPORTER,
  MAX_ENTRY_CHUNK_BYTES,
  serveFrame,
} from "@wg-launcher/exporters/wire";
import { afterEach, describe, expect, it } from "vitest";
import { FrameCommandError, frameExport, frameInventory, type WorkerPort } from "./frame-client.js";

const storageKey = { origin: "http://localhost:4317", topLevelSite: null };
const ALL = { localStorage: "all", indexedDB: "all" } as const;
const SUMMARY = { localStorageItems: 1, databases: [], blobs: 0, notExported: [] };
const INVENTORY = {
  localStorageItems: 3,
  databases: [{ name: "d", version: 2 }],
  usageDetails: null,
};

const open: MessagePort[] = [];
afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

const asWorkerPort = (port: MessagePort): WorkerPort => ({
  onMessage: (listener) => {
    port.on("message", listener);
  },
  onClose: (listener) => {
    port.on("close", listener);
  },
  postMessage: (message) => port.postMessage(message),
  close: () => port.close(),
});

/** The worker's end of a channel whose other end is a frame: a real `serveFrame`, or a hand-written fake. */
function channel(frame: Partial<FrameExporter> | ((port: MessagePort) => void)) {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  if (typeof frame === "function") frame(port2);
  else
    serveFrame(
      port2 as unknown as FramePort,
      { info: GENERIC_EXPORTER, ...frame } as FrameExporter,
    );
  return asWorkerPort(port1);
}

const failureOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    if (error instanceof FrameCommandError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a failure");
};

describe("frame commands from the worker (save-transfer.md section 5, step 10)", () => {
  it("runs an inventory", async () => {
    const port = channel({ inventory: async () => ({ ok: true, data: INVENTORY }) });
    expect(await frameInventory(port)).toEqual(INVENTORY);
  });

  it("runs an export, passing every chunk on, and resolves with the summary", async () => {
    const data = new Uint8Array(MAX_ENTRY_CHUNK_BYTES + 3).fill(5);
    const port = channel({
      exportFrame: async (_request, out) => {
        await out.write("data/0/local-storage.cbor", data);
        return { ok: true, data: SUMMARY };
      },
    });
    const chunks: Array<[string, number, number, number]> = [];
    const summary = await frameExport(port, { keyIndex: 0, storageKey, scope: ALL }, (chunk) =>
      chunks.push([chunk.path, chunk.offset, chunk.size, chunk.bytes.byteLength]),
    );
    expect(summary).toEqual(SUMMARY);
    expect(chunks).toEqual([
      ["data/0/local-storage.cbor", 0, data.length, MAX_ENTRY_CHUNK_BYTES],
      ["data/0/local-storage.cbor", MAX_ENTRY_CHUNK_BYTES, data.length, 3],
    ]);
  });

  it("turns a frame's error reply into its code", async () => {
    const port = channel({
      exportFrame: async () => ({
        ok: false,
        error: { code: "EXP_UNSUPPORTED_VALUE", message: "unsupported [object CryptoKey]" },
      }),
    });
    expect(
      await failureOf(frameExport(port, { keyIndex: 0, storageKey, scope: ALL }, () => {})),
    ).toEqual({
      code: "EXP_UNSUPPORTED_VALUE",
      message: "unsupported [object CryptoKey]",
    });
  });

  it("fails a command whose frame closes the port", async () => {
    const port = channel((frame) => {
      frame.on("message", () => frame.close());
    });
    expect((await failureOf(frameInventory(port))).code).toBe("INTERNAL");
  });

  it.each([
    [
      "a reply with another nonce",
      (nonce: string) => ({
        type: "inventory",
        nonce: nonce.replace(/./, (c) => (c === "0" ? "1" : "0")),
        inventory: INVENTORY,
      }),
    ],
    ["a reply the protocol does not know", (nonce: string) => ({ type: "result", nonce })],
    [
      "an entry chunk in answer to an inventory",
      (nonce: string) => ({
        type: "entry",
        nonce,
        path: "blobs/x",
        offset: 0,
        size: 0,
        bytes: new ArrayBuffer(0),
      }),
    ],
  ])("aborts on %s and closes the port", async (_name, reply) => {
    let closed = false;
    const port = channel((frame) => {
      frame.on("close", () => {
        closed = true;
      });
      frame.on("message", (data: { nonce: string }) => frame.postMessage(reply(data.nonce)));
    });
    expect((await failureOf(frameInventory(port))).code).toBe("INTERNAL");
    await expect.poll(() => closed).toBe(true);
  });

  it("sends a fresh 128-bit nonce with every command", async () => {
    const nonces: string[] = [];
    const port = channel((frame) => {
      frame.on("message", ({ nonce }: { nonce: string }) => {
        nonces.push(nonce);
        frame.postMessage({ type: "inventory", nonce, inventory: INVENTORY });
      });
    });
    await frameInventory(port);
    await frameInventory(port);
    expect(nonces).toHaveLength(2);
    for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("gives up with EXP_TIMEOUT when the frame stays silent", async () => {
    const port = channel(() => {});
    expect((await failureOf(frameInventory(port, { silenceMs: 50 }))).code).toBe("EXP_TIMEOUT");
  });
});
