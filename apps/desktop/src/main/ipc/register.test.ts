import type { IpcChannel } from "@wg-launcher/shared";
import { IPC_CHANNELS } from "@wg-launcher/shared";
import { describe, expect, it, vi } from "vitest";
import { type Handlers, type IpcMainLike, registerIpc } from "./register.js";
import { checkSender, type IpcEventLike, type LauncherContents } from "./sender-check.js";

const ID = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const ORIGIN = "app://launcher";

function frame(url = "app://launcher/", ids: { processId?: number; routingId?: number } = {}) {
  return { url, parent: null, processId: ids.processId ?? 4, routingId: ids.routingId ?? 1 };
}

function setUp() {
  const mainFrame = frame();
  const launcher: LauncherContents = { mainFrame };
  const listeners = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (channel, listener) => void listeners.set(channel, listener) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const ok = <T>(data: T) => ({ ok: true as const, data });
  const handlers = {
    "library:list": vi.fn(async () => ok({ library: "ready" as const, cards: [] })),
    "library:add": vi.fn(),
    "library:update": vi.fn(),
    "library:remove": vi.fn(async () => ok({})),
    "library:orphans": vi.fn(async () => ok({ orphans: [] })),
    "game:launch": vi.fn(),
    "game:focus": vi.fn(async () => ok({})),
    "settings:get": vi.fn(async () => ok({})),
    "settings:set": vi.fn(async () => ok({})),
  } as unknown as Handlers & Record<IpcChannel, ReturnType<typeof vi.fn>>;
  registerIpc({ ipc, launcher: () => launcher, handlers, log, origin: ORIGIN });
  const call = (channel: IpcChannel, event: Partial<IpcEventLike>, ...args: unknown[]) => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    return listener({ sender: launcher, senderFrame: mainFrame, ...event }, ...args);
  };
  return { launcher, mainFrame, listeners, handlers, log, call };
}

const REFUSED = { ok: false, code: "INVALID_ARGUMENT", message: "Refused." };
const INVALID = { ok: false, code: "INVALID_ARGUMENT", message: "The request is not valid." };

describe("checkSender (architecture.md section 6, S-10)", () => {
  const mainFrame = frame();
  const launcher: LauncherContents = { mainFrame };

  it("accepts the launcher's main frame at app://launcher", () => {
    expect(checkSender({ sender: launcher, senderFrame: mainFrame }, launcher, ORIGIN)).toBe(true);
    // The frame object may be another wrapper of the same frame: identity is the process and routing id.
    expect(checkSender({ sender: launcher, senderFrame: frame() }, launcher, ORIGIN)).toBe(true);
  });

  it.each([
    ["another webContents", { sender: { mainFrame }, senderFrame: mainFrame }],
    ["no sender frame", { sender: launcher, senderFrame: null }],
    ["a subframe", { sender: launcher, senderFrame: { ...frame(), parent: mainFrame } }],
    [
      "another frame of the page",
      { sender: launcher, senderFrame: frame(undefined, { routingId: 2 }) },
    ],
    ["another process", { sender: launcher, senderFrame: frame(undefined, { processId: 9 }) }],
    ["a game origin", { sender: launcher, senderFrame: frame("https://game.example/") }],
    ["another app host", { sender: launcher, senderFrame: frame("app://other/") }],
    ["file:", { sender: launcher, senderFrame: frame("file:///index.html") }],
    ["about:blank", { sender: launcher, senderFrame: frame("about:blank") }],
    ["user info", { sender: launcher, senderFrame: frame("app://x@launcher/") }],
    ["an unparsable URL", { sender: launcher, senderFrame: frame("not a url") }],
  ])("refuses %s", (_name, event) => {
    expect(checkSender(event as IpcEventLike, launcher, ORIGIN)).toBe(false);
  });

  it("checks the dev server origin in the dev flavor", () => {
    const dev = frame("http://localhost:5173/");
    const devLauncher: LauncherContents = { mainFrame: dev };
    const event = { sender: devLauncher, senderFrame: dev };
    expect(checkSender(event, devLauncher, "http://localhost:5173")).toBe(true);
    expect(checkSender(event, devLauncher, ORIGIN)).toBe(false);
  });
});

