import { describe, expect, it } from "vitest";
import { checkFuses, checkInfoPlist, checkPackagedFiles } from "./release-check.mjs";

const ON = 49;
const OFF = 48;

/** The wire of a correctly packaged app (security.md section 4), as `getCurrentFuseWire` returns it. */
const good = (): Record<string, number | string> => ({
  version: "1",
  0: OFF, // runAsNode
  1: ON, // cookieEncryption
  2: OFF, // nodeOptions
  3: OFF, // nodeCliInspect
  4: ON, // embeddedAsarIntegrityValidation
  5: ON, // onlyLoadAppFromAsar
  6: OFF, // loadBrowserProcessSpecificV8Snapshot
  7: OFF, // grantFileProtocolExtraPrivileges
  8: ON, // wasmTrapHandlers
});

describe("fuses of the packaged app (security.md section 4, S-14)", () => {
  it("accepts exactly the specified wire", () => {
    expect(checkFuses(good())).toEqual([]);
  });

  it("names a fuse in the wrong state", () => {
    expect(checkFuses({ ...good(), 0: ON })).toEqual(["fuse runAsNode is on, expected off"]);
    expect(checkFuses({ ...good(), 1: OFF })).toEqual([
      "fuse cookieEncryption is off, expected on",
    ]);
  });

  it("names a missing fuse and an unknown one, so a new Electron fuse is looked at", () => {
    const wire = good();
    delete wire[8];
    expect(checkFuses(wire)).toEqual(["fuse wasmTrapHandlers is missing"]);
    expect(checkFuses({ ...good(), 9: OFF })).toEqual(["unknown fuse at position 9"]);
  });

  it("names a fuse in a state other than on or off", () => {
    expect(checkFuses({ ...good(), 2: 114 })).toEqual([
      "fuse nodeOptions is state 114, expected off",
    ]);
  });

  it("refuses a wire of another version", () => {
    expect(checkFuses({ ...good(), version: "2" })).toEqual(["fuse wire version 2, expected 1"]);
  });
});

describe("Info.plist of the packaged app (security.md section 5)", () => {
  const plist = {
    CFBundleIdentifier: "dev.wglauncher.app",
    CFBundleURLTypes: [{ CFBundleURLName: "WGLauncher", CFBundleURLSchemes: ["wglauncher"] }],
  };

  it("accepts no media or Bluetooth usage description and the wglauncher scheme", () => {
    expect(checkInfoPlist(plist)).toEqual([]);
  });

  it("names every media and Bluetooth usage description the prebuilt Electron ships", () => {
    expect(
      checkInfoPlist({
        ...plist,
        NSAudioCaptureUsageDescription: "x",
        NSBluetoothAlwaysUsageDescription: "x",
        NSBluetoothPeripheralUsageDescription: "x",
        NSCameraUsageDescription: "x",
        NSMicrophoneUsageDescription: "x",
      }),
    ).toEqual([
      "Info.plist has NSAudioCaptureUsageDescription",
      "Info.plist has NSBluetoothAlwaysUsageDescription",
      "Info.plist has NSBluetoothPeripheralUsageDescription",
      "Info.plist has NSCameraUsageDescription",
      "Info.plist has NSMicrophoneUsageDescription",
    ]);
  });

  it("requires the wglauncher deep-link scheme", () => {
    expect(checkInfoPlist({ CFBundleIdentifier: "x" })).toEqual([
      "Info.plist registers no wglauncher URL scheme",
    ]);
    expect(checkInfoPlist({ CFBundleURLTypes: [{ CFBundleURLSchemes: ["wgspike"] }] })).toEqual([
      "Info.plist registers no wglauncher URL scheme",
    ]);
  });
});

describe("files inside app.asar", () => {
  type Kind = "file" | "directory" | "link";
  const files: Record<string, string> = {
    "/package.json": "{}",
    "/out/main/index.js": "main();",
    "/out/preload/launcher.cjs": "bridge();",
    "/out/renderer/index.html": "<!doctype html>",
    "/node_modules/tldts/package.json": "{}",
    "/node_modules/tldts-core/package.json": "{}",
    "/node_modules/zod/package.json": "{}",
  };
  const entries = (all: Record<string, string>, kinds: Record<string, Kind> = {}) =>
    Object.keys(all).map((path) => ({ path, kind: kinds[path] ?? ("file" as Kind) }));
  const check = (extra: Record<string, string> = {}, kinds: Record<string, Kind> = {}) => {
    const all = { ...files, ...extra };
    return checkPackagedFiles(entries(all, kinds), (path) => all[path] ?? "");
  };

  it("accepts the built app with its runtime dependencies", () => {
    expect(
      check(
        { "/node_modules": "", "/out": "" },
        { "/node_modules": "directory", "/out": "directory" },
      ),
    ).toEqual([]);
  });

  it("refuses the test hooks in any built file", () => {
    expect(check({ "/out/main/chunk.js": "globalThis.__wgTest = {}" })).toEqual([
      "/out/main/chunk.js contains __wgTest",
    ]);
  });

  it("refuses packages that are bundled already, at any depth", () => {
    expect(
      check({
        "/node_modules/react/index.js": "",
        "/node_modules/react-dom/index.js": "",
        "/node_modules/scheduler/index.js": "",
        "/node_modules/@wg-launcher/shared/package.json": "{}",
        "/node_modules/zod/node_modules/react/index.js": "",
      }),
    ).toEqual([
      "/node_modules/react/index.js is packaged, but the build bundles it",
      "/node_modules/react-dom/index.js is packaged, but the build bundles it",
      "/node_modules/scheduler/index.js is packaged, but the build bundles it",
      "/node_modules/@wg-launcher/shared/package.json is packaged, but the build bundles it",
      "/node_modules/zod/node_modules/react/index.js is packaged, but the build bundles it",
    ]);
  });

  it("refuses a link, which could point outside the archive", () => {
    expect(
      check({ "/node_modules/tldts-core": "" }, { "/node_modules/tldts-core": "link" }),
    ).toEqual(["/node_modules/tldts-core is a link"]);
  });

  it("requires the packages main loads at run time", () => {
    const all = { ...files };
    delete all["/node_modules/tldts-core/package.json"];
    expect(checkPackagedFiles(entries(all), (path) => all[path] ?? "")).toEqual([
      "app.asar lacks /node_modules/tldts-core/package.json",
    ]);
  });

  it("refuses an archive without the main entry, so the check cannot pass on an empty build", () => {
    const empty = checkPackagedFiles([{ path: "/package.json", kind: "file" }], () => "{}");
    expect(empty).toEqual(["app.asar has no /out/main/index.js"]);
  });
});
