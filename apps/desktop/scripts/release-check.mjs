// The release check of the packaged app on macOS, Windows or Linux (security.md sections 4 and 5, S-14): the fuse wire
// must be exactly the specified one (a fuse a newer Electron adds is reported, so it gets a decision); on macOS,
// Info.plist must carry no media or Bluetooth usage description and must register the `wglauncher` scheme; app.asar
// must hold the built app,
// no test hooks (`__wgTest`) and none of the packages the build already bundles (React into the renderer, the
// workspace packages into main), so nothing ships twice outside the license gate's view.
//
//   node scripts/release-check.mjs <WGLauncher.app | win-unpacked | linux-unpacked>

import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const ON = 49;
const OFF = 48;

/** Position in the fuse wire (Electron 45, wire version 1), name, required state. */
const EXPECTED_FUSES = /** @type {const} */ ([
  [0, "runAsNode", OFF],
  [1, "cookieEncryption", ON],
  [2, "nodeOptions", OFF],
  [3, "nodeCliInspect", OFF],
  [4, "embeddedAsarIntegrityValidation", ON],
  [5, "onlyLoadAppFromAsar", ON],
  [6, "loadBrowserProcessSpecificV8Snapshot", OFF],
  [7, "grantFileProtocolExtraPrivileges", OFF],
  [8, "wasmTrapHandlers", ON],
]);

/** Usage descriptions the prebuilt Electron 45 Info.plist ships; the launcher must not (security.md section 5). */
const FORBIDDEN_USAGE_KEYS = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

const SCHEME = "wglauncher";
const MARKER = "__wgTest";
const MAIN_ENTRY = "/out/main/index.js";
/** Bundled by the build, so a packaged copy, at any depth, would ship twice. */
const BUNDLED = /\/node_modules\/(?:react|react-dom|scheduler|@wg-launcher\/[^/]+)(?:\/|$)/;
/** Loaded by main at run time (electron-vite keeps `dependencies` external), so they must be packaged. */
const REQUIRED = ["tldts", "tldts-core", "zod"].map((name) => `/node_modules/${name}/package.json`);

/** @param {number} state */
const word = (state) => (state === ON ? "on" : state === OFF ? "off" : `state ${state}`);

/**
 * @param {Record<string, number | string>} wire what `getCurrentFuseWire` returns
 * @returns {string[]} problems
 */
export function checkFuses(wire) {
  if (wire.version !== "1") return [`fuse wire version ${wire.version}, expected 1`];
  const problems = [];
  for (const [position, name, expected] of EXPECTED_FUSES) {
    const state = wire[position];
    if (state === undefined) problems.push(`fuse ${name} is missing`);
    else if (state !== expected) {
      problems.push(`fuse ${name} is ${word(Number(state))}, expected ${word(expected)}`);
    }
  }
  for (const key of Object.keys(wire)) {
    if (key !== "version" && Number(key) >= EXPECTED_FUSES.length) {
      problems.push(`unknown fuse at position ${key}`);
    }
  }
  return problems;
}

/**
 * @param {Record<string, unknown>} plist Info.plist as JSON
 * @returns {string[]} problems
 */
export function checkInfoPlist(plist) {
  const problems = FORBIDDEN_USAGE_KEYS.filter((key) => key in plist).map(
    (key) => `Info.plist has ${key}`,
  );
  const types = Array.isArray(plist.CFBundleURLTypes) ? plist.CFBundleURLTypes : [];
  const registered = types.some(
    (type) =>
      typeof type === "object" &&
      type !== null &&
      Array.isArray(type.CFBundleURLSchemes) &&
      type.CFBundleURLSchemes.includes(SCHEME),
  );
  if (!registered) problems.push(`Info.plist registers no ${SCHEME} URL scheme`);
  return problems;
}

/**
 * @param {readonly { path: string, kind: "file" | "directory" | "link" }[]} entries every entry of the archive, each
 *   path starting with the separator ("/", or "\\" on Windows), its kind from the archive's header
 * @param {(path: string) => string} contentOf
 * @returns {string[]} problems
 */
