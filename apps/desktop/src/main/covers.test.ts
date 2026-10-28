import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COVER_NAME } from "./app-protocol.js";
import { createCovers, MAX_COVER_BYTES } from "./covers.js";
import { tempDir } from "./db/testing.js";

const GAME = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = Uint8Array.from([
  ...new TextEncoder().encode("RIFF"),
  4,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
]);
const GIF = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");

function setUp() {
  const dir = tempDir();
  const coversDir = join(dir, "covers");
  const tmpDir = join(dir, "tmp");
  mkdirSync(coversDir);
  mkdirSync(tmpDir);
  const source = (name: string, bytes: Uint8Array) => {
    const file = join(dir, name);
    writeFileSync(file, bytes);
    return file;
  };
  const covers = createCovers({ coversDir, tmpDir, random: (n) => new Uint8Array(n).fill(0xab) });
  return { dir, coversDir, tmpDir, source, covers };
}

describe("covers (architecture.md section 12)", () => {
  it.each([
    ["PNG", PNG, "png"],
    ["JPEG", JPEG, "jpg"],
    ["WebP", WEBP, "webp"],
  ] as const)(
    "copies a %s file by its magic bytes, named <gameId>-<16 hex>.<ext>",
    async (_kind, bytes, ext) => {
      const { coversDir, tmpDir, source, covers } = setUp();
      // The extension of the chosen file does not matter; the bytes do.
      const result = await covers.set(GAME, source("picked.bin", bytes));
      expect(result).toEqual({ ok: true, data: `${GAME}-abababababababab.${ext}` });
      if (!result.ok) return;
      expect(COVER_NAME.test(result.data)).toBe(true);
      expect(readFileSync(join(coversDir, result.data))).toEqual(Buffer.from(bytes));
      // Written as a .partial file in tmp/ and renamed: nothing is left behind.
      expect(readdirSync(tmpDir)).toEqual([]);
    },
  );

  it.each([
    ["a GIF", GIF],
    ["text named .png", new TextEncoder().encode("not an image")],
    ["an empty file", new Uint8Array(0)],
    [
      "RIFF that is not WebP",
      Uint8Array.from([...WEBP.slice(0, 8), ...new TextEncoder().encode("AVI ")]),
    ],
    ["a truncated PNG signature", PNG.slice(0, 5)],
  ])("refuses %s as INVALID_ARGUMENT and writes nothing", async (_name, bytes) => {
    const { coversDir, tmpDir, source, covers } = setUp();
    const result = await covers.set(GAME, source("cover.png", bytes));
    expect(result).toEqual({
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "The cover must be a PNG, JPEG or WebP image.",
    });
    expect(readdirSync(coversDir)).toEqual([]);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it("accepts exactly 10 MiB and refuses one byte more", async () => {
    const { source, covers, coversDir } = setUp();
    const big = new Uint8Array(MAX_COVER_BYTES);
    big.set(PNG);
    expect((await covers.set(GAME, source("ok.png", big))).ok).toBe(true);
    const over = new Uint8Array(MAX_COVER_BYTES + 1);
    over.set(PNG);
    expect(await covers.set(GAME, source("over.png", over))).toEqual({
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "The cover image is larger than 10 MiB.",
    });
    expect(readdirSync(coversDir)).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symbolic link, even to a valid image",
    async () => {
      const { dir, source, covers, coversDir } = setUp();
      const target = source("real.png", PNG);
      const link = join(dir, "link.png");
      symlinkSync(target, link);
      expect(await covers.set(GAME, link)).toEqual({
        ok: false,
        code: "INVALID_ARGUMENT",
        message: "The cover must be a regular file.",
      });
      expect(readdirSync(coversDir)).toEqual([]);
    },
  );

  it("refuses a directory and a missing file", async () => {
    const { dir, covers } = setUp();
    const folder = join(dir, "folder.png");
    mkdirSync(folder);
    expect(await covers.set(GAME, folder)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(await covers.set(GAME, join(dir, "missing.png"))).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "The cover file cannot be read.",
    });
  });

  it("refuses a game id that is not a lowercase UUIDv7 (it is part of the file name)", async () => {
    const { source, covers } = setUp();
    expect(await covers.set("../evil", source("a.png", PNG))).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
  });

  it("removes a cover by name, and ignores a name that is not a cover name", async () => {
    const { source, covers, coversDir, dir } = setUp();
    const result = await covers.set(GAME, source("a.png", PNG));
    if (!result.ok) throw new Error(result.message);
    const outside = join(dir, "keep.png");
    writeFileSync(outside, PNG);
    await covers.remove("../keep.png");
    expect(existsSync(outside)).toBe(true);
    await covers.remove(result.data);
    expect(readdirSync(coversDir)).toEqual([]);
    // Removing again is not an error.
    await covers.remove(result.data);
  });

  it("gives each copy a new random name", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "covers"));
    mkdirSync(join(dir, "tmp"));
    const covers = createCovers({ coversDir: join(dir, "covers"), tmpDir: join(dir, "tmp") });
    const file = join(dir, "a.png");
    writeFileSync(file, PNG);
    const [a, b] = await Promise.all([covers.set(GAME, file), covers.set(GAME, file)]);
    expect(a?.ok && b?.ok && a.data !== b.data).toBe(true);
  });
});
