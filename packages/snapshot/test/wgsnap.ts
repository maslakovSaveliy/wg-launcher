// Test-only builders of hostile and valid `.wgsnap` inputs: raw ustar headers with chosen fields, tar streams, real
// zstd frames (with and without the checksum) and helpers to catch SnapError codes. Written independently of
// src/container/ustar.ts (own field offsets), so a mistake in one shows up against the other. Node-only.
import { createHash } from "node:crypto";
import { constants, zstdCompressSync } from "node:zlib";
import type { SnapCode } from "@wg-launcher/shared";
import { computeContentHash } from "../src/container/content-hash.js";
import { canonicalJson } from "../src/container/jcs.js";
import { SnapError } from "../src/errors.js";

export const ascii = (s: string) => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface RawHeader {
  /** Raw bytes or text of the 100-byte name field (default: `path`). */
  name?: string | Uint8Array;
  prefix?: string | Uint8Array;
  typeflag?: string;
  /** The 100-byte linkname field (offset 157), for link entries. */
  linkname?: string;
  size?: number;
  /** The 12 raw bytes of the size field, replacing `size`. */
  sizeField?: string;
  magic?: string;
  version?: string;
  /** "auto" (default) computes the checksum; "bad" stores a wrong one; a string is stored as is. */
  checksum?: "auto" | "bad" | string;
}

const put = (block: Uint8Array, at: number, value: string | Uint8Array) =>
  block.set(typeof value === "string" ? ascii(value) : value, at);
const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;

/** One 512-byte ustar header. Offsets: POSIX.1-1988 ustar (name 0, mode 100, size 124, chksum 148, typeflag 156,
 * magic 257, version 263, prefix 345). */
export function rawHeader(path: string, fields: RawHeader = {}): Uint8Array {
  const block = new Uint8Array(512);
  put(block, 0, fields.name ?? path);
  put(block, 100, "0000644\0");
  put(block, 108, "0000000\0");
  put(block, 116, "0000000\0");
  put(block, 124, fields.sizeField ?? octal(fields.size ?? 0, 12));
  put(block, 136, "00000000000\0");
  put(block, 156, fields.typeflag ?? "0");
  if (fields.linkname !== undefined) {
    put(block, 157, fields.linkname);
  }
  put(block, 257, fields.magic ?? "ustar\0");
  put(block, 263, fields.version ?? "00");
  if (fields.prefix !== undefined) {
    put(block, 345, fields.prefix);
  }
  const checksum = fields.checksum ?? "auto";
  if (checksum === "auto" || checksum === "bad") {
    block.fill(0x20, 148, 156);
    let sum = block.reduce((n, b) => n + b, 0);
    if (checksum === "bad") {
      sum += 1;
    }
    put(block, 148, `${sum.toString(8).padStart(6, "0")}\0 `);
  } else {
    put(block, 148, checksum);
  }
  return block;
}

/** Entry data padded with zeros to a whole number of blocks. */
export function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

export interface TarFile {
  path: string;
  data?: Uint8Array;
  header?: RawHeader;
}

/** A tar stream: each file's header and padded data, then two zero blocks (unless `end` is false). */
export function tar(files: TarFile[], end = true): Uint8Array {
  const parts = files.flatMap((file) => {
    const data = file.data ?? new Uint8Array(0);
    return [rawHeader(file.path, { size: data.length, ...file.header }), padded(data)];
  });
  return concat(...parts, end ? new Uint8Array(1024) : new Uint8Array(0));
}

export interface ListedEntry {
  path: string;
  /** Offset of the header block in the tar stream. */
  headerAt: number;
  /** Offset of the first data byte. */
  dataAt: number;
  size: number;
}

