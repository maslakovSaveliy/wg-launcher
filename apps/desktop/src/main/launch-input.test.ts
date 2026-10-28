import { describe, expect, it, vi } from "vitest";
import {
  createLaunchQueue,
  createNoticeChain,
  handleLaunchRequest,
  type LaunchHandlerDeps,
  type LaunchRequest,
  MAX_PENDING_NOTICES,
  MAX_QUEUED_LAUNCH_REQUESTS,
  registerDeepLinkScheme,
} from "./launch-input.js";
import { parseDeepLink, parseLaunchInput } from "./policy/deep-link.js";

const ID = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

describe("createLaunchQueue (early second-instance and open-url, architecture.md section 8)", () => {
  it("keeps requests that arrive before start, then handles them in order, then handles new ones at once", async () => {
    const queue = createLaunchQueue();
    const seen: string[] = [];
    queue.push({ source: "open-url", input: parseDeepLink(`wglauncher://launch/${ID}`) });
    queue.push({ source: "second-instance", input: { kind: "none" } });
    expect(seen).toEqual([]);
    queue.start(async (request) => {
      seen.push(request.source);
    });
    await queue.idle();
    expect(seen).toEqual(["open-url", "second-instance"]);
    queue.push({ source: "argv", input: { kind: "none" } });
    await queue.idle();
    expect(seen).toEqual(["open-url", "second-instance", "argv"]);
  });

  it("handles one request at a time, and a failing one does not stop the next", async () => {
    const queue = createLaunchQueue();
    const order: string[] = [];
    queue.start(async (request) => {
      order.push(`start ${request.source}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${request.source}`);
      if (request.source === "argv") throw new Error("boom");
    });
    queue.push({ source: "argv", input: { kind: "none" } });
    queue.push({ source: "open-url", input: { kind: "none" } });
    await queue.idle();
    expect(order).toEqual(["start argv", "end argv", "start open-url", "end open-url"]);
  });
});

describe("bounds (review fix 2)", () => {
  it("drops requests beyond MAX_QUEUED_LAUNCH_REQUESTS before start and reports them at start", async () => {
    expect(MAX_QUEUED_LAUNCH_REQUESTS).toBe(16);
    const queue = createLaunchQueue();
    for (let i = 0; i < MAX_QUEUED_LAUNCH_REQUESTS + 3; i++) {
      queue.push({ source: i === 0 ? "argv" : "open-url", input: { kind: "none" } });
    }
    const handled: string[] = [];
    const dropped: string[] = [];
    queue.start(
      async (request) => {
        handled.push(request.source);
      },
      (source) => dropped.push(source),
    );
    await queue.idle();
    expect(handled).toHaveLength(MAX_QUEUED_LAUNCH_REQUESTS);
    expect(handled[0]).toBe("argv");
    expect(dropped).toEqual(["open-url", "open-url", "open-url"]);
  });

  it("counts requests waiting behind a slow one, and accepts new ones once they are handled", async () => {
    const queue = createLaunchQueue();
    const gate = Promise.withResolvers<void>();
    const dropped: string[] = [];
    let handled = 0;
    queue.start(
      async () => {
        await gate.promise;
        handled += 1;
      },
      (source) => dropped.push(source),
    );
    for (let i = 0; i < MAX_QUEUED_LAUNCH_REQUESTS + 1; i++) {
      queue.push({ source: "second-instance", input: { kind: "none" } });
    }
    expect(dropped).toEqual(["second-instance"]);
    gate.resolve();
    await queue.idle();
    expect(handled).toBe(MAX_QUEUED_LAUNCH_REQUESTS);
    queue.push({ source: "second-instance", input: { kind: "none" } });
    await queue.idle();
    expect(handled).toBe(MAX_QUEUED_LAUNCH_REQUESTS + 1);
    expect(dropped).toHaveLength(1);
  });
});

