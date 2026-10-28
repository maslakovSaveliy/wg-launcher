// The frame end of the quiescent window's message port (save-transfer.md section 5, steps 9 and 10): it runs the
// typed commands the snapshot worker sends, one at a time, and answers each with replies carrying its nonce. Every
// message is validated with `FrameCommand`; anything unexpected (an invalid message, a command while another runs,
// entry chunks out of order) closes the port, which the worker treats as a failed command. Entries go out and come in
// as chunks of at most MAX_ENTRY_CHUNK_BYTES, as cloned ArrayBuffers (protocol.ts). Nothing here evaluates code it
// receives (QW-5).
import { FrameCommand, MAX_ENTRY_CHUNK_BYTES } from "./protocol.js";
import type { FrameScope } from "./scope.js";
import type { EntrySink, FrameError, FrameExporter, FrameResult, FrameTarget } from "./types.js";

/** The parts of a DOM `MessagePort` the server uses (method syntax, so a DOM port fits). */
export interface FramePort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

/** Error messages are short; a longer one is cut to the protocol's bound. */
const MAX_MESSAGE = 1024;

type Reply = Record<string, unknown> & { type: string; nonce: string };

interface Importing {
  nonce: string;
  plan: FrameTarget & { scope: FrameScope };
  entries: { path: string; bytes: Uint8Array }[];
  /** The entry being received: its bytes so far. */
  current: { path: string; size: number; bytes: Uint8Array; received: number } | null;
}

function errorReply(nonce: string, error: FrameError): Reply {
  return {
    type: "error",
    nonce,
    code: error.code,
    message: error.message.slice(0, MAX_MESSAGE),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
}

/** A sink that sends each entry as chunks, the last one shorter, an empty entry as one empty chunk. */
function chunkingSink(port: FramePort, nonce: string): EntrySink {
  return {
    async write(path, bytes) {
      const size = bytes.byteLength;
      let offset = 0;
      do {
        const end = Math.min(offset + MAX_ENTRY_CHUNK_BYTES, size);
        // `slice` copies into a buffer of exactly this chunk; it is cloned, never transferred (protocol.ts).
        const chunk = bytes.slice(offset, end).buffer;
        port.postMessage({ type: "entry", nonce, path, offset, size, bytes: chunk });
        offset = end;
      } while (offset < size);
    },
  };
}

/** Serves one frame's exporter on `port` until the port is closed. */
export function serveFrame(port: FramePort, exporter: FrameExporter): void {
  let busy = false;
  let importing: Importing | null = null;
  let closed = false;

  const abort = () => {
    if (closed) return;
    closed = true;
    busy = false;
    importing = null;
    port.close();
  };

  const run = <T>(
    nonce: string,
    work: () => Promise<FrameResult<T>>,
    reply: (data: T) => Reply,
  ) => {
    busy = true;
    void work()
      .then((result) => {
        if (closed) return;
        port.postMessage(result.ok ? reply(result.data) : errorReply(nonce, result.error));
      })
      .catch(() => {
        // The exporter returns errors as values; a throw here means the frame itself is broken.
        if (!closed) {
          port.postMessage(
            errorReply(nonce, { code: "INTERNAL", message: "the frame command failed" }),
          );
        }
      })
      .finally(() => {
        busy = false;
      });
  };

  /** Adds an import chunk; false when it breaks the order (chunks of one entry back to back, entries one by one). */
  const addChunk = (
    state: Importing,
    path: string,
    offset: number,
    size: number,
    bytes: ArrayBuffer,
  ) => {
    if (state.current === null) {
      if (offset !== 0) return false;
      state.current = { path, size, bytes: new Uint8Array(size), received: 0 };
    }
    const current = state.current;
    if (current.path !== path || current.size !== size || current.received !== offset) return false;
    current.bytes.set(new Uint8Array(bytes), offset);
    current.received += bytes.byteLength;
    if (current.received === current.size) {
      state.entries.push({ path, bytes: current.bytes });
      state.current = null;
    }
    return true;
  };

  port.addEventListener("message", (event) => {
    if (closed) return;
    const parsed = FrameCommand.safeParse(event.data);
    if (!parsed.success || busy) {
      abort();
      return;
    }
    const command = parsed.data;
    if (importing !== null) {
      const state: Importing = importing;
      if (command.nonce !== state.nonce) {
        abort();
      } else if (command.type === "entry") {
        if (!addChunk(state, command.path, command.offset, command.size, command.bytes)) abort();
      } else if (command.type === "end" && state.current === null) {
        importing = null;
        const entries = state.entries;
        async function* source() {
          yield* entries;
        }
        run(
          state.nonce,
          () => exporter.importFrame(source(), state.plan),
          (summary) => ({ type: "summary", nonce: state.nonce, summary }),
        );
      } else {
        abort();
      }
      return;
    }
    switch (command.type) {
      case "inventory":
        run(
          command.nonce,
          () => exporter.inventory(),
          (inventory) => ({
            type: "inventory",
            nonce: command.nonce,
            inventory,
          }),
        );
        return;
      case "export": {
        const { nonce, keyIndex, storageKey, scope } = command;
        run(
          nonce,
          () => exporter.exportFrame({ keyIndex, storageKey, scope }, chunkingSink(port, nonce)),
          (summary) => ({ type: "summary", nonce, summary }),
        );
        return;
      }
      case "wipe-selected":
        run(
          command.nonce,
          () => exporter.wipeSelected(command.scope),
          (wiped) => ({
            type: "wiped",
            nonce: command.nonce,
            wiped,
          }),
        );
        return;
      case "import":
        importing = {
          nonce: command.nonce,
          plan: {
            keyIndex: command.keyIndex,
            storageKey: command.storageKey,
            scope: command.scope,
          },
          entries: [],
          current: null,
        };
        return;
      default:
        // `entry` or `end` outside an import.
        abort();
    }
  });
  port.start();
}
