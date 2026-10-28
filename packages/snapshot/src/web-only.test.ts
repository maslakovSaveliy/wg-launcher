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

  it("covers the record modules and the errors", () => {
    expect(webOnly.sort()).toEqual([
      "errors.ts",
      "record/cbor.ts",
      "record/data-files.ts",
      "record/idb-key.ts",
      "record/value-build.ts",
      "record/value-check.ts",
      "record/value-export.ts",
      "record/value.ts",
    ]);
  });
});

// Ruling R10: the Node-only container is a separate package entry. Everything reachable from src/index.ts, the entry the
// quiescent preload bundles, must stay free of `node:` imports and of the container.
const IMPORT =
  /(?:import|export)\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importGraph(entry: URL): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const visit = (file: URL) => {
    if (graph.has(file.href)) {
      return;
    }
    const specifiers = [...readFileSync(file, "utf8").matchAll(IMPORT)].map(
      (m) => (m[1] ?? m[2]) as string,
    );
    graph.set(file.href, specifiers);
    for (const specifier of specifiers.filter((s) => s.startsWith("."))) {
      visit(new URL(specifier.replace(/\.js$/, ".ts"), file));
    }
  };
  visit(entry);
  return graph;
}

describe("the main package entry stays web-only (Ruling R10)", () => {
  const graph = importGraph(new URL("index.ts", srcDir));
  const files = [...graph.keys()].map((href) => href.slice(srcDir.href.length));

  it("reaches the record layer and the errors, never the container", () => {
    expect(files.sort()).toEqual([
      "errors.ts",
      "index.ts",
      "record/cbor.ts",
      "record/data-files.ts",
      "record/idb-key.ts",
      "record/value-build.ts",
      "record/value-check.ts",
      "record/value-export.ts",
      "record/value.ts",
    ]);
  });

  it("has no node: import anywhere in its import graph, side-effect imports included", () => {
    const specifiers = [...graph.values()].flat();
    expect(specifiers.filter((s) => s.startsWith("node:"))).toEqual([]);
    expect(specifiers.filter((s) => s.includes("container"))).toEqual([]);
  });

  it("finds a side-effect node: import with the same pattern", () => {
    expect(
      [...'import "node:zlib";\nexport * from "./x.js";'.matchAll(IMPORT)].map((m) => m[1]),
    ).toEqual(["node:zlib", "./x.js"]);
  });
});
