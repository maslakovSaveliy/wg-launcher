import type { SnapCode } from "@wg-launcher/shared";
import { describe, expect, it } from "vitest";
import { SnapError } from "../errors.js";
import { computeContentHash } from "./content-hash.js";
import { canonicalJson } from "./jcs.js";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.js";
import { ManifestSchema, parseManifest } from "./manifest.js";

const UUID = (n: number) => `0192f0a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const HEX = (c: string) => c.repeat(64);

/** A valid manifest object; `contentHash` is recomputed from the result of `edit` unless `keepHash` is set. */
function manifest(edit: (m: Record<string, unknown>) => void = () => {}, keepHash = false) {
  const m: Record<string, unknown> = {
    format: "wgsnap",
    formatVersion: 1,
    gameId: UUID(1),
    revisionId: UUID(2),
    parentRevisionId: null,
    createdAt: "2026-10-25T12:00:00.000Z",
    deviceId: UUID(3),
    exporter: { id: "generic", version: "1.0.0" },
    adapter: null,
    gameVersion: null,
    flushState: "unconfirmed",
    storageKeys: [
      // "1" sorts before "l": the frame key comes first.
      { origin: "http://127.0.0.1:4418", topLevelSite: "http://localhost", role: "frame" },
      { origin: "http://localhost:4417", topLevelSite: null, role: "top" },
    ],
    entries: [
      { path: "data/0/local-storage.cbor", size: 10, sha256: HEX("a") },
      { path: "data/1/local-storage.cbor", size: 20, sha256: HEX("b") },
    ],
    contentHash: "",
  };
  m.contentHash = computeContentHash(m as never);
  edit(m);
  if (!keepHash && Array.isArray(m.entries) && Array.isArray(m.storageKeys)) {
    m.contentHash = computeContentHash(m as never);
  }
  return m;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const encode = (m: unknown) => bytes(canonicalJson(m));

function codeOf(run: () => unknown): SnapCode | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof SnapError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

const parse = (b: Uint8Array, limits = DEFAULT_LIMITS) => parseManifest(b, limits);

describe("parseManifest (snapshot-format.md section 4)", () => {
  it("accepts a canonical valid manifest and returns its fields", () => {
    const m = manifest();
    expect(parse(encode(m))).toEqual(m);
  });

  it("accepts the optional and nullable fields filled in", () => {
    const m = manifest((x) => {
      x.parentRevisionId = UUID(4);
      x.adapter = { id: "progress-lab", version: "1.0.0-rc.1+build.5" };
      x.gameVersion = "v1.2 é";
      x.flushState = "confirmed";
      x.notExported = [{ key: 0, kind: "cacheStorage" }];
    });
    expect(parse(encode(m))).toEqual(m);
  });

  it("refuses a manifest above maxManifestBytes first", () => {
    const text = canonicalJson(manifest());
    const limits = resolveLimits({ maxManifestBytes: text.length - 1 });
    expect(codeOf(() => parse(bytes(text), limits))).toBe("SNAP_MANIFEST_TOO_LARGE");
    expect(codeOf(() => parse(bytes(text), resolveLimits({ maxManifestBytes: text.length })))).toBe(
      undefined,
    );
  });

  it.each([
    ["invalid UTF-8", Uint8Array.of(0x7b, 0xff, 0x7d)],
    ["a byte-order mark", bytes(`﻿${canonicalJson(manifest())}`)],
    ["text that is not JSON", bytes('{"format":"wgsnap",')],
  ])("refuses %s as SNAP_MANIFEST_INVALID", (_, input) => {
    expect(codeOf(() => parse(input))).toBe("SNAP_MANIFEST_INVALID");
  });

  it.each([
    ["another format", { ...manifest(), format: "zip" }],
    ["no format", { formatVersion: 1 }],
    ["an array", [1]],
    ["a string", "wgsnap"],
    ["null", null],
  ])("refuses %s as SNAP_UNKNOWN_FORMAT", (_, value) => {
    expect(codeOf(() => parse(encode(value)))).toBe("SNAP_UNKNOWN_FORMAT");
  });

  it("checks format before formatVersion", () => {
    expect(codeOf(() => parse(encode({ format: "zip", formatVersion: 2 })))).toBe(
      "SNAP_UNKNOWN_FORMAT",
    );
  });

  it.each([2, 0, "1", null])("refuses formatVersion %j as SNAP_UNSUPPORTED_VERSION", (version) => {
    expect(codeOf(() => parse(encode({ ...manifest(), formatVersion: version })))).toBe(
      "SNAP_UNSUPPORTED_VERSION",
    );
  });

  it("gives SNAP_UNSUPPORTED_VERSION for a formatVersion 2 manifest with whitespace and new fields", () => {
    const text = JSON.stringify({ format: "wgsnap", formatVersion: 2, chunks: [1.5] }, null, 2);
    expect(codeOf(() => parse(bytes(text)))).toBe("SNAP_UNSUPPORTED_VERSION");
  });

  it.each([
    ["whitespace", (t: string) => t.replace('"format":', '"format": ')],
    ["a trailing newline", (t: string) => `${t}\n`],
    [
      "unsorted keys",
      (t: string) =>
        t.replace('{"adapter":null,', "{").replace('"createdAt"', '"adapter":null,"createdAt"'),
    ],
    [
      "a duplicate key",
      (t: string) => t.replace('{"adapter":null,', '{"adapter":null,"adapter":null,'),
    ],
    ["an escaped ASCII character", (t: string) => t.replace('"wgsnap"', '"wg\\u0073nap"')],
    ["a float in an unknown field", (t: string) => t.replace('{"adapter"', '{"a":1.5,"adapter"')],
    ["an exponent", (t: string) => t.replace('"formatVersion":1', '"formatVersion":1e0')],
  ])("refuses a manifest with %s as SNAP_MANIFEST_INVALID (JCS)", (_, change) => {
    const text = change(canonicalJson(manifest()));
    expect(text).not.toBe(canonicalJson(manifest()));
    expect(codeOf(() => parse(bytes(text)))).toBe("SNAP_MANIFEST_INVALID");
  });

  it("ignores an unknown top-level field, leaves it out of the result and out of contentHash", () => {
    const plain = manifest();
    const extended = { ...plain, comment: { anything: [1, "x", null] }, zz: true };
    const parsed = parse(encode(extended));
    expect(parsed).toEqual(plain);
    expect(parsed.contentHash).toBe(plain.contentHash);
  });

  it.each([
    [
      "storageKeys",
      (m: Record<string, unknown>) =>
        ((m.storageKeys as object[])[0] = { ...(m.storageKeys as object[])[0], extra: 1 }),
    ],
    [
      "entries",
      (m: Record<string, unknown>) =>
        ((m.entries as object[])[0] = { ...(m.entries as object[])[0], extra: 1 }),
    ],
    [
      "exporter",
      (m: Record<string, unknown>) => (m.exporter = { id: "generic", version: "1.0.0", extra: 1 }),
    ],
    [
      "adapter",
      (m: Record<string, unknown>) => (m.adapter = { id: "a", version: "1.0.0", extra: 1 }),
    ],
    [
      "notExported",
      (m: Record<string, unknown>) => (m.notExported = [{ key: 0, kind: "fileSystem", extra: 1 }]),
    ],
  ])("refuses an unknown member inside %s (strict nested objects, M7)", (_, edit) => {
    expect(codeOf(() => parse(encode(manifest(edit))))).toBe("SNAP_MANIFEST_INVALID");
  });

  it.each([
    ["flushState", (m: Record<string, unknown>) => (m.flushState = "maybe")],
    [
      "role",
      (m: Record<string, unknown>) =>
        (((m.storageKeys as Record<string, unknown>[])[0] as Record<string, unknown>).role =
          "worker"),
    ],
    ["kind", (m: Record<string, unknown>) => (m.notExported = [{ key: 0, kind: "cookies" }])],
  ])("refuses an unknown value of the enum field %s", (_, edit) => {
    expect(codeOf(() => parse(encode(manifest(edit))))).toBe("SNAP_MANIFEST_INVALID");
  });

  it.each([
    ["a missing field", (m: Record<string, unknown>) => delete m.deviceId],
    [
      "a gameId that is not a UUIDv7",
      (m: Record<string, unknown>) => (m.gameId = "0192f0a0-0000-4000-8000-000000000001"),
    ],
    [
      "a non-UTC createdAt",
      (m: Record<string, unknown>) => (m.createdAt = "2026-10-25T12:00:00.000+01:00"),
    ],
    [
      "an impossible createdAt",
      (m: Record<string, unknown>) => (m.createdAt = "2026-02-30T12:00:00.000Z"),
    ],
    [
      "an exporter id with capitals",
      (m: Record<string, unknown>) => (m.exporter = { id: "Generic", version: "1.0.0" }),
    ],
    [
      "an exporter version that is not SemVer",
      (m: Record<string, unknown>) => (m.exporter = { id: "generic", version: "1.0" }),
    ],
    [
      "a gameVersion of 129 characters",
      (m: Record<string, unknown>) => (m.gameVersion = "x".repeat(129)),
    ],
    [
      "an origin with a path",
      (m: Record<string, unknown>) =>
        (((m.storageKeys as Record<string, unknown>[])[0] as Record<string, unknown>).origin =
          "http://localhost:4417/"),
    ],
    [
      "an origin with a non-http scheme",
      (m: Record<string, unknown>) =>
        (((m.storageKeys as Record<string, unknown>[])[0] as Record<string, unknown>).origin =
          "file://x"),
    ],
    [
      "a topLevelSite with a port",
      (m: Record<string, unknown>) =>
        (((m.storageKeys as Record<string, unknown>[])[1] as Record<string, unknown>).topLevelSite =
          "http://localhost:1"),
    ],
    [
      "unsorted storageKeys",
      (m: Record<string, unknown>) => (m.storageKeys as unknown[]).reverse(),
    ],
    [
      "two equal storage keys",
      (m: Record<string, unknown>) =>
        (m.storageKeys = [(m.storageKeys as unknown[])[0], (m.storageKeys as unknown[])[0]]),
    ],
    ["unsorted entries", (m: Record<string, unknown>) => (m.entries as unknown[]).reverse()],
    [
      "a duplicate entry",
      (m: Record<string, unknown>) =>
        (m.entries = [(m.entries as unknown[])[0], (m.entries as unknown[])[0]]),
    ],
    [
      "manifest.json listed as an entry",
      (m: Record<string, unknown>) =>
        (m.entries = [{ path: "manifest.json", size: 1, sha256: HEX("c") }]),
    ],
    [
      "an entry hash in capitals",
      (m: Record<string, unknown>) =>
        (((m.entries as Record<string, unknown>[])[0] as Record<string, unknown>).sha256 =
          HEX("A")),
    ],
    [
      "a notExported key past storageKeys",
      (m: Record<string, unknown>) => (m.notExported = [{ key: 2, kind: "fileSystem" }]),
    ],
  ])("refuses %s as SNAP_MANIFEST_INVALID (schema)", (_, edit) => {
    expect(codeOf(() => parse(encode(manifest(edit))))).toBe("SNAP_MANIFEST_INVALID");
  });

  it("orders storage keys by origin, then topLevelSite with null first", () => {
    const keys = [
      { origin: "http://a.example", topLevelSite: null, role: "top" },
      { origin: "http://a.example", topLevelSite: "http://b.example", role: "frame" },
      { origin: "http://b.example", topLevelSite: null, role: "top" },
    ];
    expect(codeOf(() => parse(encode(manifest((m) => (m.storageKeys = keys)))))).toBe(undefined);
    const swapped = [keys[1], keys[0], keys[2]];
    expect(codeOf(() => parse(encode(manifest((m) => (m.storageKeys = swapped)))))).toBe(
      "SNAP_MANIFEST_INVALID",
    );
  });

  it("refuses more than maxStorageKeys storage keys as SNAP_MANIFEST_INVALID", () => {
    const limits = resolveLimits({ maxStorageKeys: 1 });
    expect(codeOf(() => parse(encode(manifest()), limits))).toBe("SNAP_MANIFEST_INVALID");
    expect(codeOf(() => parse(encode(manifest()), resolveLimits({ maxStorageKeys: 2 })))).toBe(
      undefined,
    );
  });

  it("refuses a wrong contentHash, after the schema", () => {
    const wrong = manifest((m) => (m.contentHash = HEX("0")), true);
    expect(codeOf(() => parse(encode(wrong)))).toBe("SNAP_CONTENT_HASH_MISMATCH");
    const both = manifest((m) => {
      m.contentHash = HEX("0");
      m.flushState = "maybe";
    }, true);
    expect(codeOf(() => parse(encode(both)))).toBe("SNAP_MANIFEST_INVALID");
  });

  it("exports the default-limits schema", () => {
    expect(ManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(ManifestSchema.safeParse({ ...manifest(), extra: 1 }).success).toBe(true);
  });
});
