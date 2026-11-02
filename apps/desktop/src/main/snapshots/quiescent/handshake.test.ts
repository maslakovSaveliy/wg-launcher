import { describe, expect, it } from "vitest";
import { createHandshake, isJobNonce, newJobNonce } from "./handshake.js";
import { stubUrl } from "./stub.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const contents = { id: 7 };
const top = stubUrl("http://localhost:4317", NONCE, 0);
const frame = stubUrl("http://127.0.0.1:4317", NONCE, 1);

function setUp() {
  const handshake = createHandshake({
    contents,
    jobNonce: NONCE,
    frames: new Map([
      [top, "top-key"],
      [frame, "frame-key"],
    ]),
  });
  const hello = (
    event: { sender?: unknown; url?: string | null },
    message: unknown = { job: NONCE },
  ) =>
    handshake.accept(
      {
        sender: "sender" in event ? event.sender : contents,
        senderFrame: event.url === null ? null : { url: event.url ?? top },
      },
      message,
    );
  return { handshake, hello };
}

describe("the quiescent handshake (QW-4, S-10)", () => {
  it("accepts each expected frame once, from the job's webContents, with the job nonce", () => {
    const { hello, handshake } = setUp();
    expect(hello({ url: top })).toEqual({ ok: true, key: "top-key" });
    expect(hello({ url: frame })).toEqual({ ok: true, key: "frame-key" });
    expect(handshake.pending()).toEqual([]);
    // A second hello from the same frame (a reload, a replay) is refused.
    expect(hello({ url: top })).toEqual({ ok: false, reason: "already-connected" });
  });

  it.each([
    ["another webContents", { sender: { id: 7 } }, { job: NONCE }, "wrong-contents"],
    ["no sender frame", { url: null }, { job: NONCE }, "wrong-frame"],
    [
      "a frame at an unexpected URL",
      { url: "http://localhost:4317/" },
      { job: NONCE },
      "wrong-frame",
    ],
    [
      "the stub of another job",
      { url: stubUrl("http://localhost:4317", "f".repeat(32), 0) },
      { job: NONCE },
      "wrong-frame",
    ],
    ["a wrong nonce", {}, { job: "f".repeat(32) }, "wrong-nonce"],
    ["a short nonce", {}, { job: NONCE.slice(0, 31) }, "wrong-nonce"],
    ["an upper-case nonce", {}, { job: NONCE.toUpperCase() }, "wrong-nonce"],
    ["a counter", {}, { job: 1 }, "wrong-nonce"],
    ["an extra member", {}, { job: NONCE, code: "1" }, "wrong-nonce"],
    ["no message", {}, null, "wrong-nonce"],
  ])("refuses %s", (_name, event, message, reason) => {
    const { hello, handshake } = setUp();
    expect(hello(event, message)).toEqual({ ok: false, reason });
    expect(handshake.pending()).toEqual([top, frame]);
  });

  it("makes 128-bit random nonces, never a counter", () => {
    const a = newJobNonce();
    const b = newJobNonce();
    expect(isJobNonce(a)).toBe(true);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
