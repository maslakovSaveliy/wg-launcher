import { describe, expect, it } from "vitest";
import {
  ascii,
  chunks,
  codeOf,
  codeOfAsync,
  concat,
  errorOf,
  padded,
  rawHeader,
  tar,
} from "../../test/wgsnap.js";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.js";
import { EntryRules, encodeHeader, parseHeader, readTar, type TarHeader } from "./ustar.js";

const MANIFEST = { path: "manifest.json", data: ascii("{}") };

async function collect(bytes: Uint8Array, limits = DEFAULT_LIMITS, size = 512) {
  const out: { header: TarHeader; data: Uint8Array }[] = [];
  for await (const entry of readTar(chunks(bytes, size), limits)) {
    out.push(entry);
  }
  return out;
}

describe("parseHeader: entry rules 1 to 10 (snapshot-format.md section 3.1)", () => {
  it("reads a regular file and a directory", () => {
    expect(parseHeader(rawHeader("data/0/local-storage.cbor", { size: 513 }))).toEqual({
      path: "data/0/local-storage.cbor",
      type: "file",
      size: 513,
    });
    expect(parseHeader(rawHeader("data/0/", { typeflag: "5" }))).toEqual({
      path: "data/0",
      type: "directory",
      size: 0,
    });
    expect(parseHeader(rawHeader("blobs", { typeflag: "\0" })).type).toBe("file");
  });

  it("joins prefix and name with a slash", () => {
    const header = rawHeader("", { prefix: "data/0/idb", name: "0/schema.cbor" });
    expect(parseHeader(header).path).toBe("data/0/idb/0/schema.cbor");
  });

  it("accepts octal fields padded with NUL or spaces and a 12-digit size without terminator", () => {
    expect(parseHeader(rawHeader("a", { sizeField: "17 \0\0\0\0\0\0\0\0\0" })).size).toBe(15);
    expect(parseHeader(rawHeader("a", { sizeField: "000000000017" })).size).toBe(15);
  });

  it.each([
    ["a bad checksum", { checksum: "bad" }],
    ["a checksum that is not octal", { checksum: "abc\0    " }],
    ["the old GNU magic", { magic: "ustar ", version: " \0" }],
    ["version 01", { version: "01" }],
    ["a size with a non-octal digit", { sizeField: "00000000008\0" }],
    ["a base-256 size", { sizeField: "\x80\0\0\0\0\0\0\0\0\0\0\x10" }],
    ["a size with a leading space", { sizeField: " 0000000017\0" }],
    ["an empty size field", { sizeField: "\0\0\0\0\0\0\0\0\0\0\0\0" }],
  ] as const)("rule 1: %s is SNAP_TAR_INVALID", (_, fields) => {
    expect(codeOf(() => parseHeader(rawHeader("a", fields)))).toBe("SNAP_TAR_INVALID");
  });

  it("rule 2: a symbolic link is SNAP_SYMLINK", () => {
    expect(codeOf(() => parseHeader(rawHeader("a", { typeflag: "2" })))).toBe("SNAP_SYMLINK");
  });

  it("rule 3: a hard link is SNAP_HARDLINK", () => {
    expect(codeOf(() => parseHeader(rawHeader("a", { typeflag: "1" })))).toBe("SNAP_HARDLINK");
  });

  it.each(["3", "4", "6"])("rule 4: typeflag %s is SNAP_DEVICE", (typeflag) => {
    expect(codeOf(() => parseHeader(rawHeader("a", { typeflag })))).toBe("SNAP_DEVICE");
  });

  it.each(["x", "g", "L", "K", "S", "7", "A", "9"])(
    "rule 5: typeflag %s is SNAP_UNSUPPORTED_ENTRY_TYPE",
    (typeflag) => {
      expect(codeOf(() => parseHeader(rawHeader("a", { typeflag })))).toBe(
        "SNAP_UNSUPPORTED_ENTRY_TYPE",
      );
    },
  );

  it("rule 6: a path that is not UTF-8 is SNAP_BAD_PATH_ENCODING", () => {
    const name = Uint8Array.from([0x61, 0xc3, 0x28]);
    expect(codeOf(() => parseHeader(rawHeader("", { name })))).toBe("SNAP_BAD_PATH_ENCODING");
  });

  it.each(["/etc/escape", "\\x", "C:x", "c:/x"])("rule 7: %s is SNAP_ABSOLUTE_PATH", (path) => {
    expect(codeOf(() => parseHeader(rawHeader(path)))).toBe("SNAP_ABSOLUTE_PATH");
  });

  it.each(["../escape.txt", "data/../x", "data/..", "a/../../b"])(
    "rule 8: %s is SNAP_PATH_TRAVERSAL",
    (path) => {
      expect(codeOf(() => parseHeader(rawHeader(path)))).toBe("SNAP_PATH_TRAVERSAL");
    },
  );

  it.each([
    ["a backslash", "data\\0"],
    ["a control character", "data/\x01"],
    ["DEL", "data/\x7f"],
    ["an empty segment", "data//0"],
    ["an empty path", ""],
    ["a . segment", "data/./0"],
    ["a trailing / on a file", "data/0/"],
    ["a dot-dot inside a name, kept with a backslash", "..\\x"],
  ])("rule 9: %s is SNAP_BAD_PATH", (_, path) => {
    expect(codeOf(() => parseHeader(rawHeader(path)))).toBe("SNAP_BAD_PATH");
  });

  it("rule 9: a directory may end in one slash, not two", () => {
    expect(parseHeader(rawHeader("data/", { typeflag: "5" })).path).toBe("data");
    expect(codeOf(() => parseHeader(rawHeader("data//", { typeflag: "5" })))).toBe("SNAP_BAD_PATH");
  });

  it("rule 9: at most 255 bytes", () => {
    const at255 = rawHeader("", { prefix: "p".repeat(154), name: "n".repeat(100) });
    expect(parseHeader(at255).path).toHaveLength(255);
    const at256 = rawHeader("", { prefix: "p".repeat(155), name: "n".repeat(100) });
    expect(codeOf(() => parseHeader(at256))).toBe("SNAP_BAD_PATH");
  });

  it("rule 10: a decomposed path is SNAP_NON_NFC_PATH", () => {
    expect(codeOf(() => parseHeader(rawHeader("data/cafe\u0301")))).toBe("SNAP_NON_NFC_PATH");
    expect(parseHeader(rawHeader("data/caf\u00e9")).path).toBe("data/caf\u00e9");
  });

  it("checks the rules in order: a symlink with a traversal path is SNAP_SYMLINK", () => {
    expect(codeOf(() => parseHeader(rawHeader("../x", { typeflag: "2" })))).toBe("SNAP_SYMLINK");
    expect(codeOf(() => parseHeader(rawHeader("/../x")))).toBe("SNAP_ABSOLUTE_PATH");
    expect(codeOf(() => parseHeader(rawHeader("../a\\b")))).toBe("SNAP_PATH_TRAVERSAL");
  });
});

