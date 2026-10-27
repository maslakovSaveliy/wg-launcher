// Runner of the frozen golden vectors (snapshot-format.md section 10): `test-vectors/v1/index.json` lists the vector
// ids, each directory holds `vector.json`, `input.wgsnap` and, for a valid vector, `content.json`. A later Rust codec
// passes the same directory. Never edit the vectors to make this pass; they change only with a new formatVersion or a
// reviewed correction (scripts/generate-vectors.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Content, filesToContent, vectorInput, writeToBytes } from "../test/content.js";
import { chunks, codeOfAsync } from "../test/wgsnap.js";
import { type Limits, readEntries, resolveLimits, validateSnapshot } from "./container/index.js";

const V1 = fileURLToPath(new URL("../test-vectors/v1/", import.meta.url));
const INDEX = `${V1}index.json`;
const MEMBERS = ["description", "expect", "id", "input", "limits", "vectorFormat"];

interface VectorJson {
  vectorFormat: 1;
  id: string;
  description: string;
  input: string;
  limits: Partial<Limits>;
  expect: { ok: true; contentHash: string; content: string } | { ok: false; error: string };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const ids: string[] = existsSync(INDEX) ? (readJson(INDEX) as string[]) : [];

/** Checks the exact shape of `vector.json` (unknown members are an error) and returns it. */
function readVector(id: string): VectorJson {
  const vector = readJson(`${V1}${id}/vector.json`) as Record<string, unknown>;
  expect(Object.keys(vector).sort(), "vector.json members").toEqual(MEMBERS);
  expect(vector.vectorFormat).toBe(1);
  expect(vector.id).toBe(id);
  expect(vector.input).toBe("input.wgsnap");
  expect(typeof vector.description === "string" && vector.description.length > 0).toBe(true);
  expect(typeof vector.limits === "object" && vector.limits !== null).toBe(true);
  expect(() => resolveLimits(vector.limits as Partial<Limits>)).not.toThrow();
  const result = vector.expect as Record<string, unknown>;
  if (result.ok === true) {
    expect(Object.keys(result).sort(), "expect members").toEqual(["content", "contentHash", "ok"]);
    expect(result.content).toBe("content.json");
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  } else {
    expect(Object.keys(result).sort(), "expect members").toEqual(["error", "ok"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^SNAP_[A-Z_]+$/);
  }
  const expectedFiles = ["input.wgsnap", "vector.json", ...(result.ok ? ["content.json"] : [])];
  expect(readdirSync(`${V1}${id}`).sort(), "files of the vector directory").toEqual(
    expectedFiles.sort(),
  );
  return vector as unknown as VectorJson;
}

describe("golden vectors v1", () => {
  it("index.json lists exactly the vector directories", () => {
    expect(existsSync(INDEX), "test-vectors/v1/index.json exists").toBe(true);
    const index = readJson(INDEX);
    expect(Array.isArray(index) && index.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(ids).size, "no id listed twice").toBe(ids.length);
    const entries = readdirSync(V1, { withFileTypes: true });
    const directories = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const others = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
    expect(
      ids.filter((id) => !directories.includes(id)),
      "listed but missing",
    ).toEqual([]);
    expect(
      directories.filter((name) => !ids.includes(name)),
      "present but not listed",
    ).toEqual([]);
    expect(others, "only index.json beside the directories").toEqual(["index.json"]);
  });

  for (const id of ids) {
    it(id, async () => {
      const vector = readVector(id);
      const bytes = new Uint8Array(readFileSync(`${V1}${id}/${vector.input}`));
      // Ruling R11: the compressed size is the file size.
      const options = { compressedSize: bytes.length, limits: vector.limits };

      if (!vector.expect.ok) {
        // The code does not depend on chunking (spec section 2): the whole file at once and one byte at a time.
        for (const size of [bytes.length, 1]) {
          const code = await codeOfAsync(() => validateSnapshot(chunks(bytes, size), options));
          expect(code, `code with ${size}-byte chunks`).toBe(vector.expect.error);
        }
        return;
      }

      // Decoding: input.wgsnap gives content.json.
      const validated = await validateSnapshot(chunks(bytes), options);
      expect(validated.manifest.contentHash).toBe(vector.expect.contentHash);
      const files = new Map<string, Uint8Array>();
      for await (const entry of readEntries(chunks(bytes), validated.manifest, options)) {
        files.set(entry.path, entry.bytes);
      }
      const content = readJson(`${V1}${id}/${vector.expect.content}`) as Content;
      const decoded = JSON.parse(
        JSON.stringify(filesToContent(validated.manifest.storageKeys, files)),
      );
      expect(decoded).toStrictEqual(content);

      // Encoding: content.json gives the same entry paths, sizes, hashes and contentHash (not the same zstd bytes).
      const again = await writeToBytes(await vectorInput(content), vector.limits);
      const revalidated = await validateSnapshot(chunks(again), {
        compressedSize: again.length,
        limits: vector.limits,
      });
      expect(revalidated.manifest.entries).toStrictEqual(validated.manifest.entries);
      expect(revalidated.manifest.storageKeys).toStrictEqual(validated.manifest.storageKeys);
      expect(revalidated.manifest.contentHash).toBe(vector.expect.contentHash);
    });
  }
});
