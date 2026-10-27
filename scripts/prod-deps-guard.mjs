// Build-time guard for the dependency rule (see "Dependency and license policy" in AGENTS.md).
//
// Everything bundled into or packaged with the app must be a production dependency: declared in `dependencies`,
// or a transitive dependency of one (the production closure, which is what `pnpm licenses list --prod` checks).
// `devDependencies` hold build and test tooling only. The license gate (`check-licenses.mjs`) trusts that split,
// so this Vite/Rolldown plugin fails the build when a module from `node_modules` enters the bundle and its package
// is not in the production closure.
// It is wired into all three electron-vite builds of `apps/desktop` (main, preload, renderer). It needs no Vite
// import: the plugin is a plain object with a `transform` hook, so it can be unit-tested by calling the hook directly.
// `transform` is a sequential hook: Rolldown and Vite call it for every module and every plugin. A `load` hook would
// not do: it is a "first" hook, so a plugin that loads a module before this one would hide that module from it.

import { execSync } from "node:child_process";

/**
 * The part of a `package.json` the guard reads (only to word the error).
 * @typedef {object} PackageJsonDependencies
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [devDependencies]
 */

/**
 * One node of `pnpm ls --json`: the dependencies below a project or a package.
 * @typedef {object} PnpmTreeNode
 * @property {Record<string, PnpmTreeNode>} [dependencies]
 * @property {Record<string, PnpmTreeNode>} [optionalDependencies]
 */

const SEGMENT = "node_modules/";

/**
 * The npm package a module id belongs to: the name after the last `node_modules/` segment, so pnpm's store
 * paths (`node_modules/.pnpm/react@19/node_modules/react/index.js`) and nested installs resolve to the package
 * that is actually imported. Scoped names keep their scope. Returns null for anything outside `node_modules`.
 * A Rollup/Vite id may carry a leading `\0` (virtual module), a `?query` and Windows separators; all are ignored.
 * @param {string} id
 * @returns {string | null}
 */
export function packageNameFromId(id) {
  const path = id
    .replace(/^\0/, "")
    .replace(/[?#].*$/, "")
    .replaceAll("\\", "/");
  // The segment must start a path component, so `not_node_modules/` does not count.
  const start = path.lastIndexOf(`/${SEGMENT}`) + 1;
  if (start === 0 && !path.startsWith(SEGMENT)) {
    return null;
  }
  const [first, second] = path.slice(start + SEGMENT.length).split("/");
  if (!first || first.startsWith(".")) {
    return null;
  }
  if (first.startsWith("@")) {
    return second ? `${first}/${second}` : null;
  }
  return first;
}

/**
 * Names of every package reachable from the production dependencies of the project(s) in the output of
 * `pnpm ls --prod --depth Infinity --json`: a list of projects, each with `dependencies` (and possibly
 * `optionalDependencies`) mapping a package name to a node of the same shape. Only names are kept: the output
 * also holds absolute paths, which are machine-specific and never printed. Shape checked with pnpm 12.15.0.
 * @param {string} output
 * @returns {Set<string>}
 */
export function parseProdClosure(output) {
  const projects = JSON.parse(output);
  if (!Array.isArray(projects)) {
    throw new TypeError("Expected a JSON array of projects from pnpm.");
  }
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {PnpmTreeNode | undefined} node */
  const visit = (node) => {
    for (const group of [node?.dependencies, node?.optionalDependencies]) {
      for (const [name, child] of Object.entries(group ?? {})) {
        names.add(name);
        visit(child);
      }
    }
  };
  for (const project of projects) {
    visit(project);
  }
  return names;
}

/**
 * The production closure of the package in `cwd` (the package whose build uses the guard).
 * @param {string} [cwd]
 * @returns {Set<string>}
 */
export function readProdClosure(cwd = process.cwd()) {
  // The command is a constant string: nothing user-controlled reaches the shell.
  const output = execSync("pnpm ls --prod --depth Infinity --json", {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return parseProdClosure(output);
}

/**
 * A Rollup/Vite plugin that fails the build when a module from `node_modules` belongs to a package that is not
 * in `prodClosure` (see `readProdClosure`). A workspace package resolved through its pnpm symlink is allowed
 * when it is in the closure; when the bundler resolves it to its real path it is not in `node_modules` at all
 * and is not checked here. The `transform` hook sees every module regardless of which plugin resolved or loaded
 * it. `pkgJson` only words the error: it says whether the package is declared in `devDependencies` or not declared
 * at all.
 * @param {PackageJsonDependencies} pkgJson
 * @param {ReadonlySet<string>} prodClosure
 *
 * `apply: "build"`: the guard checks what is bundled, so it stays out of the dev server, which serves its own
 * client (`vite/dist/client/client.mjs`, a devDependency) from `node_modules` and is never packaged.
 * @returns {{ name: string, apply: "build", transform: (this: unknown, code: string, id: string) => null }}
 */
export function prodDepsGuard(pkgJson, prodClosure) {
  const devOnly = new Set(Object.keys(pkgJson.devDependencies ?? {}));
  return {
    name: "wg-prod-deps-guard",
    apply: "build",
    transform(_code, id) {
      const name = packageNameFromId(id);
      if (name !== null && !prodClosure.has(name)) {
        const declared = devOnly.has(name)
          ? "it is declared only in devDependencies"
          : "it is not declared in dependencies or devDependencies";
        throw new Error(
          `Dependency rule: "${name}" is bundled into the app but is not a production dependency (${declared}). ` +
            "Move it to dependencies (AGENTS.md, dependency and license policy).",
        );
      }
      return null;
    },
  };
}
