// The minimal ustar subset of snapshot-format.md sections 2 and 3.1: a header parser applying entry rules 1 to 10, the
// stateful rules 11 to 14, a streaming reader and the writer's header. Every rejection has its own code (AC-9). The
// reader never creates files; it yields entries to the validator.
import { SnapError } from "../errors.js";
import type { Limits } from "./limits.js";

export const BLOCK = 512;

export interface TarHeader {
  /** The joined path; a directory's single trailing slash is removed. */
  path: string;
  type: "file" | "directory";
  size: number;
}

export interface TarEntry {
  header: TarHeader;
  /** The entry's bytes (empty for a directory). */
  data: Uint8Array;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();
const MAGIC = utf8Encoder.encode("ustar\0");
const VERSION = utf8Encoder.encode("00");

const tarInvalid = (message: string): never => {
  throw new SnapError("SNAP_TAR_INVALID", message);
};

/** A field up to its first NUL (or the whole field). */
function cString(block: Uint8Array, at: number, length: number): Uint8Array {
  const field = block.subarray(at, at + length);
  const nul = field.indexOf(0);
  return nul < 0 ? field : field.subarray(0, nul);
}

/** A numeric field: one or more octal digits, then only NUL or space bytes up to the end of the field. */
function octalField(block: Uint8Array, at: number, length: number, what: string): number {
  let value = 0;
  let i = 0;
  for (; i < length; i++) {
    const byte = block[at + i] as number;
    if (byte < 0x30 || byte > 0x37) {
      break;
    }
    value = value * 8 + (byte - 0x30);
  }
  if (i === 0) {
    tarInvalid(`the ${what} field is not octal`);
  }
  for (; i < length; i++) {
    const byte = block[at + i];
    if (byte !== 0 && byte !== 0x20) {
      tarInvalid(`the ${what} field is not octal`);
    }
  }
  return value;
}

const sameBytes = (block: Uint8Array, at: number, expected: Uint8Array) =>
  expected.every((byte, i) => block[at + i] === byte);

/** Rule 1: checksum (bytes 148 to 155 counted as spaces, unsigned sum), magic `ustar\0`, version `00`, octal size. */
function checkStructure(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
  }
  if (octalField(block, 148, 8, "checksum") !== sum) {
    tarInvalid("the header checksum does not match");
  }
  if (!sameBytes(block, 257, MAGIC) || !sameBytes(block, 263, VERSION)) {
    tarInvalid("not a ustar header");
  }
  return octalField(block, 124, 12, "size");
}

/** Rules 2 to 5 on the typeflag (byte 156). */
function entryType(typeflag: number): TarHeader["type"] {
  switch (String.fromCharCode(typeflag)) {
    case "0":
    case "\0":
      return "file";
    case "5":
      return "directory";
    case "2":
      throw new SnapError("SNAP_SYMLINK", "symbolic link entry");
    case "1":
      throw new SnapError("SNAP_HARDLINK", "hard link entry");
    case "3":
    case "4":
    case "6":
      throw new SnapError("SNAP_DEVICE", "device or FIFO entry");
    default:
      throw new SnapError("SNAP_UNSUPPORTED_ENTRY_TYPE", "unsupported entry type");
  }
}

/** Rules 6 to 10 on the joined path. Returns the path without a directory's trailing slash. */
function checkPath(raw: Uint8Array, type: TarHeader["type"]): string {
  let path: string;
  try {
    path = utf8.decode(raw);
  } catch {
    throw new SnapError("SNAP_BAD_PATH_ENCODING", "the entry path is not UTF-8");
  }
  const fail = (
    code: "SNAP_ABSOLUTE_PATH" | "SNAP_PATH_TRAVERSAL" | "SNAP_BAD_PATH" | "SNAP_NON_NFC_PATH",
    why: string,
  ) => {
    throw new SnapError(code, why, path);
  };
  if (/^[/\\]/.test(path) || /^[A-Za-z]:/.test(path)) {
    fail("SNAP_ABSOLUTE_PATH", "absolute entry path");
  }
  if (path.split("/").includes("..")) {
    fail("SNAP_PATH_TRAVERSAL", "entry path with a .. segment");
  }
  // A directory may end in one slash; a file may not.
  const name = type === "directory" && path.endsWith("/") ? path.slice(0, -1) : path;
  if (
    raw.length > 255 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what rule 9 refuses.
    /[\\\u0000-\u001f\u007f]/.test(name) ||
    name.split("/").some((segment) => segment === "" || segment === ".")
  ) {
    fail("SNAP_BAD_PATH", "malformed entry path");
  }
  if (path.normalize("NFC") !== path) {
    fail("SNAP_NON_NFC_PATH", "entry path is not in NFC");
  }
  return name;
}

/** Entry rules 1 to 10 on one 512-byte header block (not an end block). */
export function parseHeader(block: Uint8Array): TarHeader {
  const size = checkStructure(block);
  const type = entryType(block[156] as number);
  const name = cString(block, 0, 100);
  const prefix = cString(block, 345, 155);
  const raw = prefix.length === 0 ? name : concatBytes([prefix, Uint8Array.of(0x2f), name]);
  return { path: checkPath(raw, type), type, size };
}

/** Entry rules 11 to 14, which depend on the entries before. */
export class EntryRules {
  readonly #limits: Pick<Limits, "maxEntries" | "maxEntryBytes">;
  readonly #seen = new Set<string>();
  #sawFile = false;

