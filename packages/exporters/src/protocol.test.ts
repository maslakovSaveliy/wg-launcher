import { describe, expect, it } from "vitest";
import { FrameCommand, FrameReply, isRequestNonce, MAX_ENTRY_CHUNK_BYTES } from "./protocol.js";

const nonce = "0123456789abcdef0123456789abcdef";
const ALL = { localStorage: "all", indexedDB: "all" };
const storageKey = { origin: "http://localhost:4317", topLevelSite: null };

describe("frame commands (save-transfer.md section 5, step 10)", () => {
  it.each([
    { type: "inventory", nonce },
    { type: "export", nonce, keyIndex: 0, storageKey, scope: ALL },
    {
      type: "import",
      nonce,
      keyIndex: 31,
      storageKey: { origin: "https://a.example", topLevelSite: "https://b.example" },
      scope: { localStorage: { include: ["p:"], exclude: [] }, indexedDB: "all" },
    },
    {
      type: "entry",
      nonce,
      path: "data/0/local-storage.cbor",
      offset: 0,
      size: 3,
      bytes: new ArrayBuffer(3),
    },
    { type: "end", nonce },
    { type: "wipe-selected", nonce, scope: { localStorage: "all", indexedDB: "all" } },
  ])("accepts $type", (command) => {
    expect(FrameCommand.safeParse(command).success).toBe(true);
  });

  it.each([
    ["an unknown type", { type: "eval", nonce, code: "1" }],
    ["an unknown member", { type: "inventory", nonce, extra: 1 }],
    ["a short nonce", { type: "inventory", nonce: nonce.slice(1) }],
    ["an upper-case nonce", { type: "inventory", nonce: nonce.toUpperCase() }],
    ["a counter as nonce", { type: "inventory", nonce: 1 }],
    ["no nonce", { type: "inventory" }],
    [
      "bytes as a JSON string",
      { type: "entry", nonce, path: "blobs/x", offset: 0, size: 3, bytes: "AAEC" },
    ],
    [
      "bytes as a typed array",
      { type: "entry", nonce, path: "blobs/x", offset: 0, size: 2, bytes: new Uint8Array(2) },
    ],
    [
      "a key index past maxStorageKeys",
      { type: "export", nonce, keyIndex: 32, storageKey, scope: ALL },
    ],
    [
      "a scope with a regex",
      {
        type: "export",
        nonce,
        keyIndex: 0,
        storageKey,
        scope: { localStorage: { include: [], exclude: [], regex: "." }, indexedDB: "all" },
      },
    ],
    [
      "a storage key with a path",
      {
        type: "export",
        nonce,
        keyIndex: 0,
        storageKey: { origin: "http://localhost:4317/x", topLevelSite: null },
        scope: ALL,
      },
    ],
  ])("refuses %s", (_name, command) => {
    expect(FrameCommand.safeParse(command).success).toBe(false);
  });
});

describe("frame replies", () => {
  it.each([
    { type: "entry", nonce, path: "blobs/x", offset: 0, size: 0, bytes: new ArrayBuffer(0) },
    {
      type: "inventory",
      nonce,
      inventory: {
        localStorageItems: 2,
        databases: [{ name: "a", version: 1 }],
        usageDetails: null,
      },
    },
    {
      type: "summary",
      nonce,
      summary: {
        localStorageItems: 2,
        databases: [{ name: "a", version: 1, stores: 1, records: 3 }],
        blobs: 1,
        notExported: ["cacheStorage"],
      },
    },
    { type: "wiped", nonce, wiped: { localStorageItems: 1, databases: ["a"] } },
    {
      type: "error",
      nonce,
      code: "EXP_UNSUPPORTED_VALUE",
      message: "EXP_UNSUPPORTED_VALUE for [object CryptoKey]",
      detail: {
        path: ["a", 1],
        type: "[object CryptoKey]",
        database: "d",
        store: "s",
        recordKey: 1,
      },
    },
  ])("accepts $type", (reply) => {
    expect(FrameReply.safeParse(reply).success).toBe(true);
  });

  it.each([
    [
      "an error code outside EXP, IMP and INTERNAL",
      { type: "error", nonce, code: "SNAP_TRUNCATED", message: "x" },
    ],
    ["an unknown reply", { type: "result", nonce, ok: true }],
    [
      "an unknown summary member",
      {
        type: "summary",
        nonce,
        summary: { localStorageItems: 0, databases: [], blobs: 0, notExported: [], values: [] },
      },
    ],
  ])("refuses %s", (_name, reply) => {
    expect(FrameReply.safeParse(reply).success).toBe(false);
  });

  it("recognises 128-bit lowercase hex nonces only", () => {
    expect(isRequestNonce(nonce)).toBe(true);
    expect(isRequestNonce(`${nonce}0`)).toBe(false);
    expect(isRequestNonce("g".repeat(32))).toBe(false);
  });
});

describe("entry chunks (save-transfer.md section 3)", () => {
  const chunk = (offset: number, size: number, length: number) => ({
    type: "entry",
    nonce,
    path: "data/0/idb/0/store-0.cbor",
    offset,
    size,
    bytes: new ArrayBuffer(length),
  });

  it("caps one message at 1 MiB of entry bytes", () => {
    expect(MAX_ENTRY_CHUNK_BYTES).toBe(1024 * 1024);
  });

  it.each([
    ["a whole small entry", chunk(0, 10, 10)],
    ["a full chunk of a larger entry", chunk(0, 3 * MAX_ENTRY_CHUNK_BYTES, MAX_ENTRY_CHUNK_BYTES)],
    ["the last, shorter chunk", chunk(2 * MAX_ENTRY_CHUNK_BYTES, 2 * MAX_ENTRY_CHUNK_BYTES + 5, 5)],
    ["an empty entry", chunk(0, 0, 0)],
  ])("accepts %s, in both directions", (_name, message) => {
    expect(FrameReply.safeParse(message).success).toBe(true);
    expect(FrameCommand.safeParse(message).success).toBe(true);
  });

  it.each([
    ["a chunk above 1 MiB", chunk(0, MAX_ENTRY_CHUNK_BYTES + 1, MAX_ENTRY_CHUNK_BYTES + 1)],
    ["a chunk that ends past the entry's size", chunk(8, 10, 3)],
    ["an empty chunk inside a non-empty entry", chunk(0, 10, 0)],
    ["a negative offset", chunk(-1, 10, 1)],
    ["a fractional size", chunk(0, 1.5, 1)],
    ["no size", { type: "entry", nonce, path: "blobs/x", offset: 0, bytes: new ArrayBuffer(1) }],
  ])("refuses %s", (_name, message) => {
    expect(FrameReply.safeParse(message).success).toBe(false);
    expect(FrameCommand.safeParse(message).success).toBe(false);
  });
});
