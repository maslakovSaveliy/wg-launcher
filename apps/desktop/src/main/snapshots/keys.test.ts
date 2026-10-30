import { describe, expect, it } from "vitest";
import type { StorageTarget } from "../db/repos/storage-targets.js";
import { frameKeyCandidates, knownKeys, numberKeys, topOrigins } from "./keys.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const row = (topOrigin: string, frameOrigin: string, inExport = false): StorageTarget => ({
  gameId: GAME,
  topOrigin,
  frameOrigin,
  inExport,
  firstSeenAt: 1,
  lastSeenAt: 1,
});

describe("a game's storage keys (save-transfer.md section 2)", () => {
  const targets = [
    row("http://localhost:4317", "http://localhost:4317"),
    row("http://localhost:4317", "http://127.0.0.1:4317"),
    row("https://www.game.example", "https://cdn.game.example"),
    row("https://www.game.example", "https://ads.example"),
    row("https://game.example", "https://ads.example"),
    // A same-site frame at a top-level origin: that origin's own storage, not another key.
    row("https://game.example", "https://www.game.example"),
  ];

  it("takes the entry URL's origin and every observed top-level origin as top keys", () => {
    expect(topOrigins("https://www.game.example/play?x=1", targets)).toEqual([
      "http://localhost:4317",
      "https://game.example",
      "https://www.game.example",
    ]);
  });

  it("makes same-site frames first-party keys and cross-site frames partitioned keys, each once", () => {
    expect(frameKeyCandidates("http://localhost:4317/", targets)).toEqual([
      {
        key: { origin: "http://127.0.0.1:4317", topLevelSite: "http://localhost" },
        rows: [targets[1]],
      },
      {
        key: { origin: "https://ads.example", topLevelSite: "https://game.example" },
        rows: [targets[3], targets[4]],
      },
      { key: { origin: "https://cdn.game.example", topLevelSite: null }, rows: [targets[2]] },
    ]);
  });

  it("numbers keys by origin, then topLevelSite with null first, as the manifest sorts them", () => {
    const keys = numberKeys(
      ["https://b.example"],
      [
        { origin: "https://a.example", topLevelSite: "https://c.example" },
        { origin: "https://a.example", topLevelSite: null },
      ],
    );
    expect(keys).toEqual([
      { index: 0, origin: "https://a.example", topLevelSite: null, role: "frame" },
      { index: 1, origin: "https://a.example", topLevelSite: "https://c.example", role: "frame" },
      { index: 2, origin: "https://b.example", topLevelSite: null, role: "top" },
    ]);
  });

  it("lists every known key of progress-lab in its iframe host", () => {
    expect(knownKeys("http://localhost:4317/iframe-host.html?src=x", targets.slice(0, 2))).toEqual([
      {
        index: 0,
        origin: "http://127.0.0.1:4317",
        topLevelSite: "http://localhost",
        role: "frame",
      },
      { index: 1, origin: "http://localhost:4317", topLevelSite: null, role: "top" },
    ]);
  });
});
