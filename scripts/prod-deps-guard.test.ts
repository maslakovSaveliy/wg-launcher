import { describe, expect, it } from "vitest";
import { packageNameFromId, parseProdClosure, prodDepsGuard } from "./prod-deps-guard.mjs";

describe("packageNameFromId", () => {
  it.each([
    ["/repo/node_modules/react/index.js", "react"],
    ["/repo/node_modules/@scope/x/y.js", "@scope/x"],
    ["/repo/node_modules/react/node_modules/object-assign/index.js", "object-assign"],
    ["/repo/node_modules/.pnpm/react@19.3.1/node_modules/react/index.js", "react"],
    ["/repo/node_modules/.pnpm/@a+b@1.0.0/node_modules/@a/b/lib/x.js", "@a/b"],
    ["C:\\repo\\node_modules\\@scope\\x\\y.js", "@scope/x"],
    ["/repo/node_modules/react/index.js?v=abc123", "react"],
    ["\0/repo/node_modules/react/index.js?commonjs-proxy", "react"],
  ])("reads the package name from %j", (id, name) => {
    expect(packageNameFromId(id)).toBe(name);
  });

  it.each([
    "/repo/apps/desktop/src/main/index.ts",
    "/repo/packages/shared/src/index.ts",
    "/repo/not_node_modules/react/index.js",
    "/repo/node_modules/",
    "/repo/node_modules/@scope",
    "node:fs",
  ])("returns null for %j", (id) => {
    expect(packageNameFromId(id)).toBeNull();
  });
});

describe("prodDepsGuard", () => {
  const pkgJson = {
    dependencies: { "react-dom": "19.3.1", "@wg-launcher/shared": "workspace:*" },
    devDependencies: { react: "19.3.1", vitest: "5.0.5" },
  };
  // What `pnpm ls --prod --depth Infinity` reports for the package above: react-dom and its transitives.
  const prodClosure = new Set(["react-dom", "scheduler", "@wg-launcher/shared", "react"]);
  // `transform` runs for every module and every plugin (a sequential hook), unlike `load`, where the
  // first plugin that returns a value wins and later plugins never see the module.
  const check = (id: string, closure: ReadonlySet<string> = prodClosure) => {
    const plugin = prodDepsGuard(pkgJson, closure);
    return (plugin.transform as (code: string, id: string) => unknown).call({}, "export {}", id);
  };

  it("names itself", () => {
    expect(prodDepsGuard(pkgJson, prodClosure).name).toBe("wg-prod-deps-guard");
  });

  it("checks in the transform hook and has no load hook another plugin could pre-empt", () => {
    const plugin: Record<string, unknown> = prodDepsGuard(pkgJson, prodClosure);
    expect(typeof plugin.transform).toBe("function");
    expect(plugin.load).toBeUndefined();
  });

  it("allows a transitive dependency of a production dependency, also behind the pnpm store path", () => {
    expect(
      check("/repo/node_modules/.pnpm/react-dom@19.3.1/node_modules/scheduler/index.js"),
    ).toBeNull();
  });

  it("fails for a package declared only in devDependencies and outside the closure, naming it", () => {
    expect(() => check("/repo/node_modules/vitest/index.js")).toThrow(/"vitest".*devDependencies/);
  });

  it("allows a package that is a dev dependency and also in the production closure", () => {
    expect(check("/repo/node_modules/react/index.js")).toBeNull();
  });

  it("fails for an undeclared package outside the closure, naming it", () => {
    expect(() => check("/repo/node_modules/left-pad/index.js")).toThrow(/"left-pad".*not declared/);
  });

  it("handles scoped packages", () => {
    expect(() => check("/repo/node_modules/@scope/x/y.js")).toThrow(/"@scope\/x"/);
    expect(check("/repo/node_modules/@wg-launcher/shared/src/index.ts")).toBeNull();
  });

  it("fails for a workspace package that is not in the closure", () => {
    expect(() => check("/repo/node_modules/@wg-launcher/snapshot/src/index.ts")).toThrow(
      /"@wg-launcher\/snapshot"/,
    );
  });

  it("ignores modules outside node_modules (source files, real paths of workspace packages)", () => {
    expect(check("/repo/apps/desktop/src/main/index.ts")).toBeNull();
    expect(check("/repo/packages/shared/src/index.ts")).toBeNull();
  });

  it("treats a package.json without dependency lists as having none", () => {
    const plugin = prodDepsGuard({}, new Set());
    expect(() =>
      (plugin.transform as (code: string, id: string) => unknown).call(
        {},
        "export {}",
        "/r/node_modules/a/i.js",
      ),
    ).toThrow(/"a"/);
  });
});

describe("parseProdClosure", () => {
  // The shape of `pnpm ls --prod --depth Infinity --json` (pnpm 12.15.0), reduced to names and versions:
  // a list of projects, each with `dependencies` mapping a name to {from, version, dependencies?}.
  const output = JSON.stringify([
    {
      name: "@wg-launcher/desktop",
      version: "0.0.0",
      dependencies: {
        "@wg-launcher/shared": {
          from: "@wg-launcher/shared",
          version: "link:../../packages/shared",
        },
        "react-dom": {
          from: "react-dom",
          version: "19.3.1",
          dependencies: { scheduler: { from: "scheduler", version: "0.27.0" } },
        },
      },
      optionalDependencies: { fsevents: { from: "fsevents", version: "2.3.3" } },
      devDependencies: { vitest: { from: "vitest", version: "5.0.5" } },
    },
  ]);

  it("collects the names of production dependencies and their transitives, nothing else", () => {
    expect(parseProdClosure(output)).toEqual(
      new Set(["@wg-launcher/shared", "react-dom", "scheduler", "fsevents"]),
    );
  });

  it("is empty for a project without dependencies", () => {
    expect(parseProdClosure(JSON.stringify([{ name: "x", version: "0.0.0" }]))).toEqual(new Set());
  });

  it("rejects output that is not a list", () => {
    expect(() => parseProdClosure("{}")).toThrow(/array/i);
  });
});
