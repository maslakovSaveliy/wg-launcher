import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

// security.md section 9: game URLs reduced to their origin, the home directory as `~`, cookie and
// Authorization headers never logged, deep-link input only as its length, bytes only as a count.
// Placeholder home directories (real-looking home paths would trip `pnpm paths:check`).
const HOME = "/srv/player";

describe("redact", () => {
  it("reduces http, https and ws URLs to their origin, also inside messages", () => {
    expect(
      redact(
        {
          url: "https://game.example/play/level?token=abc#frag",
          ws: "wss://game.example:8443/socket?session=1",
          message: "load failed for http://127.0.0.1:4317/index.html?x=1 after 3 tries",
        },
        HOME,
      ),
    ).toEqual({
      url: "https://game.example",
      ws: "wss://game.example:8443",
      message: "load failed for http://127.0.0.1:4317 after 3 tries",
    });
  });

  it("drops user info, which the origin never contains", () => {
    expect(redact({ url: "https://user:secret@game.example/x" }, HOME)).toEqual({
      url: "https://game.example",
    });
  });

  it("keeps strings that hold no URL, path or deep link", () => {
    expect(redact({ event: "app.start", flavor: "test", count: 3, ok: true }, HOME)).toEqual({
      event: "app.start",
      flavor: "test",
      count: 3,
      ok: true,
    });
  });

  it("replaces the home directory with ~ only on a path boundary", () => {
    expect(
      redact(
        {
          file: "/srv/player/Library/WGLauncher/logs/main.log",
          other: "/srv/player2/x",
          bare: "/srv/player",
        },
        HOME,
      ),
    ).toEqual({ file: "~/Library/WGLauncher/logs/main.log", other: "/srv/player2/x", bare: "~" });
  });

  it("replaces a Windows home directory written with either separator", () => {
    const home = "D:\\Profiles\\player";
    expect(
      redact(
        { a: "D:\\Profiles\\player\\AppData\\Roaming\\x", b: "D:/Profiles/player/AppData/x" },
        home,
      ),
    ).toEqual({ a: "~\\AppData\\Roaming\\x", b: "~/AppData/x" });
  });

  it("drops Authorization and cookie headers at any depth, whatever their case", () => {
    expect(
      redact(
        {
          cookie: "sid=1",
          request: {
            headers: {
              Authorization: "Bearer abc",
              "Proxy-Authorization": "Basic xyz",
              Cookie: "a=b",
              "set-cookie": ["c=d"],
              Accept: "text/html",
            },
          },
        },
        HOME,
      ),
    ).toEqual({ request: { headers: { Accept: "text/html" } } });
  });

  it("logs deep-link input only as its length", () => {
    const input = "wglauncher://launch/0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b?extra=secret";
    expect(redact({ input, message: `received ${input} from argv` }, HOME)).toEqual({
      input: `[deep link, ${input.length} chars]`,
      message: `received [deep link, ${input.length} chars] from argv`,
    });
  });

  it("logs bytes only as a count", () => {
    expect(
      redact(
        { a: new Uint8Array(5), b: new ArrayBuffer(7), c: new DataView(new ArrayBuffer(3)) },
        HOME,
      ),
    ).toEqual({ a: "[5 bytes]", b: "[7 bytes]", c: "[3 bytes]" });
  });

  it("logs an error as name, code and redacted message and stack", () => {
    const error = Object.assign(
      new Error("open /srv/player/x failed for https://g.example/a?t=1"),
      {
        code: "ENOENT",
      },
    );
    const out = redact({ error }, HOME).error as Record<string, unknown>;
    expect(out.name).toBe("Error");
    expect(out.code).toBe("ENOENT");
    expect(out.message).toBe("open ~/x failed for https://g.example");
    expect(String(out.stack)).not.toContain("/srv/player/");
    expect(String(out.stack)).not.toContain("t=1");
  });

  it("redacts arrays and object keys, and marks cycles instead of recursing", () => {
    const record: Record<string, unknown> = {
      urls: ["https://a.example/p?q=1", "plain"],
      counts: { "https://b.example/x?y=2": 1 },
    };
    record.self = record;
    expect(redact(record, HOME)).toEqual({
      urls: ["https://a.example", "plain"],
      counts: { "https://b.example": 1 },
      self: "[circular]",
    });
  });

  it("does not change the record it is given", () => {
    const record = { url: "https://a.example/p?q=1", headers: { cookie: "x" } };
    redact(record, HOME);
    expect(record).toEqual({ url: "https://a.example/p?q=1", headers: { cookie: "x" } });
  });
});
