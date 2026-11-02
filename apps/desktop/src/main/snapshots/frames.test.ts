import { describe, expect, it } from "vitest";
import type { StorageTarget } from "../db/repos/storage-targets.js";
import { frameChoices, frameSummary } from "./frames.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const row = (topOrigin: string, frameOrigin: string, inExport = false): StorageTarget => ({
  gameId: GAME,
  topOrigin,
  frameOrigin,
  inExport,
  firstSeenAt: 1,
  lastSeenAt: 1,
});

describe("the frames the export dialog offers (save-transfer.md section 6, Export)", () => {
  const targets = [
    row("http://localhost:4317", "http://localhost:4317"),
    row("http://localhost:4317", "http://127.0.0.1:4317", true),
    row("http://localhost:4317", "https://ads.example"),
  ];

  it("offers every frame key outside the top-level keys, with the remembered choice", () => {
    expect(frameChoices("http://localhost:4317/", targets, null)).toEqual([
      {
        key: { origin: "http://127.0.0.1:4317", topLevelSite: "http://localhost" },
        inExport: true,
      },
      { key: { origin: "https://ads.example", topLevelSite: "http://localhost" }, inExport: false },
    ]);
  });

  it("leaves out a frame key the game's adapter declares, since every export covers it anyway", () => {
    const declared = { origin: "https://ads.example", topLevelSite: "http://localhost" };
    expect(
      frameChoices("http://localhost:4317/", targets, { storage: { frameKeys: [declared] } }),
    ).toEqual([
      {
        key: { origin: "http://127.0.0.1:4317", topLevelSite: "http://localhost" },
        inExport: true,
      },
    ]);
  });

  it("offers nothing for a game that never showed a frame", () => {
    expect(frameChoices("http://localhost:4317/", [targets[0] as StorageTarget], null)).toEqual([]);
  });
});

describe("what the dialog shows of a frame: counts and usage numbers only", () => {
  const choice = {
    key: { origin: "http://127.0.0.1:4317", topLevelSite: "http://localhost" },
    inExport: false,
  };

  it("counts the localStorage items and databases and takes Chromium's IndexedDB usage", () => {
    expect(
      frameSummary(choice, {
        localStorageItems: 3,
        databases: [
          { name: "a", version: 1 },
          { name: "b", version: 2 },
        ],
        usageDetails: { indexedDB: 8192, caches: 100 },
      }),
    ).toEqual({
      origin: "http://127.0.0.1:4317",
      topLevelSite: "http://localhost",
      inExport: false,
      localStorageItems: 3,
      databases: 2,
      indexedDbBytes: 8192,
    });
  });

  it("says nothing about IndexedDB usage where Chromium does not report it", () => {
    expect(
      frameSummary(choice, { localStorageItems: 0, databases: [], usageDetails: null })
        .indexedDbBytes,
    ).toBeNull();
    expect(
      frameSummary(choice, { localStorageItems: 0, databases: [], usageDetails: {} })
        .indexedDbBytes,
    ).toBeNull();
  });
});