  constructor(limits: Pick<Limits, "maxEntries" | "maxEntryBytes">) {
    this.#limits = limits;
  }

  check(header: TarHeader): void {
    if (this.#seen.size >= this.#limits.maxEntries) {
      throw new SnapError("SNAP_TOO_MANY_ENTRIES", "too many entries", header.path);
    }
    if (header.size > this.#limits.maxEntryBytes) {
      throw new SnapError("SNAP_ENTRY_TOO_LARGE", "entry above maxEntryBytes", header.path);
    }
    if (this.#seen.has(header.path)) {
      throw new SnapError("SNAP_DUPLICATE_PATH", "path seen twice", header.path);
    }
    this.#seen.add(header.path);
    if (header.type === "file" && !this.#sawFile) {
      this.#sawFile = true;
      if (header.path !== "manifest.json") {
        throw new SnapError(
          "SNAP_MISSING_MANIFEST",
          "the first file is not manifest.json",
          header.path,
        );
      }
    }
  }

  /** At the end blocks: an archive without any regular file has no manifest. */
  finish(): void {
    if (!this.#sawFile) {
      throw new SnapError("SNAP_MISSING_MANIFEST", "the archive has no manifest.json");
    }
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Pull-based reader over the decompressed chunks. */
class ByteReader {
  readonly #source: AsyncIterator<Uint8Array>;
  #chunk: Uint8Array = new Uint8Array(0);
  #ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#source = source[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    while (this.#chunk.length === 0 && !this.#ended) {
      const next = await this.#source.next();
      if (next.done) {
        this.#ended = true;
      } else {
        this.#chunk = next.value;
      }
    }
    return this.#chunk.length > 0;
  }

  /** Exactly `n` bytes, or `null` when the stream ends before the first one; ending later is SNAP_TRUNCATED. */
  async read(n: number): Promise<Uint8Array | null> {
    const parts: Uint8Array[] = [];
    let left = n;
    while (left > 0) {
      if (!(await this.#fill())) {
        if (left === n) {
          return null;
        }
        throw new SnapError("SNAP_TRUNCATED", "the tar stream ends inside a block");
      }
      const take = Math.min(left, this.#chunk.length);
      parts.push(this.#chunk.subarray(0, take));
      this.#chunk = this.#chunk.subarray(take);
      left -= take;
    }
    return parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts);
  }

  async readExact(n: number): Promise<Uint8Array> {
    const bytes = await this.read(n);
    if (bytes === null && n > 0) {
      throw new SnapError("SNAP_TRUNCATED", "the tar stream ends early");
    }
    return bytes ?? new Uint8Array(0);
  }

  /** Reads to the end; any non-zero byte is SNAP_TRAILING_DATA. */
  /** Stops the source (destroys the decompressor behind it). */
  async close(): Promise<void> {
    await this.#source.return?.();
  }

  async drainZeros(): Promise<void> {
    while (await this.#fill()) {
      if (this.#chunk.some((byte) => byte !== 0)) {
        throw new SnapError("SNAP_TRAILING_DATA", "non-zero bytes after the tar end blocks");
      }
      this.#chunk = new Uint8Array(0);
    }
  }
}

const isZeroBlock = (block: Uint8Array) => block.every((byte) => byte === 0);

/**
 * Streams the entries of a tar archive. Each header passes rules 1 to 14 and then `onHeader` (the validator's own
 * header checks) before its data is read; the entry is yielded with its data. After the two end blocks only zero bytes
 * may follow. Ending early anywhere is SNAP_TRUNCATED.
 */
export async function* readTar(
  source: AsyncIterable<Uint8Array>,
  limits: Pick<Limits, "maxEntries" | "maxEntryBytes">,
  onHeader: (header: TarHeader) => void = () => {},
): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source);
  const rules = new EntryRules(limits);
  try {
    for (;;) {
      const block = await reader.readExact(BLOCK);
      if (isZeroBlock(block)) {
        if (!isZeroBlock(await reader.readExact(BLOCK))) {
          tarInvalid("a single zero block inside the archive");
        }
        rules.finish();
        await reader.drainZeros();
        return;
      }
      const header = parseHeader(block);
      rules.check(header);
      onHeader(header);
      const data = await reader.readExact(header.size);
      await reader.readExact((BLOCK - (header.size % BLOCK)) % BLOCK);
      yield { header, data };
    }
  } finally {
    await reader.close();
  }
}

/** The writer's header for a regular file (section 2): mode 0644, uid and gid 0, mtime 0, the path in `name`. */
export function encodeHeader(path: string, size: number): Uint8Array {
  const name = utf8Encoder.encode(path);
  if (name.length > 100) {
    throw new RangeError("the path does not fit the ustar name field");
  }
  if (!Number.isSafeInteger(size) || size < 0 || size >= 8 ** 11) {
    throw new RangeError("the size does not fit the ustar size field");
  }
  const block = new Uint8Array(BLOCK);
  const put = (at: number, text: string) => block.set(utf8Encoder.encode(text), at);
  block.set(name, 0);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(156, "0");
  block.set(MAGIC, 257);
  block.set(VERSION, 263);
  block.fill(0x20, 148, 156);
  const sum = block.reduce((n, byte) => n + byte, 0);
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}
