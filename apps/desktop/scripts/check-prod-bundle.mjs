// Builds the prod and the test flavor into temporary directories and checks that the test hooks are compiled out
// of prod: the name of their global, `__wgTest`, must appear in no prod output file and must appear in the test
// output (the control, so this check cannot pass by building nothing). The full release check of the packaged app
// (fuses, Info.plist) is Phase 1 Task 16.
//
//   node scripts/check-prod-bundle.mjs

import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const APP_DIR = join(import.meta.dirname, "..");
const MARKER = "__wgTest";

/** @param {string} dir @returns {Promise<string[]>} */
async function filesUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** @param {string} mode @param {string} outDir */
function build(mode, outDir) {
  // Constant arguments only; the output directory is our own, new temporary directory. The output is shown only
  // when the build fails (a successful build warns that an outDir outside the project is not emptied).
  try {
    execFileSync("pnpm", ["exec", "electron-vite", "build", "--mode", mode, "--outDir", outDir], {
      cwd: APP_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const { stdout = "", stderr = "" } = /** @type {{ stdout?: string, stderr?: string }} */ (
      error
    );
    console.error(stdout, stderr);
    throw new Error(`The ${mode} build failed.`);
  }
}

/** @param {string} dir @returns {Promise<string[]>} the files (relative to dir) that contain the marker */
async function filesWithMarker(dir) {
  const hits = [];
  for (const file of await filesUnder(dir)) {
    if ((await readFile(file, "utf8")).includes(MARKER)) hits.push(relative(dir, file));
  }
  return hits;
}

/**
 * Workspace packages are TypeScript source that Electron cannot load, so no built main file may import one by name
 * (electron-vite externalizes `dependencies` unless the config bundles the package).
 * @param {string} dir @returns {Promise<string[]>}
 */
async function filesImportingWorkspacePackages(dir) {
  const hits = [];
  for (const file of await filesUnder(dir)) {
    if (!file.endsWith(".js") && !file.endsWith(".cjs")) continue;
    if (/(?:from|import\()\s*["']@wg-launcher\//.test(await readFile(file, "utf8"))) {
      hits.push(relative(dir, file));
    }
  }
  return hits;
}

const work = await mkdtemp(join(tmpdir(), "wg-bundle-check-"));
try {
  const prodDir = join(work, "prod");
  const testDir = join(work, "test");
  build("production", prodDir);
  build("test", testDir);

  const prodFiles = await filesUnder(prodDir);
  if (!prodFiles.some((file) => file.endsWith(join("main", "index.js")))) {
    throw new Error("The prod build produced no main/index.js.");
  }
  const prodHits = await filesWithMarker(prodDir);
  const testHits = await filesWithMarker(testDir);
  if (testHits.length === 0) {
    throw new Error(`Control failed: the test build does not contain ${MARKER}.`);
  }
  if (prodHits.length > 0) {
    throw new Error(`The prod build contains ${MARKER} in: ${prodHits.join(", ")}`);
  }
  for (const { name, dir } of [
    { name: "prod", dir: prodDir },
    { name: "test", dir: testDir },
  ]) {
    const imports = await filesImportingWorkspacePackages(dir);
    if (imports.length > 0) {
      throw new Error(
        `The ${name} build imports a workspace package by name (it must be bundled): ${imports.join(", ")}`,
      );
    }
  }
  console.log(
    `OK: ${MARKER} is in ${testHits.length} test-build file(s) and in none of ${prodFiles.length} prod-build files.`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