describe("registerIpc (S-10)", () => {
  it("registers exactly the channels of the contract", () => {
    const { listeners } = setUp();
    expect([...listeners.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it("passes a valid request from the launcher to its handler", async () => {
    const { call, handlers } = setUp();
    expect(await call("game:focus", {}, { gameId: ID })).toEqual({ ok: true, data: {} });
    expect(handlers["game:focus"]).toHaveBeenCalledWith({ gameId: ID });
  });

  it.each([
    ["a wrong sender", { sender: {} }],
    ["a subframe", { senderFrame: { ...frame(), parent: frame() } }],
    ["a wrong origin", { senderFrame: frame("https://evil.example/") }],
  ])(
    "rejects %s without detail, never calls the handler and logs IPC_FORBIDDEN_SENDER once",
    async (_name, event) => {
      const { call, handlers, log } = setUp();
      expect(await call("library:remove", event as Partial<IpcEventLike>, { gameId: ID })).toEqual(
        REFUSED,
      );
      expect(handlers["library:remove"]).not.toHaveBeenCalled();
      const forbidden = log.warn.mock.calls.filter(([name]) => name === "IPC_FORBIDDEN_SENDER");
      expect(forbidden).toEqual([
        ["IPC_FORBIDDEN_SENDER", expect.objectContaining({ channel: "library:remove" })],
      ]);
    },
  );

  it("rejects every call when the launcher window is gone", async () => {
    const listeners = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const handlers = { "settings:get": vi.fn() } as unknown as Handlers;
    registerIpc({
      ipc: { handle: (channel, listener) => void listeners.set(channel, listener) },
      launcher: () => null,
      handlers,
      log,
      origin: ORIGIN,
    });
    const mainFrame = frame();
    const result = await listeners.get("settings:get")?.(
      { sender: {}, senderFrame: mainFrame },
      {},
    );
    expect(result).toEqual(REFUSED);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown key", [{ gameId: ID, extra: true }]],
    ["an upper-case id", [{ gameId: ID.toUpperCase() }]],
    ["a UUIDv4", [{ gameId: "0190a5b2-7c3d-4e4f-8a1b-2c3d4e5f6a7b" }]],
    ["no payload", []],
    ["two payloads", [{ gameId: ID }, { gameId: ID }]],
    ["a payload without JSON form", [{ gameId: ID, n: 1n }]],
  ])("rejects %s as INVALID_ARGUMENT without calling the handler", async (_name, args) => {
    const { call, handlers, log } = setUp();
    expect(await call("game:focus", {}, ...args)).toEqual(INVALID);
    expect(handlers["game:focus"]).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.some(([name]) => name === "IPC_FORBIDDEN_SENDER")).toBe(false);
  });

  it.each([
    [
      "library:list",
      "a 100 000-entry Map",
      () => new Map(Array.from({ length: 100_000 }, (_, i) => [i, i])),
    ],
    ["settings:set", "a 10 MB ArrayBuffer", () => new ArrayBuffer(10_000_000)],
    ["library:orphans", "a Set", () => new Set([1, 2, 3])],
    ["settings:get", "a Date", () => new Date(0)],
    ["library:list", "a typed array", () => new Uint8Array(1_000_000)],
    ["library:list", "a class instance", () => new (class Probe {})()],
    ["game:focus", "a Map inside the payload", () => ({ gameId: ID, extra: new Map([[1, 1]]) })],
    ["library:list", "an array (no request has one)", () => [1, 2, 3]],
    ["library:list", "a sparse array of length 2^32 - 1", () => ({ list: new Array(2 ** 32 - 1) })],
  ] as const)(
    "%s: rejects %s, which JSON would measure as {} (structured clone keeps it)",
    async (channel, _name, make) => {
      const { call, handlers, log } = setUp();
      const payload = make();
      expect(await call(channel, {}, payload)).toEqual(INVALID);
      expect(handlers[channel]).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "ipc.invalid-payload",
        expect.objectContaining({ channel }),
      );
    },
  );

  it("rejects nesting deeper than the bound and a cyclic payload without throwing", async () => {
    const { call, handlers } = setUp();
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) deep = { a: deep };
    expect(await call("library:list", {}, deep)).toEqual(INVALID);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await call("library:list", {}, cyclic)).toEqual(INVALID);
    expect(handlers["library:list"]).not.toHaveBeenCalled();
  });

  it("refuses a shared-reference graph that would take millions of visits, quickly", async () => {
    const { call, handlers } = setUp();
    // 7 levels below the top, each with 10 keys pointing at the same next object: tiny to send (structured clone
    // keeps shared references) but 10^7 visits for a walk without a node budget.
    let node: Record<string, unknown> = {};
    for (let level = 0; level < 7; level++) {
      const next: Record<string, unknown> = {};
      for (let key = 0; key < 10; key++) next[`k${key}`] = node;
      node = next;
    }
    const started = performance.now();
    expect(await call("library:list", {}, node)).toEqual(INVALID);
    expect(performance.now() - started).toBeLessThan(200);
    expect(handlers["library:list"]).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a throwing getter",
      () =>
        Object.defineProperty({}, "boom", {
          enumerable: true,
          get() {
            throw new Error("getter");
          },
        }),
    ],
    [
      "a revoked Proxy",
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
  ])("refuses %s as INVALID_ARGUMENT instead of throwing", async (_name, make) => {
    const { call, handlers } = setUp();
    await expect(call("library:list", {}, make())).resolves.toEqual(INVALID);
    expect(handlers["library:list"]).not.toHaveBeenCalled();
  });

  it("accepts plain objects, including one without a prototype", async () => {
    const { call, handlers } = setUp();
    expect((await call("library:list", {}, Object.create(null))) as { ok: boolean }).toMatchObject({
      ok: true,
    });
    expect(handlers["library:list"]).toHaveBeenCalledTimes(1);
  });

  it("rejects a payload above 64 KiB serialized, and accepts one just at the limit", async () => {
    const { call, handlers } = setUp();
    // `{"url":"` + text + `"}` is 10 bytes of JSON around the text.
    const atLimit = { url: "a".repeat(65_536 - 10) };
    const over = { url: "a".repeat(65_536 - 9) };
    expect(JSON.stringify(atLimit).length).toBe(65_536);
    (handlers["library:add"] as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: {} });
    expect(await call("library:add", {}, over)).toEqual(INVALID);
    expect(handlers["library:add"]).not.toHaveBeenCalled();
    await call("library:add", {}, atLimit);
    expect(handlers["library:add"]).toHaveBeenCalledTimes(1);
  });

  it("measures the limit in UTF-8 bytes, not characters", async () => {
    const { call, handlers } = setUp();
    // 30 000 three-byte characters: under 64 Ki characters, over 64 KiB.
    expect(await call("library:add", {}, { url: "€".repeat(30_000) })).toEqual(INVALID);
    expect(handlers["library:add"]).not.toHaveBeenCalled();
  });

  it("turns a throwing handler into INTERNAL with a short message and logs it", async () => {
    const { call, handlers, log } = setUp();
    (handlers["settings:get"] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    expect(await call("settings:get", {}, {})).toEqual({
      ok: false,
      code: "INTERNAL",
      message: "Something went wrong.",
    });
    expect(log.error).toHaveBeenCalledWith(
      "ipc.handler-failed",
      expect.objectContaining({ channel: "settings:get" }),
    );
  });

  it("hands the handler the parsed request (titles trimmed)", async () => {
    const { call, handlers } = setUp();
    (handlers["library:update"] as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {},
    });
    await call("library:update", {}, { gameId: ID, title: "  Lab  " });
    expect(handlers["library:update"]).toHaveBeenCalledWith({ gameId: ID, title: "Lab" });
  });
});
