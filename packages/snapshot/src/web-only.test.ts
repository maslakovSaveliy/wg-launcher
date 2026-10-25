import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The record layer runs in the quiescent preload as well as in the snapshot worker (snapshot-format.md section 6.1),
// so it may use only APIs that browsers and Node 24 share.
const srcDir = new URL("./", import.meta.url);
const webOnly = [
  "errors.ts",
  ...readdirSync(new URL("record/", srcDir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `record/${name}`),
];

describe("record layer uses Web APIs only", () => {
  it.each(webOnly)("%s imports nothing from node: and uses no Node-only global", (file) => {
    const source = readFileSync(new URL(file, srcDir), "utf8");
    expect(source).not.toMatch(/from\s+["']node:|import\(\s*["']node:|require\(/);
    expect(source).not.toMatch(/\b(?:Buffer|process|__dirname|__filename|setImmediate)\b/);
  });

  it("covers the four record modules and the errors", () => {
    expect(webOnly.sort()).toEqual([
      "errors.ts",
      "record/cbor.ts",
      "record/data-files.ts",
      "record/idb-key.ts",
      "record/value.ts",
    ]);
  });
});
