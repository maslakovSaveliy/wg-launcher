// Cover images (architecture.md sections 3 and 12): a PNG, JPEG or WebP file of at most 10 MiB, recognized by its
// magic bytes (never by its extension), copied to `covers/<gameId>-<16 lowercase hex>.<png|jpg|webp>` (the exact
// `COVER_NAME` pattern the app:// handler serves). The copy is written as a `.partial` file in `tmp/`, flushed and
// renamed into place. The source must be a regular file: a symbolic link is refused (`O_NOFOLLOW` where the OS has
// it, then `lstat` and `fstat` on the opened handle), so a link cannot make the app copy another file, and the open
// uses `O_NONBLOCK` where the OS has it, so a FIFO swapped in after the `lstat` cannot block it.

import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isUuidV7, type Result } from "@wg-launcher/shared";
import { COVER_NAME } from "./app-protocol.js";

export const MAX_COVER_BYTES = 10 * 1024 * 1024;

type CoverExt = "png" | "jpg" | "webp";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));

/** The image type by magic bytes: PNG signature, JPEG SOI plus a marker byte, or a RIFF container of type WEBP. */
export function coverType(bytes: Uint8Array): CoverExt | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "jpg";
  if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "webp";
  return null;
}

type CoverResult = Result<string, "INVALID_ARGUMENT" | "INTERNAL">;

const refuse = (message: string): CoverResult => ({ ok: false, code: "INVALID_ARGUMENT", message });
const NOT_REGULAR = "The cover must be a regular file.";
const TOO_LARGE = "The cover image is larger than 10 MiB.";
const NOT_AN_IMAGE = "The cover must be a PNG, JPEG or WebP image.";
const UNREADABLE = "The cover file cannot be read.";

export interface CoversOptions {
  coversDir: string;
  tmpDir: string;
  /** For tests; defaults to `crypto.randomBytes`. */
  random?: (n: number) => Uint8Array;
  /** For tests (a file swapped between the check and the open); defaults to `fs.promises.lstat`. */
  lstat?: (path: string) => Promise<Stats>;
}

export interface Covers {
  /** Checks and copies `source`; resolves with the new file name (not a path). */
  set(gameId: string, source: string): Promise<CoverResult>;
  /** Deletes `covers/<name>`; a name that is not a cover name is ignored, a missing file is not an error. */
  remove(name: string): Promise<void>;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function readRegularFile(
  source: string,
  lstatOf: (path: string) => Promise<Stats>,
): Promise<Uint8Array | CoverResult> {
  let link: Stats;
  try {
    link = await lstatOf(source);
  } catch {
    return refuse(UNREADABLE);
  }
  if (!link.isFile()) return refuse(NOT_REGULAR);
  if (link.size > MAX_COVER_BYTES) return refuse(TOO_LARGE);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat would block `open` until a writer comes; with it the open
    // returns and the fstat below refuses the FIFO. Regular-file reads ignore the flag.
    handle = await open(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return refuse(UNREADABLE);
  }
  try {
    // The file that was opened, which may differ from the one lstat saw.
    const stats = await handle.stat();
    if (!stats.isFile()) return refuse(NOT_REGULAR);
    if (stats.size > MAX_COVER_BYTES) return refuse(TOO_LARGE);
    // One byte more than the limit, so a file that grew after the stat is still caught.
    const buffer = new Uint8Array(MAX_COVER_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_COVER_BYTES) return refuse(TOO_LARGE);
    return buffer.subarray(0, length);
  } catch {
    return refuse(UNREADABLE);
  } finally {
    await handle.close();
  }
}

export function createCovers(options: CoversOptions): Covers {
  const random = options.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
  return {
    async set(gameId, source) {
      if (!isUuidV7(gameId)) return refuse("That is not a game id.");
      const bytes = await readRegularFile(source, options.lstat ?? lstat);
      if (!(bytes instanceof Uint8Array)) return bytes;
      const ext = coverType(bytes);
      if (ext === null) return refuse(NOT_AN_IMAGE);
      const name = `${gameId}-${hex(random(8))}.${ext}`;
      if (!COVER_NAME.test(name))
        return { ok: false, code: "INTERNAL", message: "The cover could not be saved." };
      const partial = join(options.tmpDir, `${name}.partial`);
      try {
        const out = await open(partial, "wx");
        try {
          await out.writeFile(bytes);
          await out.sync();
        } finally {
          await out.close();
        }
        await rename(partial, join(options.coversDir, name));
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
      return { ok: true, data: name };
    },
    async remove(name) {
      if (!COVER_NAME.test(name)) return;
      await rm(join(options.coversDir, name), { force: true });
    },
  };
}
