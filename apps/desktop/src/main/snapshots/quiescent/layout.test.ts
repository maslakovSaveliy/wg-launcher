import { describe, expect, it } from "vitest";
import { type JobKey, layOutNavigations } from "./layout.js";
import { stubUrl } from "./stub.js";

const N = "0123456789abcdef0123456789abcdef";
const key = (index: number, origin: string, topLevelSite: string | null, role: JobKey["role"]) => ({
  index,
  origin,
  topLevelSite,
  role,
});

describe("layOutNavigations (save-transfer.md section 5, step 7)", () => {
  it("resolves a top key in the top frame and its site's partitioned and first-party frame keys as iframes", () => {
    const keys = [
      key(0, "https://cdn.other.example", "https://game.example", "frame"),
      key(1, "https://www.game.example", null, "top"),
      key(2, "https://assets.game.example", null, "frame"),
    ];
    const layout = layOutNavigations(keys, N);
    expect(layout.navigations).toEqual([
      {
        topUrl: stubUrl("https://www.game.example", N, 1),
        frames: [
          { url: stubUrl("https://www.game.example", N, 1), key: keys[1], inIframe: false },
          { url: stubUrl("https://cdn.other.example", N, 0), key: keys[0], inIframe: true },
          { url: stubUrl("https://assets.game.example", N, 2), key: keys[2], inIframe: true },
        ],
      },
    ]);
    expect(layout.subframes).toBe(true);
    // Every stub URL of the job has its page: the top one with both iframes, the iframes empty.
    expect([...layout.pages.keys()].sort()).toEqual(
      [
        stubUrl("https://www.game.example", N, 1),
        stubUrl("https://cdn.other.example", N, 0),
        stubUrl("https://assets.game.example", N, 2),
      ].sort(),
    );
    expect(layout.pages.get(stubUrl("https://www.game.example", N, 1))?.body).toContain(
      stubUrl("https://cdn.other.example", N, 0).replace("&", "&amp;"),
    );
  });

  it("groups progress-lab's cross-site iframe under its localhost top page", () => {
    const keys = [
      key(0, "http://127.0.0.1:4317", "http://localhost", "frame"),
      key(1, "http://localhost:4317", null, "top"),
    ];
    expect(
      layOutNavigations(keys, N).navigations.map((n) => n.frames.map((f) => f.key.index)),
    ).toEqual([[1, 0]]);
  });

  it("gives each top key its own navigation and needs no subframe preload without iframes", () => {
    const keys = [
      key(0, "http://a.example", null, "top"),
      key(1, "https://b.example", null, "top"),
    ];
    const layout = layOutNavigations(keys, N);
    expect(layout.navigations.map((n) => n.topUrl)).toEqual([
      stubUrl("http://a.example", N, 0),
      stubUrl("https://b.example", N, 1),
    ]);
    expect(layout.subframes).toBe(false);
  });

  it("navigates to a leftover partitioned key's top-level site, whose own storage is not part of the job", () => {
    const keys = [
      key(0, "https://cdn.example", "https://game.example", "frame"),
      key(1, "https://ads.example", "https://game.example", "frame"),
    ];
    const layout = layOutNavigations(keys, N);
    expect(layout.navigations).toEqual([
      {
        topUrl: stubUrl("https://game.example", N),
        frames: [
          { url: stubUrl("https://cdn.example", N, 0), key: keys[0], inIframe: true },
          { url: stubUrl("https://ads.example", N, 1), key: keys[1], inIframe: true },
        ],
      },
    ]);
  });

  it("resolves a leftover first-party frame key in the top frame of its own origin", () => {
    const keys = [key(0, "https://sub.game.example", null, "frame")];
    expect(layOutNavigations(keys, N).navigations).toEqual([
      {
        topUrl: stubUrl("https://sub.game.example", N, 0),
        frames: [{ url: stubUrl("https://sub.game.example", N, 0), key: keys[0], inIframe: false }],
      },
    ]);
  });
});
