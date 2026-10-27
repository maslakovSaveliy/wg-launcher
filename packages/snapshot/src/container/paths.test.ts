import { describe, expect, it } from "vitest";
import { isDataDirectory, parseDataPath } from "./paths.js";

const SHA = "0123456789abcdef".repeat(4);

describe("path grammar of formatVersion 1 (snapshot-format.md section 3.2)", () => {
  it("parses the four data file kinds", () => {
    expect(parseDataPath("data/0/local-storage.cbor", 1)).toEqual({ kind: "localStorage", key: 0 });
    expect(parseDataPath("data/1/idb/10/schema.cbor", 2)).toEqual({
      kind: "schema",
      key: 1,
      db: 10,
    });
    expect(parseDataPath("data/0/idb/0/store-255.cbor", 1)).toEqual({
      kind: "store",
      key: 0,
      db: 0,
      store: 255,
    });
    expect(parseDataPath(`blobs/${SHA}`, 0)).toEqual({ kind: "blob", sha256: SHA });
  });

  it.each([
    "manifest.json",
    "data/0/extra.bin",
    "data/00/local-storage.cbor",
    "data/01/local-storage.cbor",
    "data/-1/local-storage.cbor",
    "data/0/idb/0/store-01.cbor",
    "data/0/idb/0/store-.cbor",
    "data/0/idb/a/schema.cbor",
    "data/0/idb/0",
    "data/0/local-storage.cbor/x",
    `blobs/${SHA.toUpperCase()}`,
    `blobs/${SHA}0`,
    "blobs/",
    "data/1/local-storage.cbor",
  ])("refuses %s", (path) => {
    expect(parseDataPath(path, 1)).toBeNull();
  });

  it("refuses a storage key index past the manifest's storage keys", () => {
    expect(parseDataPath("data/2/local-storage.cbor", 2)).toBeNull();
    expect(parseDataPath("data/0/local-storage.cbor", 0)).toBeNull();
  });

  it("allows directories only for prefixes of the grammar", () => {
    for (const path of ["data", "data/0", "data/0/idb", "data/0/idb/3", "blobs"]) {
      expect(isDataDirectory(path, 1)).toBe(true);
    }
    for (const path of [
      "data/1",
      "data/0/idb/03",
      "data/0/idb/0/x",
      "other",
      "manifest.json",
      "data/0/local-storage.cbor",
    ]) {
      expect(isDataDirectory(path, 1)).toBe(false);
    }
  });
});
