import { createHash } from "node:crypto";
import { resolveLimits, SnapError } from "@wg-launcher/snapshot/container";
import { describe, expect, it } from "vitest";
import { ChunkOrderError, type EntryChunk, EntryCollector } from "./collector.js";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const whole = (path: string, data: number[]): EntryChunk => ({
  path,
  offset: 0,
  size: data.length,
  bytes: bytes(...data),
});

const codeOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    if (error instanceof SnapError) return error.code;
    if (error instanceof ChunkOrderError) return "order";
    throw error;
  }
  return null;
};

describe("EntryCollector", () => {
  it("assembles chunks into whole files and counts the bytes received", () => {
    const collector = new EntryCollector(resolveLimits());
    const frame = collector.forKey(1);
    frame.add({ path: "data/1/local-storage.cbor", offset: 0, size: 5, bytes: bytes(1, 2, 3) });
    expect(collector.files()).toEqual([]);
    frame.add({ path: "data/1/local-storage.cbor", offset: 3, size: 5, bytes: bytes(4, 5) });
    frame.add(whole("data/1/idb/0/schema.cbor", []));
    frame.finish();
    expect(collector.files()).toEqual([
      { path: "data/1/local-storage.cbor", bytes: new Uint8Array([1, 2, 3, 4, 5]) },
      { path: "data/1/idb/0/schema.cbor", bytes: new Uint8Array([]) },
    ]);
    expect(collector.received).toBe(5);
  });

  it("keeps a blob two frames send once, and refuses a blob not named by its SHA-256", () => {
    const collector = new EntryCollector(resolveLimits());
    const blob = new Uint8Array([7, 7, 7]);
    const path = `blobs/${sha(blob)}`;
    collector.forKey(0).add(whole(path, [7, 7, 7]));
    collector.forKey(1).add(whole(path, [7, 7, 7]));
    expect(collector.files()).toEqual([{ path, bytes: blob }]);
    expect(codeOf(() => collector.forKey(0).add(whole(`blobs/${"0".repeat(64)}`, [1])))).toBe(
      "SNAP_RECORD_INVALID",
    );
  });

  it.each([
    ["another key's file", whole("data/0/local-storage.cbor", [1])],
    ["a path outside the grammar", whole("manifest.json", [1])],
    ["a traversal", whole("data/1/../0/local-storage.cbor", [1])],
    [
      "an entry that does not start at 0",
      { ...whole("data/1/local-storage.cbor", [1]), offset: 1, size: 2 },
    ],
  ])("refuses %s from a frame as a protocol error", (_name, chunk) => {
    const collector = new EntryCollector(resolveLimits());
    expect(codeOf(() => collector.forKey(1).add(chunk))).toBe("order");
    expect(collector.files()).toEqual([]);
  });

  it("refuses chunks out of order, of another entry, or an export that ends inside an entry", () => {
    const start = { path: "data/0/local-storage.cbor", offset: 0, size: 4, bytes: bytes(1, 2) };
    const make = () => {
      const frame = new EntryCollector(resolveLimits()).forKey(0);
      frame.add(start);
      return frame;
    };
    expect(codeOf(() => make().add({ ...start, offset: 3, bytes: bytes(4) }))).toBe("order");
    expect(codeOf(() => make().add(whole("data/0/idb/0/schema.cbor", [1])))).toBe("order");
    expect(codeOf(() => make().add({ ...start, size: 5, offset: 2 }))).toBe("order");
    expect(codeOf(() => make().finish())).toBe("order");
  });

  it("refuses the same data path twice", () => {
    const collector = new EntryCollector(resolveLimits());
    collector.forKey(0).add(whole("data/0/local-storage.cbor", [1]));
    expect(codeOf(() => collector.forKey(0).add(whole("data/0/local-storage.cbor", [1])))).toBe(
      "SNAP_DUPLICATE_PATH",
    );
  });

  it("applies maxEntryBytes to the declared size before keeping a byte", () => {
    const collector = new EntryCollector(resolveLimits({ maxEntryBytes: 4 }));
    const huge = { path: "data/0/local-storage.cbor", offset: 0, size: 2 ** 40, bytes: bytes(1) };
    expect(codeOf(() => collector.forKey(0).add(huge))).toBe("SNAP_ENTRY_TOO_LARGE");
    expect(collector.received).toBe(0);
    expect(
      codeOf(() => collector.forKey(0).add(whole("data/0/local-storage.cbor", [1, 2, 3, 4]))),
    ).toBe(null);
  });

  it("applies maxTotalBytes and maxEntries as entries complete", () => {
    const total = new EntryCollector(resolveLimits({ maxTotalBytes: 5 }));
    total.forKey(0).add(whole("data/0/local-storage.cbor", [1, 2, 3]));
    expect(codeOf(() => total.forKey(0).add(whole("data/0/idb/0/schema.cbor", [1, 2, 3])))).toBe(
      "SNAP_TOTAL_TOO_LARGE",
    );
    // manifest.json is an entry as well: 2 entries leave room for one data file.
    const entries = new EntryCollector(resolveLimits({ maxEntries: 2 }));
    entries.forKey(0).add(whole("data/0/local-storage.cbor", [1]));
    expect(codeOf(() => entries.forKey(0).add(whole("data/0/idb/0/schema.cbor", [1])))).toBe(
      "SNAP_TOO_MANY_ENTRIES",
    );
  });
});
