import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffSnapshots, guardDirs, REAL_PROFILE_DIRS, snapshotDir } from "./real-profile-guard.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wg-guard-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function profile(): Promise<string> {
  const dir = join(await scratch(), "WGLauncher");
  await mkdir(join(dir, "Cache"), { recursive: true });
  await writeFile(join(dir, "Local State"), "{}");
  await writeFile(join(dir, "Cache", "data"), "abc");
  return dir;
}

describe("real profile guard", () => {
  it("passes when nothing changed", async () => {
    const dir = await profile();
    await (await guardDirs([dir])).verify();
  });

  it("passes when a directory is missing before and after", async () => {
    const dir = join(await scratch(), "WGLauncher");
    await (await guardDirs([dir])).verify();
  });

  it("detects a directory that was created", async () => {
    const dir = join(await scratch(), "WGLauncher");
    const guard = await guardDirs([dir]);
    await mkdir(dir);
    await expect(guard.verify()).rejects.toThrow(/WGLauncher: the directory did not exist/);
  });

  it("detects a file added deep inside, removed, or rewritten with the same size", async () => {
    const dir = await profile();
    const guard = await guardDirs([dir]);

    await writeFile(join(dir, "Cache", "new"), "x");
    await expect(guard.verify()).rejects.toThrow(/added: Cache\/new|added: Cache\\new/);
    await rm(join(dir, "Cache", "new"));
    await guard.verify();

    await rm(join(dir, "Local State"));
    await expect(guard.verify()).rejects.toThrow(/removed: Local State/);
    await writeFile(join(dir, "Local State"), "{}");

    // Same name and size, later modification time (what a rewrite of `Local State` looks like).
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, "Cache", "data"), later, later);
    await expect(guard.verify()).rejects.toThrow(/changed: Cache.data/);
  });

  it("does not print file contents and caps the list of differences", async () => {
    const dir = await profile();
    const guard = await guardDirs([dir]);
    for (let i = 0; i < 15; i += 1) await writeFile(join(dir, `f${i}`), "secret");
    const error = await guard.verify().then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/and 5 more/);
    expect(error?.message).not.toMatch(/secret/);
  });

  it("diffSnapshots compares two snapshots directly", async () => {
    const dir = await profile();
    const a = await snapshotDir(dir);
    expect(diffSnapshots(a, a)).toEqual([]);
    expect(diffSnapshots(null, null)).toEqual([]);
    expect(diffSnapshots(a, null)).toEqual(["the directory existed and is gone"]);
  });

  it("watches the real directories of the prod and dev flavors", () => {
    expect(REAL_PROFILE_DIRS.map((dir) => dir.split(/[\\/]/).pop())).toEqual([
      "WGLauncher",
      "WGLauncher Dev",
    ]);
  });
});
