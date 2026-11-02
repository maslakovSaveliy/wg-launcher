import { describe, expect, it, vi } from "vitest";
import { type InterceptorSession, installInterceptor } from "./interceptor.js";
import { STUB_CSP_BASE, stubPage, stubUrl } from "./stub.js";

const NONCE = "0123456789abcdef0123456789abcdef";

describe("stub URLs and pages (QW-10)", () => {
  it("names the job and, for a frame that resolves a key, the key index", () => {
    expect(stubUrl("http://localhost:4317", NONCE, 0)).toBe(
      `http://localhost:4317/__wg_quiescent__?job=${NONCE}&key=0`,
    );
    expect(stubUrl("https://example.com", NONCE)).toBe(
      `https://example.com/__wg_quiescent__?job=${NONCE}`,
    );
  });

  it("is inert HTML with no-store and the strict CSP, listing only the job's iframe origins", async () => {
    const frame = stubUrl("http://127.0.0.1:4317", NONCE, 1);
    const page = stubPage([frame]);
    expect(page.headers).toEqual({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `${STUB_CSP_BASE}; frame-src http://127.0.0.1:4317`,
    });
    expect(STUB_CSP_BASE).toBe(
      "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'",
    );
    expect(page.body).toBe(
      `<!doctype html><html><head><meta charset="utf-8"><title>WGLauncher</title></head><body><iframe src="${frame.replace("&", "&amp;")}"></iframe></body></html>`,
    );
    expect(page.body).not.toMatch(/<script/i);
  });

  it("allows no frame at all when the page holds no iframe", () => {
    expect(stubPage([]).headers["Content-Security-Policy"]).toBe(
      `${STUB_CSP_BASE}; frame-src 'none'`,
    );
    expect(stubPage([]).body).toContain("<body></body>");
  });
});

function fakeSession(failOn?: "http" | "https" | "webRequest") {
  const handlers = new Map<string, (request: Request) => Response | Promise<Response>>();
  let listener:
    | ((details: { url: string }, callback: (r: { cancel: boolean }) => void) => void)
    | null = null;
  const session: InterceptorSession = {
    protocol: {
      handle: vi.fn(
        (scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
          if (failOn === scheme) throw new Error("boom");
          if (handlers.has(scheme)) throw new Error(`${scheme} already handled`);
          handlers.set(scheme, handler);
        },
      ),
      unhandle: vi.fn((scheme: string) => void handlers.delete(scheme)),
    },
    webRequest: {
      onBeforeRequest: vi.fn((next) => {
        if (failOn === "webRequest" && next !== null) throw new Error("boom");
        listener = next;
      }),
    },
  };
  return {
    session,
    handlers,
    listener: () => listener,
    async fetch(url: string, init?: RequestInit) {
      const handler = handlers.get(new URL(url).protocol.slice(0, -1));
      if (!handler) throw new Error("no handler");
      return handler(new Request(url, init));
    },
    cancelled(url: string) {
      let result: boolean | undefined;
      listener?.({ url }, (r) => {
        result = r.cancel;
      });
      return result;
    },
  };
}

describe("installInterceptor (QW-1, QW-3)", () => {
  const top = stubUrl("http://localhost:4317", NONCE, 0);
  const frame = stubUrl("https://cdn.example", NONCE, 1);
  const pages = new Map([
    [top, stubPage([frame])],
    [frame, stubPage([])],
  ]);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };

  it("serves the job's exact stub URLs over http and https", async () => {
    const fake = fakeSession();
    installInterceptor(fake.session, pages, log);
    expect([...fake.handlers.keys()].sort()).toEqual(["http", "https"]);
    const response = await fake.fetch(top);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src https://cdn.example",
    );
    expect(await response.text()).toContain("<iframe");
    expect((await fake.fetch(frame)).status).toBe(200);
  });

  it.each([
    ["the game's own page", "http://localhost:4317/"],
    ["its script", "http://localhost:4317/game.js"],
    ["the stub path with another nonce", stubUrl("http://localhost:4317", "f".repeat(32), 0)],
    ["the stub path without the key", stubUrl("http://localhost:4317", NONCE)],
    ["the stub on another origin", stubUrl("http://localhost:4318", NONCE, 0)],
    ["an extra query member", `${top}&x=1`],
    ["a fragment", `${top}#x`],
    ["a third-party host", "https://tracker.example/pixel.gif"],
  ])("answers %s with 403 and an empty body, and never fetches it", async (_name, url) => {
    const fake = fakeSession();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    installInterceptor(fake.session, pages, log);
    const response = await fake.fetch(url);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("answers a stub URL with another method with 403", async () => {
    const fake = fakeSession();
    installInterceptor(fake.session, pages, log);
    expect((await fake.fetch(top, { method: "POST", body: "x" })).status).toBe(403);
  });

  it("cancels every other request at the webRequest layer and lets the stubs through", () => {
    const fake = fakeSession();
    installInterceptor(fake.session, pages, log);
    expect(fake.cancelled(top)).toBe(false);
    expect(fake.cancelled(frame)).toBe(false);
    expect(fake.cancelled("http://localhost:4317/sw.js")).toBe(true);
    expect(fake.cancelled("wss://localhost:4317/socket")).toBe(true);
  });

  it("removes everything it registered, once, and counts what it refused (origins only in the log)", async () => {
    const fake = fakeSession();
    const installed = installInterceptor(fake.session, pages, log);
    await fake.fetch("http://localhost:4317/game.js?token=SECRET");
    fake.cancelled("http://localhost:4317/sw.js?token=SECRET");
    installed.dispose();
    installed.dispose();
    expect(fake.handlers.size).toBe(0);
    expect(fake.listener()).toBeNull();
    expect(fake.session.protocol.unhandle).toHaveBeenCalledTimes(2);
    expect(installed.refused()).toEqual(["http://localhost:4317"]);
  });

  it.each(["http", "https", "webRequest"] as const)(
    "leaves nothing registered when the %s registration throws (QW-3)",
    (failOn) => {
      const fake = fakeSession(failOn);
      expect(() => installInterceptor(fake.session, pages, log)).toThrow("boom");
      expect(fake.handlers.size).toBe(0);
      expect(fake.listener()).toBeNull();
    },
  );
});
