import { describe, expect, it } from "vitest";
import { ALLOWED_PERMISSIONS, decidePermission } from "./permissions.js";

// security.md section 5 (AC-4): exactly fullscreen, pointerLock and keyboardLock are allowed; every other name,
// including future ones, is denied. The same decision serves the request and the check handler.

// Every name Electron 45's handlers receive, from security.md section 5 (`electron.d.ts` of electron@45.0.0).
const ELECTRON_45_DENIED = [
  "media",
  "display-capture",
  "geolocation",
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "persistent-storage",
  "storage-access",
  "top-level-storage-access",
  "fileSystem",
  "openExternal",
  "midi",
  "midiSysex",
  "hid",
  "serial",
  "usb",
  "local-network-access",
  "loopback-network",
  "screen-wake-lock",
  "window-management",
  "idle-detection",
  "unknown",
];

describe("decidePermission", () => {
  it("allows exactly fullscreen, pointerLock and keyboardLock", () => {
    expect([...ALLOWED_PERMISSIONS].sort()).toEqual(["fullscreen", "keyboardLock", "pointerLock"]);
    expect(decidePermission("fullscreen")).toBe("allow");
    expect(decidePermission("pointerLock")).toBe("allow");
    expect(decidePermission("keyboardLock")).toBe("allow");
  });

  it("denies every other Electron 45 permission name", () => {
    for (const name of ELECTRON_45_DENIED) expect(decidePermission(name), name).toBe("deny");
  });

  it("denies an unknown future name, the empty name and near misses", () => {
    for (const name of [
      "speaker-selection",
      "some-future-permission",
      "",
      "Fullscreen",
      "FULLSCREEN",
      "pointerlock",
      "keyboard-lock",
      " fullscreen",
      "fullscreen ",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(decidePermission(name), JSON.stringify(name)).toBe("deny");
    }
  });

  it("denies non-string input", () => {
    for (const name of [undefined, null, 1, {}, ["fullscreen"]]) {
      expect(decidePermission(name as unknown as string)).toBe("deny");
    }
  });
});
