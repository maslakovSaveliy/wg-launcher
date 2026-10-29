import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  readEntries,
  type SnapshotFile,
  validateSnapshot,
  writeSnapshot,
} from "@wg-launcher/snapshot/container";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectedContentHash, frameEntries, openSource } from "./source.js";

const VECTORS = join(import.meta.dirname, "../../../../../packages/snapshot/test-vectors/v1");
const vector = (id: string) => join(VECTORS, id, "input.wgsnap");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wg-source-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function filesOf(path: string): Promise<SnapshotFile[]> {
  const { size } = await stat(path);
  const { manifest } = await validateSnapshot(createReadStream(path), { compressedSize: size });
  const files: SnapshotFile[] = [];
  for await (const entry of readEntries(createReadStream(path), manifest, {
    compressedSize: size,
  })) {
    files.push(entry);
  }
  return files;
}

const MANIFEST = {
  format: "wgsnap" as const,
  formatVersion: 1 as const,
  gameId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b",
  revisionId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c",
  parentRevisionId: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  deviceId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7d",
  exporter: { id: "generic-web-storage", version: "1.0.0" },
  adapter: null,
  gameVersion: null,
  flushState: "unconfirmed" as const,
};

async function write(
  path: string,
  storageKeys: { origin: string; topLevelSite: string | null; role: "top" | "frame" }[],
  files: SnapshotFile[],
): Promise<string> {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const { contentHash } = await writeSnapshot({ ...MANIFEST, storageKeys, files }, out);
  await writeFile(path, Buffer.concat(chunks));
  return contentHash;
}

const renamed = (files: SnapshotFile[], from: number, to: number) =>
  files.map((file) =>
    file.path.startsWith(`data/${from}/`)
      ? { path: `data/${to}/${file.path.slice(`data/${from}/`.length)}`, bytes: file.bytes }
      : file,
  );

describe("the restore source in the snapshot worker (R1, R6)", () => {
  it("validates the file and records which blobs each storage key's records reference", async () => {
    // Key 0 holds blobs (binary types); key 1 holds none (the minimal vector moved to data/1/).
    const blobby = await filesOf(vector("valid-binary-types"));
    const plain = renamed(await filesOf(vector("valid-minimal")), 0, 1);
    const path = join(dir, "two.wgsnap");
    const keys = [
      { origin: "http://a.test", topLevelSite: null, role: "top" as const },
      { origin: "http://b.test", topLevelSite: null, role: "top" as const },
    ];
    const contentHash = await write(path, keys, [...blobby, ...plain]);
    const source = await openSource(path, {});
    expect(source.manifest.contentHash).toBe(contentHash);
    const blobs = blobby.filter((f) => f.path.startsWith("blobs/")).map((f) => f.path.slice(6));
    expect(blobs.length).toBeGreaterThan(0);
    expect([...(source.blobsByKey.get(0) ?? [])].sort()).toEqual(blobs.sort());
    expect(source.blobsByKey.get(1) ?? new Set()).toEqual(new Set());

    // A frame gets its own data files, renumbered, and only the blobs its records reference.
    const paths = async (from: number, to: number) => {
      const out: string[] = [];
      for await (const entry of frameEntries(source, from, to)) out.push(entry.path);
      return out;
    };
    expect(await paths(1, 0)).toEqual(
      plain.map((f) => f.path.replace("data/1/", "data/0/")).sort(),
    );
    expect((await paths(0, 0)).sort()).toEqual(blobby.map((f) => f.path).sort());
  });

  it("re-checks every entry in the second pass: a file changed since validation fails the import", async () => {
    const path = join(dir, "changed.wgsnap");
    await copyFile(vector("valid-minimal"), path);
    const source = await openSource(path, {});
    await copyFile(vector("valid-idbfs"), path);
    await expect(async () => {
      for await (const _ of frameEntries(
        { ...source, compressedSize: (await stat(path)).size },
        0,
        0,
      )) {
        // drain
      }
    }).rejects.toMatchObject({ code: "SNAP_CONTENT_HASH_MISMATCH" });
  });

  it("gives the manifest's own hash for an unmapped plan", async () => {
    const source = await openSource(vector("valid-partitioned-iframe"), {});
    const keys = source.manifest.storageKeys.map((key, i) => ({ from: i, to: i, ...key }));
    expect(expectedContentHash(source.manifest, keys)).toBe(source.manifest.contentHash);
  });

  it("computes the expected hash after a mapping: keys replaced, sorted again, data/<k>/ renumbered", async () => {
    const path = vector("valid-partitioned-iframe");
    const source = await openSource(path, {});
    // 127.0.0.1 under localhost (key 0) and localhost (key 1), swapped: the top key moves to 127.0.0.1 and comes
    // first, the iframe key moves to localhost under 127.0.0.1 and comes second.
    const mapped = [
      { from: 1, to: 0, origin: "http://127.0.0.1:4417", topLevelSite: null, role: "top" as const },
      {
        from: 0,
        to: 1,
        origin: "http://localhost:4417",
        topLevelSite: "http://127.0.0.1",
        role: "frame" as const,
      },
    ];
    const files = (await filesOf(path)).map((file) => {
      const match = /^data\/(\d+)\//.exec(file.path);
      if (match === null) return file;
      const to = match[1] === "0" ? 1 : 0;
      return { path: file.path.replace(/^data\/\d+\//, `data/${to}/`), bytes: file.bytes };
    });
    const reexported = await write(
      join(dir, "mapped.wgsnap"),
      mapped.map(({ origin, topLevelSite, role }) => ({ origin, topLevelSite, role })),
      files,
    );
    expect(expectedContentHash(source.manifest, mapped)).toBe(reexported);
    expect(reexported).not.toBe(source.manifest.contentHash);
  });
});