export function checkPackagedFiles(entries, contentOf) {
  // @electron/asar lists paths with the platform's separator; the rules below are written with "/".
  const normalized = entries.map((entry) => ({
    ...entry,
    listed: entry.path,
    path: entry.path.replaceAll("\\", "/"),
  }));
  const paths = normalized.map((entry) => entry.path);
  if (!paths.includes(MAIN_ENTRY)) return [`app.asar has no ${MAIN_ENTRY}`];
  const problems = [];
  for (const { path, listed, kind } of normalized) {
    // Fail closed: a link could point outside the archive, past every check here.
    if (kind === "link") problems.push(`${path} is a link`);
    else if (BUNDLED.test(path)) problems.push(`${path} is packaged, but the build bundles it`);
    else if (
      kind === "file" &&
      /^\/out\/.*\.(?:js|cjs|mjs|html)$/.test(path) &&
      contentOf(listed).includes(MARKER)
    ) {
      problems.push(`${path} contains ${MARKER}`);
    }
  }
  for (const required of REQUIRED) {
    if (!paths.includes(required)) problems.push(`app.asar lacks ${required}`);
  }
  return problems;
}

/**
 * Where the parts of a packaged app are (electron-builder `dir` targets): a macOS `.app` bundle, or the
 * `win-unpacked` / `linux-unpacked` directory. Only macOS has an Info.plist to check; Windows and Linux register the
 * `wglauncher` scheme through an installer, which a `dir` build does not have.
 * @param {string} appPath
 * @returns {{ platform: "darwin" | "win32" | "linux", fuseTarget: string, archive: string, infoPlist: string | null }}
 */
export function packagedLayout(appPath) {
  const name = basename(appPath);
  if (name.endsWith(".app")) {
    return {
      platform: "darwin",
      fuseTarget: appPath,
      archive: join(appPath, "Contents", "Resources", "app.asar"),
      infoPlist: join(appPath, "Contents", "Info.plist"),
    };
  }
  const unpacked = {
    "win-unpacked": ["win32", "WGLauncher.exe"],
    "linux-unpacked": ["linux", "wglauncher"],
  }[name];
  if (!unpacked)
    throw new Error(`${appPath} is not a packaged app (a .app, win-unpacked or linux-unpacked)`);
  const [platform, executable] = /** @type {["win32" | "linux", string]} */ (unpacked);
  return {
    platform,
    fuseTarget: join(appPath, executable),
    archive: join(appPath, "resources", "app.asar"),
    infoPlist: null,
  };
}

/** @param {string} appPath */
async function main(appPath) {
  const { getCurrentFuseWire } = await import("@electron/fuses");
  const { extractFile, listPackage, statFile } = await import("@electron/asar");
  const { archive, fuseTarget, infoPlist } = packagedLayout(appPath);
  const plist =
    infoPlist === null
      ? null
      : JSON.parse(
          execFileSync("plutil", ["-convert", "json", "-o", "-", infoPlist], { encoding: "utf8" }),
        );
  const entries = listPackage(archive, { isPack: false }).map((path) => {
    const entry = statFile(archive, path.slice(1), false);
    /** @type {"file" | "directory" | "link"} */
    const kind = "files" in entry ? "directory" : "link" in entry ? "link" : "file";
    return { path, kind };
  });
  const problems = [
    ...checkFuses(
      /** @type {Record<string, number | string>} */ (
        /** @type {unknown} */ (await getCurrentFuseWire(fuseTarget))
      ),
    ),
    ...(plist === null ? [] : checkInfoPlist(plist)),
    ...checkPackagedFiles(entries, (path) => extractFile(archive, path.slice(1)).toString("utf8")),
  ];
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  if (problems.length > 0) process.exit(1);
  const files = entries.filter((entry) => entry.kind === "file").length;
  const parts = plist === null ? "fuses and app.asar" : "fuses, Info.plist and app.asar";
  console.log(`OK: ${parts} (${files} files) pass the release check.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error(
      "usage: node scripts/release-check.mjs <WGLauncher.app | win-unpacked | linux-unpacked>",
    );
    process.exit(2);
  }
  await main(appPath);
}
