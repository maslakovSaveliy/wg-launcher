import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appPaths, prepareAppPaths, resolveUserData } from "./paths.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wg-paths-"));
  dirs.push(dir);
  return dir;
}

describe("appPaths", () => {
  it("lays out userData as architecture.md section 3 says", () => {
    const root = join("x", "userData");
    expect(appPaths(root)).toEqual({
      db: join(root, "library.db"),
      covers: join(root, "covers"),
      snapshots: join(root, "snapshots"),
      backups: join(root, "backups"),
      tmp: join(root, "tmp"),
      logs: join(root, "logs"),
    });
  });
});

describe("prepareAppPaths", () => {
  it("creates the directories and empties tmp, leaving everything else alone", async () => {
    const paths = appPaths(await tempDir());
    await mkdir(join(paths.tmp, "nested"), { recursive: true });
    await writeFile(join(paths.tmp, "a.partial"), "x");
    await writeFile(join(paths.tmp, "nested", "b.partial"), "x");
    await mkdir(paths.snapshots, { recursive: true });
    await writeFile(join(paths.snapshots, "keep.wgsnap"), "x");

    await prepareAppPaths(paths);

    expect(await readdir(paths.tmp)).toEqual([]);
    expect(await readdir(paths.snapshots)).toEqual(["keep.wgsnap"]);
    for (const dir of [paths.covers, paths.backups, paths.logs]) {
      expect(await readdir(dir)).toEqual([]);
    }
  });
});

describe("resolveUserData", () => {
  const absolute = join(tmpdir(), "wg-e2e-x");
  /** A stand-in for Electron's `app`: records every path it is asked for. */
  function electronPaths() {
    const read: string[] = [];
    return {
      read,
      getPath(name: "userData" | "appData") {
        read.push(name);
        return name === "userData" ? join("os", "WGLauncher") : join("os");
      },
    };
  }

  it("uses WG_USER_DATA in the test flavor", () => {
    expect(resolveUserData("test", { WG_USER_DATA: absolute }, electronPaths())).toBe(absolute);
  });

  it("never asks Electron for a default path in the test flavor (reading userData creates it)", () => {
    const paths = electronPaths();
    resolveUserData("test", { WG_USER_DATA: absolute }, paths);
    expect(() => resolveUserData("test", {}, paths)).toThrow();
    expect(paths.read).toEqual([]);
  });

  it("refuses to start the test flavor without an absolute WG_USER_DATA", () => {
    expect(() => resolveUserData("test", {}, electronPaths())).toThrow(/WG_USER_DATA/);
    expect(() =>
      resolveUserData("test", { WG_USER_DATA: "relative/dir" }, electronPaths()),
    ).toThrow(/absolute/);
  });

  it("ignores WG_USER_DATA in the prod flavor", () => {
    expect(resolveUserData("prod", { WG_USER_DATA: absolute }, electronPaths())).toBe(
      join("os", "WGLauncher"),
    );
  });

  it("keeps the dev flavor out of the production userData, reading only appData", () => {
    const paths = electronPaths();
    expect(resolveUserData("dev", {}, paths)).toBe(join("os", "WGLauncher Dev"));
    expect(paths.read).toEqual(["appData"]);
  });

  it("lets a dev run use WG_USER_DATA, so a check run leaves no real directory behind", () => {
    const paths = electronPaths();
    expect(resolveUserData("dev", { WG_USER_DATA: absolute }, paths)).toBe(absolute);
    expect(paths.read).toEqual([]);
  });
});
