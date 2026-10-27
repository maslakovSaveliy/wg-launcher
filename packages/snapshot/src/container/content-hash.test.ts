import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeContentHash } from "./content-hash.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("computeContentHash (snapshot-format.md section 5)", () => {
  it("hashes the JCS text of entries, format, formatVersion and storageKeys only", () => {
    const manifest = {
      format: "wgsnap" as const,
      formatVersion: 1 as const,
      gameId: "ignored",
      createdAt: "ignored",
      storageKeys: [{ origin: "https://a.example", topLevelSite: null, role: "top" as const }],
      entries: [
        { path: "blobs/x", size: 3, sha256: A },
        { path: "data/0/local-storage.cbor", size: 10, sha256: B },
      ],
    };
    // Written by hand from section 5: members sorted, entries and storageKeys in manifest order.
    const expected =
      '{"entries":[{"path":"blobs/x","sha256":"' +
      A +
      '","size":3},{"path":"data/0/local-storage.cbor","sha256":"' +
      B +
      '","size":10}],"format":"wgsnap","formatVersion":1,"storageKeys":[{"origin":"https://a.example","role":"top","topLevelSite":null}]}';
    expect(computeContentHash(manifest)).toBe(sha(expected));
  });

  it("does not depend on the uncovered fields", () => {
    const base = { storageKeys: [], entries: [] };
    const extended = { ...base, gameId: "x", flushState: "confirmed" };
    expect(computeContentHash(extended)).toBe(computeContentHash(base));
    expect(computeContentHash(base)).toBe(
      sha('{"entries":[],"format":"wgsnap","formatVersion":1,"storageKeys":[]}'),
    );
  });
});