describe("createNoticeChain (review fix 2)", () => {
  it("shows notices one at a time in order, and a failing one does not stop the next", async () => {
    const shown: string[] = [];
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const notify = vi.fn(async (spec: { title: string; message: string }) => {
      shown.push(spec.title);
      const gate = gates[shown.length - 1];
      if (gate) await gate.promise;
      if (spec.title === "b") throw new Error("dialog failed");
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const chain = createNoticeChain(notify, log);
    chain.notify({ title: "a", message: "" });
    chain.notify({ title: "b", message: "" });
    chain.notify({ title: "c", message: "" });
    await Promise.resolve();
    expect(shown).toEqual(["a"]);
    gates[0]?.resolve();
    gates[1]?.resolve();
    await chain.idle();
    expect(shown).toEqual(["a", "b", "c"]);
    expect(log.error).toHaveBeenCalledWith("launch.notice-failed", { error: expect.any(Error) });
  });

  it("drops notices beyond MAX_PENDING_NOTICES while the user has not answered, and logs it", async () => {
    expect(MAX_PENDING_NOTICES).toBe(4);
    const gate = Promise.withResolvers<void>();
    const notify = vi.fn(async () => gate.promise);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const chain = createNoticeChain(notify, log);
    for (let i = 0; i < MAX_PENDING_NOTICES + 2; i++) chain.notify({ title: `n${i}`, message: "" });
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith("launch.notice-dropped", { title: "n4" });
    gate.resolve();
    await chain.idle();
    expect(notify).toHaveBeenCalledTimes(MAX_PENDING_NOTICES);
  });
});

function setUp(options: { known?: boolean; readOnly?: boolean } = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  const launch = vi.fn(async () => ({ ok: true as const, data: { window: "opened" as const } }));
  const deps: LaunchHandlerDeps = {
    log,
    focusLauncher: vi.fn(),
    notify: vi.fn(async () => undefined),
    games: options.readOnly
      ? null
      : { has: vi.fn(() => options.known ?? true), launch: launch as never },
  };
  return { deps, log, launch };
}

const request = (source: LaunchRequest["source"], argv: string[]): LaunchRequest => ({
  source,
  input: parseLaunchInput(argv),
});

describe("handleLaunchRequest (AC-19, S-11)", () => {
  it("does not wait for the user to close a notice, so the next request is handled at once (review fix 2)", async () => {
    const { deps } = setUp({ known: false });
    deps.notify = vi.fn(() => new Promise<void>(() => undefined)); // never answered
    const handled = handleLaunchRequest(request("argv", [`--launch-game=${ID}`]), deps);
    await expect(
      Promise.race([
        handled.then(() => "done"),
        new Promise((r) => setTimeout(() => r("blocked"), 50)),
      ]),
    ).resolves.toBe("done");
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it("opens a known game and logs it as valid with the id only", async () => {
    const { deps, log, launch } = setUp();
    await handleLaunchRequest(request("argv", ["electron", ".", `--launch-game=${ID}`]), deps);
    expect(launch).toHaveBeenCalledWith(ID);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.focusLauncher).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("launch.input", {
      source: "argv",
      result: "valid",
      gameId: ID,
    });
  });

  it("shows the library with 'not in the library' for an unknown id, and opens nothing", async () => {
    const { deps, launch } = setUp({ known: false });
    await handleLaunchRequest(request("second-instance", [`--launch-game=${ID}`]), deps);
    expect(launch).not.toHaveBeenCalled();
    expect(deps.focusLauncher).toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith({
      title: "The game is not in the library",
      message: expect.stringContaining("not in the library"),
    });
  });

  it("shows the library with an error for a malformed value, opens nothing and logs only the length", async () => {
    const hostile = "--launch-game=https://evil.example/?token=SECRET-TOKEN";
    const { deps, log, launch } = setUp();
    await handleLaunchRequest(request("second-instance", ["electron", hostile]), deps);
    await handleLaunchRequest(
      { source: "open-url", input: parseDeepLink("wglauncher://launch/SECRET-TOKEN") },
      deps,
    );
    expect(launch).not.toHaveBeenCalled();
    expect(deps.focusLauncher).toHaveBeenCalledTimes(2);
    expect(deps.notify).toHaveBeenCalledWith({
      title: "The launch link is not valid",
      message: expect.any(String),
    });
    expect(log.warn).toHaveBeenCalledWith("launch.input", {
      source: "second-instance",
      result: "invalid",
      length: hostile.length,
    });
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(logged).not.toContain("SECRET-TOKEN");
    expect(logged).not.toContain("evil");
  });

  it("only shows the launcher for a second instance without a launch argument", async () => {
    const { deps, launch } = setUp();
    await handleLaunchRequest(request("second-instance", ["electron", "."]), deps);
    expect(deps.focusLauncher).toHaveBeenCalledTimes(1);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("does nothing for a first start without a launch argument", async () => {
    const { deps } = setUp();
    await handleLaunchRequest(request("argv", ["electron", "."]), deps);
    expect(deps.focusLauncher).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("shows a refused launch (busy, recovery) in the library with the runtime's message", async () => {
    const { deps, launch } = setUp();
    launch.mockResolvedValueOnce({
      ok: false,
      code: "GAME_BUSY",
      message: "The game is busy with a task.",
    } as never);
    await handleLaunchRequest(request("argv", [`--launch-game=${ID}`]), deps);
    expect(deps.focusLauncher).toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith({
      title: "The game cannot be opened",
      message: "The game is busy with a task.",
    });
  });

  it("says so when the game is still closing", async () => {
    const { deps, launch } = setUp();
    launch.mockResolvedValueOnce({ ok: true, data: { window: "closing" } } as never);
    await handleLaunchRequest(request("argv", [`--launch-game=${ID}`]), deps);
    expect(deps.notify).toHaveBeenCalledWith({
      title: "The game is closing",
      message: expect.any(String),
    });
  });

  it("refuses a launch while the library is read-only", async () => {
    const { deps } = setUp({ readOnly: true });
    await handleLaunchRequest(request("argv", [`--launch-game=${ID}`]), deps);
    expect(deps.focusLauncher).toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith({
      title: "The game cannot be opened",
      message: expect.stringContaining("read-only"),
    });
  });
});

describe("registerDeepLinkScheme", () => {
  it("never registers the scheme in dev or test builds, nor in an unpackaged prod build", () => {
    for (const [flavor, packaged] of [
      ["dev", true],
      ["test", true],
      ["dev", false],
      ["test", false],
      ["prod", false],
    ] as const) {
      const set = vi.fn(() => true);
      expect(registerDeepLinkScheme(flavor, packaged, set), `${flavor} ${packaged}`).toBe(false);
      expect(set).not.toHaveBeenCalled();
    }
  });

  it("registers wglauncher in the packaged prod build", () => {
    const set = vi.fn(() => true);
    expect(registerDeepLinkScheme("prod", true, set)).toBe(true);
    expect(set).toHaveBeenCalledWith("wglauncher");
  });
});
