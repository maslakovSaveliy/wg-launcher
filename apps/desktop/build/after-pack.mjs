// electron-builder `afterPack` hook: removes the media and Bluetooth usage descriptions the prebuilt Electron
// Info.plist ships (security.md section 5: the launcher never asks the OS for these devices; the session handlers
// deny them). Runs before signing; only the app's own Info.plist carries them in Electron 45 (the helpers' do not).
// The release check fails if any remains.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const KEYS = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

/** @param {{ electronPlatformName: string, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const plist = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Info.plist",
  );
  const present = Object.keys(
    JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }),
    ),
  );
  for (const key of KEYS) {
    if (present.includes(key)) execFileSync("plutil", ["-remove", key, plist]);
  }
}