describe("EntryRules: entry rules 11 to 14", () => {
  const file = (path: string, size = 0): TarHeader => ({ path, type: "file", size });
  const dir = (path: string): TarHeader => ({ path, type: "directory", size: 0 });

  it("rule 11: more than maxEntries entries, directories included, is SNAP_TOO_MANY_ENTRIES", () => {
    const rules = new EntryRules(resolveLimits({ maxEntries: 2 }));
    rules.check(dir("data"));
    rules.check(file("manifest.json"));
    expect(codeOf(() => rules.check(file("data/x")))).toBe("SNAP_TOO_MANY_ENTRIES");
  });

  it("rule 12: a size above maxEntryBytes is SNAP_ENTRY_TOO_LARGE", () => {
    const rules = new EntryRules(resolveLimits({ maxEntryBytes: 10 }));
    rules.check(file("manifest.json", 10));
    expect(codeOf(() => rules.check(file("data/x", 11)))).toBe("SNAP_ENTRY_TOO_LARGE");
  });

  it("rule 13: a path seen twice, or a file and a directory with one path, is SNAP_DUPLICATE_PATH", () => {
    const rules = new EntryRules(DEFAULT_LIMITS);
    rules.check(file("manifest.json"));
    rules.check(file("data/a"));
    expect(codeOf(() => rules.check(file("data/a")))).toBe("SNAP_DUPLICATE_PATH");
    rules.check(dir("blobs"));
    expect(codeOf(() => rules.check(file("blobs")))).toBe("SNAP_DUPLICATE_PATH");
  });

  it("rule 14: the first regular file must be manifest.json; directories may come before it", () => {
    const rules = new EntryRules(DEFAULT_LIMITS);
    rules.check(dir("data"));
    expect(codeOf(() => rules.check(file("data/0/local-storage.cbor")))).toBe(
      "SNAP_MISSING_MANIFEST",
    );
    const empty = new EntryRules(DEFAULT_LIMITS);
    expect(codeOf(() => empty.finish())).toBe("SNAP_MISSING_MANIFEST");
  });
});

