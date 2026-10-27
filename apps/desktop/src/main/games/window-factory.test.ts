import { describe, expect, it, vi } from "vitest";

// Electron is not available under Vitest; the window itself is created in the e2e suite.
vi.mock("electron", () => ({ BrowserWindow: class {} }));

const { createExternalOpener, gamePartition, gameWebPreferences } = await import(
  "./window-factory.js"
);

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

describe("gameWebPreferences (S-1, AC-3, architecture.md section 5)", () => {
  it("returns exactly the values of the window factory, nothing more", () => {
    // toStrictEqual: an extra key (preload, enableBlinkFeatures, session, ...) fails the test.
    expect(gameWebPreferences(GAME)).toStrictEqual({
      partition: `persist:game:${GAME}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    });
  });

  it("has no preload and no Blink features", () => {
    const preferences = gameWebPreferences(GAME);
    expect("preload" in preferences).toBe(false);
    expect("enableBlinkFeatures" in preferences).toBe(false);
  });

  it("gives every game its own persistent partition", () => {
    expect(gamePartition(GAME)).toBe(`persist:game:${GAME}`);
    expect(gamePartition("0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c")).not.toBe(gamePartition(GAME));
  });

  it.each(["", "launcher", "0190A5B2-7C3D-7E4F-8A1B-2C3D4E5F6A7B", `${GAME}/x`, "../launcher"])(
    "refuses the id %j",
    (id) => {
      expect(() => gameWebPreferences(id)).toThrow(TypeError);
      expect(() => gamePartition(id)).toThrow(TypeError);
    },
  );
});

describe("createExternalOpener (S-5, AGENTS.md security invariant 5)", () => {
  function setUp(answers: boolean[]) {
    const confirm = vi.fn(async (_spec: object) => answers.shift() ?? false);
    const openExternal = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const open = createExternalOpener({ dialogs: { confirm }, openExternal, log, gameId: GAME });
    return { confirm, openExternal, log, open };
  }

  it("asks with the punycode host and opens the parsed href only after a yes", async () => {
    const { confirm, openExternal, open } = setUp([true]);
    await open("https://bücher.example/path?q=1");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ title: "Open in browser?" });
    expect(JSON.stringify(confirm.mock.calls[0]?.[0])).toContain("xn--bcher-kva.example");
    expect(JSON.stringify(confirm.mock.calls[0]?.[0])).not.toContain("bücher");
    expect(openExternal).toHaveBeenCalledWith("https://xn--bcher-kva.example/path?q=1");
  });

  it("does not open after a no", async () => {
    const { openExternal, open } = setUp([false]);
    await open("https://example.org/");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "wglauncher://launch/x",
    "app://launcher/",
    // secretlint-disable-next-line
    "https://user:pass@example.org/",
    " https://example.org/",
    `https://example.org/${"a".repeat(2048)}`,
  ])("never asks for, and never opens, %j", async (url) => {
    const { confirm, openExternal, open, log } = setUp([true]);
    await open(url);
    expect(confirm).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("game.external-refused", expect.anything());
  });

  it("keeps one confirmation per window at a time and drops the others", async () => {
    let answer: (value: boolean) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const openExternal = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const open = createExternalOpener({ dialogs: { confirm }, openExternal, log, gameId: GAME });
    const first = open("https://one.example/");
    await open("https://two.example/");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("game.external-dropped", expect.anything());
    answer(true);
    await first;
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://one.example/");
  });

  it("after a Cancel the window is not asked again for 10 s; requests then are dropped and logged (R26)", async () => {
    let now = 1_000;
    const answers = [false, true, true, true];
    const confirm = vi.fn(async (_spec: object) => answers.shift() ?? false);
    const openExternal = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const open = createExternalOpener({
      dialogs: { confirm },
      openExternal,
      log,
      gameId: GAME,
      now: () => now,
    });
    await open("https://one.example/");
    expect(confirm).toHaveBeenCalledTimes(1);
    now += 9_999;
    await open("https://two.example/");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("game.external-cooldown", {
      gameId: GAME,
      origin: "https://two.example",
    });
    now += 1;
    await open("https://three.example/");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenLastCalledWith("https://three.example/");
    // A yes starts no cooldown.
    await open("https://four.example/");
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("a failing dialog opens nothing", async () => {
    const confirm = vi.fn(async () => {
      throw new Error("no dialog");
    });
    const openExternal = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const open = createExternalOpener({ dialogs: { confirm }, openExternal, log, gameId: GAME });
    await open("https://example.org/");
    expect(openExternal).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});
