import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The exporter runs in the quiescent window's sandboxed preload, in an isolated world (save-transfer.md section 3):
// Web APIs only, and never the Node-only snapshot container.
const srcDir = new URL("./", import.meta.url);
const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

describe("the exporter package uses Web APIs only", () => {
  it.each(sources)(
    "%s imports nothing from node: or the container and uses no Node global",
    (file) => {
      const source = readFileSync(new URL(file, srcDir), "utf8");
      expect(source).not.toMatch(/from\s+["']node:|import\(\s*["']node:|require\(/);
      expect(source).not.toMatch(/@wg-launcher\/snapshot\/container/);
      expect(source).not.toMatch(/\b(?:Buffer|process|__dirname|__filename|setImmediate)\b/);
    },
  );

  it("checks every source module", () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
    expect(sources).toContain("frame-exporter.ts");
    expect(sources).toContain("frame-importer.ts");
  });
});
