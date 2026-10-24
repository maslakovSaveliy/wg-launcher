// Build-time guard for the dependency rule (see "Dependency and license policy" in AGENTS.md).
//
// Everything bundled into or packaged with the app must be declared in `dependencies`; `devDependencies` hold
// build and test tooling only. The license gate (`check-licenses.mjs`) trusts that split, so this Vite/Rollup
// plugin fails the build when a module is loaded from `node_modules` and its package is not in `dependencies`.
// It is wired into the electron-vite config of `apps/desktop` (Phase 1, Task 5). It needs no Vite import: the
// plugin is a plain object with a Rollup `load` hook, so it can be unit-tested by calling the hook directly.

/**
 * The part of a `package.json` the guard reads.
 * @typedef {object} PackageJsonDependencies
 * @property {Record<string, string>} [dependencies]
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
 * A Rollup/Vite plugin that fails the build when a module from `node_modules` belongs to a package that is not
 * listed in the `dependencies` of `pkgJson`. A workspace package resolved through its pnpm symlink is allowed
 * when it is listed (`workspace:*`); when the bundler resolves it to its real path it is not in `node_modules`
 * at all and is not checked here. The `load` hook sees every module regardless of how it was resolved.
 * @param {PackageJsonDependencies} pkgJson
 * @returns {{ name: string, load: (this: unknown, id: string) => null }}
 */
export function prodDepsGuard(pkgJson) {
  const declared = new Set(Object.keys(pkgJson.dependencies ?? {}));
  return {
    name: "wg-prod-deps-guard",
    load(id) {
      const name = packageNameFromId(id);
      if (name !== null && !declared.has(name)) {
        throw new Error(
          `Dependency rule: "${name}" is bundled into the app but is not listed in "dependencies" of its package.json. ` +
            "Move it from devDependencies to dependencies (AGENTS.md, dependency and license policy).",
        );
      }
      return null;
    },
  };
}
