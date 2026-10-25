import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.js";

describe("limits", () => {
  it("pins the production values of snapshot-format.md section 8", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxFileBytes: 2 ** 30,
      maxEntries: 100_000,
      maxEntryBytes: 512 * 2 ** 20,
      maxTotalBytes: 2 * 2 ** 30,
      maxRatio: 200,
      ratioFloorBytes: 64 * 2 ** 20,
      maxManifestBytes: 2 ** 20,
      maxStorageKeys: 32,
      maxDatabasesPerKey: 256,
      maxStoresPerDatabase: 256,
      maxIndexesPerStore: 64,
      maxDepth: 256,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it("overrides single limits by name and keeps the rest", () => {
    expect(resolveLimits({ maxEntries: 10 })).toEqual({ ...DEFAULT_LIMITS, maxEntries: 10 });
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
  });

  it("refuses unknown names and values that are not positive safe integers", () => {
    expect(() => resolveLimits({ maxEntrys: 1 } as never)).toThrow(TypeError);
    expect(() => resolveLimits({ maxEntries: 0 })).toThrow(TypeError);
    expect(() => resolveLimits({ maxRatio: 1.5 })).toThrow(TypeError);
  });
});
