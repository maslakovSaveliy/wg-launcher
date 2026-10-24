import { describe, expect, it } from "vitest";
import { packageNameFromId, prodDepsGuard } from "./prod-deps-guard.mjs";

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
    dependencies: { zod: "4.6.7", "@wg-launcher/shared": "workspace:*" },
    devDependencies: { react: "19.3.1", vitest: "5.0.5" },
  };
  const load = (id: string) => {
    const plugin = prodDepsGuard(pkgJson);
    return (plugin.load as (id: string) => unknown).call({}, id);
  };

  it("names itself", () => {
    expect(prodDepsGuard(pkgJson).name).toBe("wg-prod-deps-guard");
  });

  it("fails the build for a package that is only in devDependencies, naming it", () => {
    expect(() => load("/repo/node_modules/react/index.js")).toThrow(/"react"/);
  });

  it("fails for a package that is in neither list", () => {
    expect(() => load("/repo/node_modules/left-pad/index.js")).toThrow(/"left-pad"/);
  });

  it("handles scoped packages", () => {
    expect(() => load("/repo/node_modules/@scope/x/y.js")).toThrow(/"@scope\/x"/);
    expect(load("/repo/node_modules/@wg-launcher/shared/src/index.ts")).toBeNull();
  });

  it("allows a package listed in dependencies, also behind the pnpm store path", () => {
    expect(load("/repo/node_modules/zod/index.js")).toBeNull();
    expect(load("/repo/node_modules/.pnpm/zod@4.6.7/node_modules/zod/index.js")).toBeNull();
  });

  it("allows a workspace package resolved through its symlink when it is listed", () => {
    expect(load("/repo/node_modules/@wg-launcher/shared/src/ids.ts")).toBeNull();
  });

  it("fails for a workspace package that is not listed", () => {
    expect(() => load("/repo/node_modules/@wg-launcher/snapshot/src/index.ts")).toThrow(
      /"@wg-launcher\/snapshot"/,
    );
  });

  it("ignores modules outside node_modules (source files, real paths of workspace packages)", () => {
    expect(load("/repo/apps/desktop/src/main/index.ts")).toBeNull();
    expect(load("/repo/packages/shared/src/index.ts")).toBeNull();
  });

  it("treats a package.json without dependencies as having none", () => {
    const plugin = prodDepsGuard({});
    expect(() =>
      (plugin.load as (id: string) => unknown).call({}, "/r/node_modules/a/i.js"),
    ).toThrow(/"a"/);
  });
});
