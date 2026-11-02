// THROWAWAY spike helper (runtime-compat, Phase 1 Task 17): builds the packaged test-flavor launcher that H7 measures.
//
//   node build-launcher.mjs <output directory outside the repository>
//
// The test flavor accepts the spike server's `http://localhost` scene as a library entry (the prod flavor accepts
// https only) and carries the test hooks the timing runner drives through Playwright. It is packaged with the
// release config of apps/desktop (electron-builder.yml) minus three things: no fuses (Playwright's `_electron` connects
// through the Node inspector, which the release fuse `nodeCliInspect` turns off), no `wglauncher` scheme and its own app id and name, so this build
// never registers itself as the deep-link handler next to the real app. It overwrites `apps/desktop/out` with the test
// flavor (gitignored build output; rebuild before packaging the release app). Frame time of this build is assumed equal to
// a release build (same Electron 45.0.0 and Chromium); RESULTS.md labels it so. Signed ad hoc like `package:mac`.
// Prints the path of the .app.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const out = process.argv[2];
if (!out || !isAbsolute(out)) {
  console.error("usage: node build-launcher.mjs <absolute output directory outside the repository>");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "..", "..");
const inside = relative(repo, resolve(out));
// Outside means a path that leaves the repository (`..` or `../...`); the repository itself and anything below it are refused.
if (!(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))) {
  console.error("the output directory must be outside the repository");
  process.exit(2);
}
const desktop = join(repo, "apps", "desktop");
const PRODUCT = "WGLauncherTiming";

mkdirSync(out, { recursive: true });
const config = {
  appId: "io.github.maslakovsaveliy.wglauncher.timing",
  productName: PRODUCT,
  directories: { output: join(out, "dist"), buildResources: "build" },
  files: ["out/**", "package.json", "!node_modules/react/**", "!node_modules/react-dom/**", "!node_modules/scheduler/**", "!node_modules/@wg-launcher/**"],
  asar: true,
  afterPack: join(desktop, "build", "after-pack.mjs"),
  mac: { target: [{ target: "dir", arch: ["arm64"] }], identity: null, hardenedRuntime: false, notarize: false },
};
const configFile = join(out, "electron-builder.timing.json");
writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

const run = (command, args) => execFileSync(command, args, { cwd: desktop, stdio: "inherit" });
run("pnpm", ["exec", "electron-vite", "build", "--mode", "test"]);
run("pnpm", ["exec", "electron-builder", "--mac", "dir", "--config", configFile]);
const app = join(out, "dist", "mac-arm64", `${PRODUCT}.app`);
if (!existsSync(app)) {
  console.error(`no app at ${app}`);
  process.exit(1);
}
execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
console.log(app);