describe("readTar", () => {
  it("yields entries with their data and accepts zero padding after the end blocks", async () => {
    const data = ascii("x".repeat(600));
    const bytes = concat(tar([MANIFEST, { path: "data/a", data }]), new Uint8Array(4096));
    const entries = await collect(bytes);
    expect(entries.map((e) => [e.header.path, e.data.length])).toEqual([
      ["manifest.json", 2],
      ["data/a", 600],
    ]);
    expect(entries[1]?.data).toEqual(data);
    expect(await collect(bytes, DEFAULT_LIMITS, 7)).toHaveLength(2);
  });

  it("refuses non-zero bytes after the end blocks as SNAP_TRAILING_DATA", async () => {
    const bytes = concat(tar([MANIFEST]), new Uint8Array(100), Uint8Array.of(1));
    expect(await codeOfAsync(() => collect(bytes))).toBe("SNAP_TRAILING_DATA");
  });

  it("refuses a lone zero block followed by a header as SNAP_TAR_INVALID", async () => {
    const bytes = concat(tar([MANIFEST], false), new Uint8Array(512), tar([{ path: "data/a" }]));
    expect(await codeOfAsync(() => collect(bytes))).toBe("SNAP_TAR_INVALID");
  });

  it.each([
    // Blocks: 0 manifest header, 1 manifest data, 2 data/a header, 3-4 its 600 bytes and padding, 5-6 end blocks.
    ["inside a header", (b: Uint8Array) => b.subarray(0, 512 * 2 + 100)],
    ["inside entry data", (b: Uint8Array) => b.subarray(0, 512 * 3 + 100)],
    ["inside the data padding", (b: Uint8Array) => b.subarray(0, 512 * 5 - 1)],
    ["before the end blocks", (b: Uint8Array) => b.subarray(0, 512 * 5)],
    ["between the end blocks", (b: Uint8Array) => b.subarray(0, 512 * 6)],
  ])("reports SNAP_TRUNCATED when the stream ends %s", async (_, cut) => {
    const bytes = tar([MANIFEST, { path: "data/a", data: ascii("y".repeat(600)) }]);
    expect(await codeOfAsync(() => collect(cut(bytes)))).toBe("SNAP_TRUNCATED");
  });

  it("refuses an archive without files as SNAP_MISSING_MANIFEST", async () => {
    expect(await codeOfAsync(() => collect(tar([])))).toBe("SNAP_MISSING_MANIFEST");
    expect(await codeOfAsync(() => collect(new Uint8Array(0)))).toBe("SNAP_TRUNCATED");
  });

  it("checks a header before reading its data: an oversize entry fails without its bytes", async () => {
    // The header claims 1 GiB; the stream has none of it, so reading would give SNAP_TRUNCATED.
    const bytes = concat(tar([MANIFEST], false), rawHeader("data/a", { size: 2 ** 30 }));
    expect(await codeOfAsync(() => collect(bytes, resolveLimits({ maxEntryBytes: 2 ** 20 })))).toBe(
      "SNAP_ENTRY_TOO_LARGE",
    );
  });

  it("calls onHeader after the entry rules and before the data is read", async () => {
    const bytes = tar([MANIFEST, { path: "data/a", data: ascii("z") }]);
    const seen: string[] = [];
    const reader = readTar(chunks(bytes), DEFAULT_LIMITS, (header) => {
      seen.push(header.path);
      if (header.path === "data/a") {
        throw new Error("stop");
      }
    });
    await expect(async () => {
      for await (const entry of reader) {
        seen.push(`data:${entry.header.path}`);
      }
    }).rejects.toThrow("stop");
    expect(seen).toEqual(["manifest.json", "data:manifest.json", "data/a"]);
  });

  it("carries the entry path on errors, never data", async () => {
    const bytes = tar([MANIFEST, { path: "../escape.txt", data: ascii("secret") }]);
    const error = await errorOf(() => collect(bytes));
    expect(error.code).toBe("SNAP_PATH_TRAVERSAL");
    expect(error.path).toBe("../escape.txt");
    expect(error.message).not.toContain("secret");
  });
});

describe("encodeHeader", () => {
  it("writes a header that parseHeader reads back, with the writer's fixed fields", () => {
    const header = encodeHeader("data/0/local-storage.cbor", 1234);
    expect(header).toHaveLength(512);
    expect(parseHeader(header)).toEqual({
      path: "data/0/local-storage.cbor",
      type: "file",
      size: 1234,
    });
    // Same bytes as the independent test builder: mode 0644, uid/gid 0, mtime 0, typeflag 0, empty prefix.
    expect(header).toEqual(rawHeader("data/0/local-storage.cbor", { size: 1234 }));
  });

  it("refuses a path that does not fit the 100-byte name field", () => {
    expect(() => encodeHeader("x".repeat(101), 0)).toThrow(RangeError);
  });

  it("pads data like the test builder", () => {
    expect(padded(ascii("a"))).toHaveLength(512);
  });
});
