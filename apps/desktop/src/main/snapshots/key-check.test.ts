import { describe, expect, it } from "vitest";
import {
  checkStorageKeys,
  type ManifestKey,
  sameCheckedKeys,
  type TargetKeys,
  targetKeysOf,
} from "./key-check.js";

const L = "http://localhost:4317";
const LOOP = "http://127.0.0.1:4317";
const top = (origin: string): ManifestKey => ({ origin, topLevelSite: null, role: "top" });
const frame = (origin: string, topLevelSite: string | null = null): ManifestKey => ({
  origin,
  topLevelSite,
  role: "frame",
});
const target = (
  topOrigins: string[],
  frames: Array<[topOrigin: string, frameOrigin: string]> = [],
): TargetKeys => ({
  topOrigins,
  frames: frames.map(([topOrigin, frameOrigin]) => ({ topOrigin, frameOrigin })),
});

/** The progress-lab iframe variant: localhost on top, its 127.0.0.1 iframe partitioned under it. */
const IFRAME_SNAPSHOT = [top(L), frame(LOOP, "http://localhost")].sort((a, b) =>
  a.origin < b.origin ? -1 : 1,
);

describe("checkStorageKeys: the key table of save-transfer.md section 2", () => {
  it("accepts a top key whose origin is a top-level origin of the target", () => {
    const checked = checkStorageKeys([top(L)], target([L]));
    expect(checked).toEqual({
      ok: true,
      data: {
        keys: [{ index: 0, from: 0, origin: L, topLevelSite: null, role: "top" }],
        unchecked: [],
        mapped: false,
      },
    });
  });

  it("refuses a top key that is not a top-level origin of the target, naming both", () => {
    const checked = checkStorageKeys([top(L)], target([LOOP]));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.code).toBe("IMP_STORAGE_KEY_MISMATCH");
    expect(checked.mismatches).toEqual([
      { key: { origin: L, topLevelSite: null }, comparedWith: [LOOP] },
    ]);
    expect(checked.message).toContain(L);
    expect(checked.message).toContain(LOOP);
  });

  it("accepts a partitioned frame key observed under a top-level origin of its site", () => {
    const checked = checkStorageKeys(IFRAME_SNAPSHOT, target([L], [[L, LOOP]]));
    expect(checked.ok && checked.data.unchecked).toEqual([]);
  });

  it("refuses a partitioned key whose topLevelSite is no site of the target's top-level origins", () => {
    const checked = checkStorageKeys(
      [top(LOOP), frame(L, "http://example.test")],
      target([LOOP], [[LOOP, L]]),
    );
    expect(!checked.ok && checked.mismatches.map((m) => m.key)).toEqual([
      { origin: L, topLevelSite: "http://example.test" },
    ]);
  });

  it("refuses a frame key when the target observed other frames there (the iframe moved)", () => {
    const moved = "http://127.0.0.1:5555";
    const checked = checkStorageKeys(IFRAME_SNAPSHOT, target([L], [[L, moved]]));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.mismatches).toEqual([
      { key: { origin: LOOP, topLevelSite: "http://localhost" }, comparedWith: [moved] },
    ]);
  });

  it("lists a frame key as unchecked when the target has no frame observations there yet", () => {
    const checked = checkStorageKeys(IFRAME_SNAPSHOT, target([L]));
    expect(checked.ok && checked.data.unchecked).toEqual([
      { origin: LOOP, topLevelSite: "http://localhost" },
    ]);
  });

  it("checks a first-party frame key against the frames observed under its site", () => {
    const cdn = "https://cdn.game.example";
    const www = "https://www.game.example";
    expect(checkStorageKeys([frame(cdn), top(www)], target([www], [[www, cdn]])).ok).toBe(true);
    const unchecked = checkStorageKeys([frame(cdn), top(www)], target([www]));
    expect(unchecked.ok && unchecked.data.unchecked).toEqual([{ origin: cdn, topLevelSite: null }]);
    // A first-party frame of a site the target has no top-level origin of cannot be its storage.
    const noSite = checkStorageKeys([frame("https://cdn.other.test")], target([www]));
    expect(noSite.ok).toBe(false);
  });

  it("maps origin by origin: the top key, and the partitioned key's site follows the mapped top-level origin", () => {
    // Exported on localhost with a 127.0.0.1 iframe; the target runs on 127.0.0.1 with a localhost iframe.
    const checked = checkStorageKeys(IFRAME_SNAPSHOT, target([LOOP], [[LOOP, L]]), [
      { from: L, to: LOOP },
      { from: LOOP, to: L },
    ]);
    expect(checked).toEqual({
      ok: true,
      data: {
        keys: [
          // Sorted again: the mapped top key (127.0.0.1) now comes first.
          { index: 0, from: 1, origin: LOOP, topLevelSite: null, role: "top" },
          { index: 1, from: 0, origin: L, topLevelSite: "http://127.0.0.1", role: "frame" },
        ],
        unchecked: [],
        mapped: true,
      },
    });
  });

  it("refuses an unmapped partitioned key under changed keys, naming both keys", () => {
    const checked = checkStorageKeys(IFRAME_SNAPSHOT, target([LOOP], [[LOOP, L]]));
    expect(!checked.ok && checked.mismatches).toEqual([
      { key: { origin: LOOP, topLevelSite: "http://localhost" }, comparedWith: [LOOP] },
      { key: { origin: L, topLevelSite: null }, comparedWith: [LOOP] },
    ]);
  });

  it("keeps an unmatched frame key deliberately when its origin is mapped to itself", () => {
    const moved = "http://127.0.0.1:5555";
    const checked = checkStorageKeys(IFRAME_SNAPSHOT, target([L], [[L, moved]]), [
      { from: LOOP, to: LOOP },
    ]);
    expect(checked.ok && checked.data).toMatchObject({ unchecked: [], mapped: true });
    // A self-mapping does not excuse a top key.
    const topSelf = checkStorageKeys([top(L)], target([LOOP]), [{ from: L, to: L }]);
    expect(topSelf.ok).toBe(false);
  });

  it("maps a moved iframe to the origin the target observed", () => {
    const moved = "http://127.0.0.1:5555";
    const checked = checkStorageKeys(IFRAME_SNAPSHOT, target([L], [[L, moved]]), [
      { from: LOOP, to: moved },
    ]);
    expect(checked.ok && checked.data.keys.map((k) => [k.origin, k.topLevelSite, k.from])).toEqual([
      [moved, "http://localhost", 0],
      [L, null, 1],
    ]);
  });

  it("refuses a mapping that is not origin to origin, names an origin the snapshot lacks, or repeats one", () => {
    const bad = [
      [{ from: `${L}/`, to: LOOP }],
      [{ from: L, to: "ftp://x.test" }],
      [{ from: "https://absent.test", to: LOOP }],
      [
        { from: L, to: LOOP },
        { from: L, to: "http://127.0.0.2:4317" },
      ],
    ];
    for (const mapping of bad) {
      const checked = checkStorageKeys([top(L)], target([LOOP]), mapping);
      expect(!checked.ok && checked.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("refuses two snapshot keys that a mapping puts on one storage key", () => {
    const checked = checkStorageKeys([top(LOOP), top(L)], target([LOOP]), [{ from: L, to: LOOP }]);
    expect(!checked.ok && checked.code).toBe("IMP_STORAGE_KEY_MISMATCH");
  });
});

describe("targetKeysOf and sameCheckedKeys", () => {
  it("takes the entry origin, the observed top-level origins and the observed frames", () => {
    const rows = [
      { topOrigin: L, frameOrigin: L },
      { topOrigin: L, frameOrigin: LOOP },
    ];
    expect(targetKeysOf(`${L}/iframe-host.html?src=x`, rows)).toEqual({
      topOrigins: [L],
      frames: [{ topOrigin: L, frameOrigin: LOOP }],
    });
  });

  it("compares two check results key by key and the unchecked list (R3 runs R2 again)", () => {
    const a = checkStorageKeys(IFRAME_SNAPSHOT, target([L]));
    const b = checkStorageKeys(IFRAME_SNAPSHOT, target([L], [[L, LOOP]]));
    if (!a.ok || !b.ok) throw new Error("unexpected");
    expect(sameCheckedKeys(a.data, a.data)).toBe(true);
    expect(sameCheckedKeys(a.data, b.data)).toBe(false);
  });
});
