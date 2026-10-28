import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "./index.js";
import { AdapterError, adapterScope, parseAdapter } from "./schema.js";

const progressLab = JSON.parse(
  readFileSync(new URL("./progress-lab.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** A copy of the progress-lab adapter with the member at `path` set to `value` (removed when `value` is undefined). */
function variant(path: string[], value: unknown): unknown {
  const copy = structuredClone(progressLab);
  let at: Record<string, unknown> = copy;
  for (const name of path.slice(0, -1)) {
    at = at[name] as Record<string, unknown>;
  }
  const last = path.at(-1) as string;
  if (value === undefined) {
    delete at[last];
  } else {
    at[last] = value;
  }
  return copy;
}

function refused(json: unknown): AdapterError {
  try {
    parseAdapter(json);
  } catch (error) {
    if (error instanceof AdapterError) {
      return error;
    }
    throw error;
  }
  throw new Error("parsed without error");
}

const idbfs = { hook: "emscripten-idbfs", module: "Module", timeoutMs: 30_000 };

describe("adapter schema (save-transfer.md section 8)", () => {
  it("accepts the bundled progress-lab adapter exactly as the spec's example, also at load", () => {
    expect(parseAdapter(progressLab)).toEqual(progressLab);
    expect(ADAPTERS.map((a) => `${a.id}@${a.version}`)).toEqual(["progress-lab@1.0.0"]);
    expect(adapterScope(parseAdapter(progressLab))).toEqual({
      localStorage: { include: ["progress-lab:"], exclude: [] },
      indexedDB: { include: ["progress-lab", "/home/web_user"], exclude: [] },
    });
  });

  it("accepts an emscripten-idbfs hook and defaults its module to Module", () => {
    expect(parseAdapter(variant(["flush"], idbfs)).flush).toEqual(idbfs);
    const noModule = variant(["flush"], { hook: "emscripten-idbfs", timeoutMs: 100 });
    expect(parseAdapter(noModule).flush).toEqual({ ...idbfs, timeoutMs: 100 });
  });

  it.each([
    ["an unknown top-level member", ["code"], "alert(1)"],
    ["an unknown nested member", ["storage", "localStorage", "regex"], true],
    ["an unknown member in match", ["match", "pattern"], "*"],
    ["an unknown member of the flush hook", ["flush", "script"], "x"],
    [
      "an unknown member of a frame key",
      ["storage", "frameKeys"],
      [{ origin: "https://a.example", topLevelSite: "https://b.example", role: "frame" }],
    ],
    ["a missing member", ["storage", "indexedDB"], undefined],
    ["another adapterFormat", ["adapterFormat"], 2],
    ["a wrong type", ["storage", "localStorage", "include"], "progress-lab:"],
    ["a number in a list", ["storage", "indexedDB", "exclude"], [1]],
    ["an id with capitals", ["id"], "Progress-Lab"],
    ["an id of 65 characters", ["id"], "a".repeat(65)],
    ["an empty id", ["id"], ""],
    ["a version that is not SemVer", ["version"], "1.0"],
    ["a version of 257 characters", ["version"], `1.0.0-${"a".repeat(251)}`],
    ["a string of 257 characters", ["storage", "localStorage", "include"], ["x".repeat(257)]],
    [
      "65 items in a list",
      ["storage", "indexedDB", "include"],
      Array.from({ length: 65 }, (_, i) => `db${i}`),
    ],
    [
      "65 origins",
      ["match", "origins"],
      Array.from({ length: 65 }, (_, i) => `https://g${i}.example`),
    ],
    ["no origin", ["match", "origins"], []],
    ["an origin with a path", ["match", "origins"], ["http://localhost:4317/"]],
    ["an origin that is not http(s)", ["match", "origins"], ["file:///game"]],
    ["an origin with upper case", ["match", "origins"], ["http://LOCALHOST:4317"]],
    [
      "a top-level site with a port",
      ["storage", "frameKeys"],
      [{ origin: "https://a.example", topLevelSite: "https://b.example:8443" }],
    ],
    ["an unknown hook", ["flush"], { hook: "custom" }],
    ["a module that is code", ["flush"], { ...idbfs, module: "Module);alert(1" }],
    ["a module with a dot", ["flush"], { ...idbfs, module: "window.Module" }],
    ["a module starting with a digit", ["flush"], { ...idbfs, module: "1Module" }],
    ["a module of 65 characters", ["flush"], { ...idbfs, module: `M${"a".repeat(64)}` }],
    ["a timeout above 30 000 ms", ["flush"], { ...idbfs, timeoutMs: 30_001 }],
    ["a timeout that is not an integer", ["flush"], { ...idbfs, timeoutMs: 1.5 }],
    ["a zero timeout", ["flush"], { ...idbfs, timeoutMs: 0 }],
    ["a none hook with a module", ["flush"], { hook: "none", module: "Module" }],
  ])("refuses %s", (_name, path, value) => {
    expect(refused(variant(path, value)).message).toMatch(/^invalid adapter/);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "{}"],
  ])("refuses %s", (_name, json) => {
    expect(refused(json)).toBeInstanceOf(AdapterError);
  });

  it("keeps regular-expression-looking selectors as plain strings", () => {
    const adapter = parseAdapter(
      variant(["storage", "localStorage", "include"], ["a.*", "(x+)+$"]),
    );
    expect(adapter.storage.localStorage.include).toEqual(["a.*", "(x+)+$"]);
  });

  it("accepts 64 items and 256 characters", () => {
    const adapter = parseAdapter(
      variant(
        ["storage", "indexedDB", "include"],
        Array.from({ length: 64 }, () => "d".repeat(256)),
      ),
    );
    expect(adapter.storage.indexedDB.include).toHaveLength(64);
  });
});