/** The entries of a well-formed tar stream (name field only, octal sizes), up to the first zero block. */
export function listTar(tarBytes: Uint8Array): ListedEntry[] {
  const out: ListedEntry[] = [];
  const decoder = new TextDecoder();
  for (let at = 0; at + 512 <= tarBytes.length; ) {
    const block = tarBytes.subarray(at, at + 512);
    if (block.every((b) => b === 0)) {
      break;
    }
    const field = block.subarray(0, 100);
    const nul = field.indexOf(0);
    const size = Number.parseInt(decoder.decode(block.subarray(124, 135)), 8);
    out.push({
      path: decoder.decode(nul < 0 ? field : field.subarray(0, nul)),
      headerAt: at,
      dataAt: at + 512,
      size,
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export const zstd = (bytes: Uint8Array, checksum = true) =>
  new Uint8Array(
    zstdCompressSync(bytes, {
      params: checksum ? { [constants.ZSTD_c_checksumFlag]: 1 } : {},
    }),
  );

/** The bytes as an async source, in chunks of `size`. */
export async function* chunks(bytes: Uint8Array, size = 4096): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) {
    yield bytes.subarray(at, at + size);
  }
}

/** The SnapError code a promise rejects with, `undefined` if it resolves; other errors are rethrown. */
export async function codeOfAsync(run: () => Promise<unknown>): Promise<SnapCode | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SnapError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

export function codeOf(run: () => unknown): SnapCode | undefined {
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

/** The SnapError a promise rejects with. */
export async function errorOf(run: () => Promise<unknown>): Promise<SnapError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SnapError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a SnapError");
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface SnapFile {
  path: string;
  data: Uint8Array;
}

export const FIRST_PARTY = { origin: "http://localhost:4417", topLevelSite: null, role: "top" };

/** A valid manifest listing `files` (sorted by path); `edit` runs before `contentHash` is computed. */
export function manifestFor(
  files: SnapFile[],
  storageKeys: unknown[] = [FIRST_PARTY],
  edit: (m: Record<string, unknown>) => void = () => {},
): Record<string, unknown> {
  const m: Record<string, unknown> = {
    format: "wgsnap",
    formatVersion: 1,
    gameId: "0192f0a0-0000-7000-8000-000000000001",
    revisionId: "0192f0a0-0000-7000-8000-000000000002",
    parentRevisionId: null,
    createdAt: "2026-10-25T12:00:00.000Z",
    deviceId: "0192f0a0-0000-7000-8000-000000000003",
    exporter: { id: "generic", version: "1.0.0" },
    adapter: null,
    gameVersion: null,
    flushState: "unconfirmed",
    storageKeys,
    entries: [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({ path: f.path, size: f.data.length, sha256: sha256(f.data) })),
  };
  edit(m);
  m.contentHash = computeContentHash(m as never);
  return m;
}

export interface SnapshotOptions {
  storageKeys?: unknown[];
  /** Changes the manifest before its hash is computed. */
  edit?: (m: Record<string, unknown>) => void;
  /** Replaces the manifest text (after hashing). */
  manifestText?: (text: string) => string;
  /** Builds the tar entry list from the manifest entry and the files (default: manifest first, files sorted). */
  layout?: (manifest: TarFile, files: TarFile[]) => TarFile[];
  /** Bytes appended after the tar end blocks. */
  after?: Uint8Array;
}

/** The tar stream of a snapshot holding `files`. */
export function snapshotTar(files: SnapFile[], options: SnapshotOptions = {}): Uint8Array {
  const manifest = manifestFor(files, options.storageKeys, options.edit);
  const text = (options.manifestText ?? ((t) => t))(canonicalJson(manifest));
  const manifestFile: TarFile = { path: "manifest.json", data: ascii(text) };
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const layout = options.layout ?? ((first, rest) => [first, ...rest]);
  return concat(tar(layout(manifestFile, sorted)), options.after ?? new Uint8Array(0));
}

/** The compressed `.wgsnap` of `files`. */
export const snapshot = (files: SnapFile[], options: SnapshotOptions = {}) =>
  zstd(snapshotTar(files, options));
