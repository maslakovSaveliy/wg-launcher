import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { recordFrames, storageKeyOf } from "./frames.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

describe("storageKeyOf", () => {
  it("is the pair of top-level and frame origins for http and https", () => {
    expect(storageKeyOf("https://game.example/play?x=1", "https://cdn.example:8443/a/b")).toEqual({
      topOrigin: "https://game.example",
      frameOrigin: "https://cdn.example:8443",
    });
    expect(storageKeyOf("http://localhost:4317/", "http://localhost:4317/")).toEqual({
      topOrigin: "http://localhost:4317",
      frameOrigin: "http://localhost:4317",
    });
  });

  it.each([
    ["about:blank", "https://game.example/"],
    ["https://game.example/", "about:blank"],
    ["https://game.example/", "about:srcdoc"],
    ["https://game.example/", "data:text/html,x"],
    ["https://game.example/", "blob:https://game.example/0f1e"],
    ["file:///x", "https://game.example/"],
    ["https://game.example/", "not a url"],
    ["", ""],
  ])("records nothing for (%j, %j)", (top, frame) => {
    expect(storageKeyOf(top, frame)).toBeNull();
  });
});

function fakeContents(mainUrl: string) {
  return Object.assign(new EventEmitter(), { mainFrame: { url: mainUrl } });
}

const navigate = (contents: ReturnType<typeof fakeContents>, url: string, isMainFrame: boolean) =>
  contents.emit("did-frame-navigate", {}, url, 200, "OK", isMainFrame, 1, 2);

describe("recordFrames: did-frame-navigate → storage_targets", () => {
  it("marks the main frame and each subframe once per window", () => {
    const repo = { markSeen: vi.fn() };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const contents = fakeContents("https://game.example/");
    recordFrames(contents as never, GAME, repo, log);

    navigate(contents, "https://game.example/", true);
    navigate(contents, "https://ads.example/frame", false);
    navigate(contents, "https://ads.example/other", false);
    navigate(contents, "about:blank", false);
    navigate(contents, "https://game.example/level2", true);

    expect(repo.markSeen.mock.calls).toEqual([
      [{ gameId: GAME, topOrigin: "https://game.example", frameOrigin: "https://game.example" }],
      [{ gameId: GAME, topOrigin: "https://game.example", frameOrigin: "https://ads.example" }],
    ]);
  });

  it("a failing write is logged, never thrown into Electron", () => {
    const repo = {
      markSeen: vi.fn(() => {
        throw new Error("database is locked");
      }),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
    const contents = fakeContents("https://game.example/");
    recordFrames(contents as never, GAME, repo, log);
    expect(() => navigate(contents, "https://game.example/", true)).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      "game.storage-target-failed",
      expect.objectContaining({ gameId: GAME }),
    );
  });
});
