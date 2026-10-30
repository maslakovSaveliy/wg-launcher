// The release check of the packaged macOS app (security.md sections 4 and 5, S-14): the fuse wire must be exactly
// the specified one (a fuse a newer Electron adds is reported, so it gets a decision); Info.plist must carry no
// media or Bluetooth usage description and must register the `wglauncher` scheme; app.asar must hold the built app,
// no test hooks (`__wgTest`) and none of the packages the build already bundles (React into the renderer, the
// workspace packages into main), so nothing ships twice outside the license gate's view.
//
//   node scripts/release-check.mjs <path to WGLauncher.app>

import { execFileSync } from "node:child_process";
import { join } from "node:path";
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
/** Bundled by the build, so a packaged copy would ship twice. */
const BUNDLED = /^\/node_modules\/(?:react|react-dom|scheduler|@wg-launcher\/[^/]+)\//;

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
 * @param {readonly string[]} paths the archive's files, each starting with "/"
 * @param {(path: string) => string} contentOf
 * @returns {string[]} problems
 */
export function checkPackagedFiles(paths, contentOf) {
  if (!paths.includes(MAIN_ENTRY)) return [`app.asar has no ${MAIN_ENTRY}`];
  const problems = [];
  for (const path of paths) {
    if (BUNDLED.test(path)) problems.push(`${path} is packaged, but the build bundles it`);
    else if (/^\/out\/.*\.(?:js|cjs|mjs|html)$/.test(path) && contentOf(path).includes(MARKER)) {
      problems.push(`${path} contains ${MARKER}`);
    }
  }
  return problems;
}

/** @param {string} appPath */
async function main(appPath) {
  const { getCurrentFuseWire } = await import("@electron/fuses");
  const { extractFile, listPackage } = await import("@electron/asar");
  const archive = join(appPath, "Contents", "Resources", "app.asar");
  const plist = JSON.parse(
    execFileSync(
      "plutil",
      ["-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")],
      { encoding: "utf8" },
    ),
  );
  const paths = listPackage(archive, { isPack: false }).filter((path) => {
    try {
      extractFile(archive, path.slice(1));
      return true;
    } catch {
      return false; // a directory
    }
  });
  const problems = [
    ...checkFuses(
      /** @type {Record<string, number | string>} */ (
        /** @type {unknown} */ (await getCurrentFuseWire(appPath))
      ),
    ),
    ...checkInfoPlist(plist),
    ...checkPackagedFiles(paths, (path) => extractFile(archive, path.slice(1)).toString("utf8")),
  ];
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`OK: fuses, Info.plist and app.asar (${paths.length} files) pass the release check.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error("usage: node scripts/release-check.mjs <path to WGLauncher.app>");
    process.exit(2);
  }
  await main(appPath);
}
