import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLocalStorage } from "@wg-launcher/snapshot";
import { SnapError, validateSnapshot } from "@wg-launcher/snapshot/container";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManifestFields } from "./protocol.js";
import { WriteFailure, writeVerified } from "./write.js";

const MANIFEST: ManifestFields = {
  format: "wgsnap",
  formatVersion: 1,
  gameId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b",
  revisionId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c",
  parentRevisionId: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  deviceId: "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7d",
  exporter: { id: "generic-web-storage", version: "1.0.0" },
  adapter: null,
  gameVersion: null,
  flushState: "unconfirmed",
  storageKeys: [{ origin: "http://localhost:4317", topLevelSite: null, role: "top" }],
};

const localStorageFile = (value: string) => ({
  path: "data/0/local-storage.cbor",
  bytes: encodeLocalStorage([["progress-lab:state", value]]) as Uint8Array,
});

let dir: string;
let tmp: string;
let snapshots: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wg-write-"));
  tmp = join(dir, "tmp");
  snapshots = join(dir, "snapshots");
  await mkdir(tmp);
  await mkdir(snapshots);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const paths = () => ({
  partialPath: join(tmp, `${MANIFEST.revisionId}.wgsnap.partial`),
  finalPath: join(snapshots, `${MANIFEST.revisionId}.wgsnap`),
});
const left = async () => ({ tmp: await readdir(tmp), snapshots: await readdir(snapshots) });

async function failure(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SnapError || error instanceof WriteFailure) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a failure");
}

describe("writeVerified (save-transfer.md section 6, Export)", () => {
  it("writes the partial file, validates it read back, and renames it into place", async () => {
    const result = await writeVerified({
      manifest: MANIFEST,
      files: [localStorageFile('{"steps":7}')],
      ...paths(),
      limits: {},
    });
    expect(await left()).toEqual({ tmp: [], snapshots: [`${MANIFEST.revisionId}.wgsnap`] });
    const { finalPath } = paths();
    const size = (await stat(finalPath)).size;
    expect(result.sizeBytes).toBe(size);
    const validated = await validateSnapshot(createReadStream(finalPath), { compressedSize: size });
    expect(validated.manifest.contentHash).toBe(result.contentHash);
    expect(validated.manifest.revisionId).toBe(MANIFEST.revisionId);
    expect(result.entries).toBe(1);
  });

  it.each([
    [
      "SNAP_RATIO_EXCEEDED (the writer does not check the ratio)",
      { ratioFloorBytes: 1024, maxRatio: 2 },
      "SNAP_RATIO_EXCEEDED",
    ],
    [
      "SNAP_FILE_TOO_LARGE (the writer does not check maxFileBytes)",
      { maxFileBytes: 64 },
      "SNAP_FILE_TOO_LARGE",
    ],
    [
      "SNAP_TOTAL_TOO_LARGE, before a byte is written",
      { maxTotalBytes: 4096 },
      "SNAP_TOTAL_TOO_LARGE",
    ],
  ])("fails with %s and leaves no file in tmp/ or snapshots/", async (_name, limits, code) => {
    const files = [localStorageFile("a".repeat(64 * 1024))];
    const failed = await failure(writeVerified({ manifest: MANIFEST, files, ...paths(), limits }));
    expect(failed.code).toBe(code);
    expect(await left()).toEqual({ tmp: [], snapshots: [] });
  });

  it("reports a disk write failure with its error code and leaves nothing behind (fault fail-write)", async () => {
    const failed = await failure(
      writeVerified({
        manifest: MANIFEST,
        files: [localStorageFile("a".repeat(256 * 1024))],
        ...paths(),
        limits: {},
        fault: "fail-write",
      }),
    );
    expect(failed).toEqual({
      code: "INTERNAL",
      message: "The snapshot file could not be written (EIO).",
    });
    expect(await left()).toEqual({ tmp: [], snapshots: [] });
  });

  it("never replaces an existing snapshot file", async () => {
    const { finalPath } = paths();
    await writeFile(finalPath, "existing");
    const failed = await failure(
      writeVerified({ manifest: MANIFEST, files: [localStorageFile("x")], ...paths(), limits: {} }),
    );
    expect(failed.code).toBe("INTERNAL");
    expect(await left()).toEqual({ tmp: [], snapshots: [`${MANIFEST.revisionId}.wgsnap`] });
    expect((await stat(finalPath)).size).toBe("existing".length);
  });
});
