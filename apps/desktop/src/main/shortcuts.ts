// Game shortcuts (architecture.md section 8, PRD F-8): a shortcut calls the one shared client with the game's id; no
// per-game bundle exists. macOS gets a `.webloc` file whose only variable part is the validated id (a `.command`
// file is never offered: it runs a shell script). Windows gets a `.lnk` from `shell.writeShortcutLink` that starts
// the executable with `--launch-game=<id>` (unit-tested arguments only: not tested on Windows, no machine). The file
// is placed where the user says in a native save dialog (default: the Desktop); no path crosses IPC.

import { posix, win32 } from "node:path";
import { type IpcCode, isUuidV7, type Result } from "@wg-launcher/shared";
import type { Dialogs } from "./dialogs.js";
import type { Logger } from "./log/logger.js";

/** The five XML special characters. */
export function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function checkId(gameId: string): void {
  if (!isUuidV7(gameId)) throw new TypeError("shortcut: not a lowercase UUIDv7");
}

/** The `.webloc` property list: the deep link `wglauncher://launch/<gameId>` and nothing else. */
export function weblocContent(gameId: string): string {
  checkId(gameId);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>URL</key>",
    `\t<string>${xmlEscape(`wglauncher://launch/${gameId}`)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Electron's `ShortcutDetails` as section 8 gives them. */
export interface WindowsShortcut {
  target: string;
  args: string;
  description: string;
  icon: string;
  iconIndex: number;
}

export function windowsShortcutOptions(
  gameId: string,
  execPath: string,
  title: string,
): WindowsShortcut {
  checkId(gameId);
  return {
    target: execPath,
    args: `--launch-game=${gameId}`,
    description: `${title} (WGLauncher)`,
    icon: execPath,
    iconIndex: 0,
  };
}

/** Shortcuts exist on macOS (`.webloc`) and Windows (`.lnk`) only; Linux is not a target yet (PRD section 11). */
export function shortcutsSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

const MAX_NAME_CHARS = 100;
const FALLBACK_NAME = "WGLauncher game";
/** Windows device names, reserved with any extension and in any case (`NUL.tar.gz` is `NUL`). */
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A file name from the game's title: no separators, reserved or control characters, no format characters (such as
 * U+202E, which can make a name read differently), no leading dot, never a Windows device name.
 */
export function shortcutFileName(title: string, extension: string): string {
  const cleaned = title
    .replace(/\p{Cf}/gu, "")
    .replace(/[/\\:*?"<>|\p{Cc}]/gu, "-")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const name = [...cleaned].slice(0, MAX_NAME_CHARS).join("").trimEnd();
  const device = RESERVED_WINDOWS_NAME.test((name.split(".")[0] ?? "").trimEnd());
  return `${name === "" || device ? FALLBACK_NAME : name}${extension}`;
}

export interface ShortcutDeps {
  platform: NodeJS.Platform;
  /** `process.execPath`: the packaged app's executable. */
  execPath: string;
  /** `app.getPath("desktop")`. */
  desktopDir: string;
  dialogs: Pick<Dialogs, "saveFile">;
  writeFile(path: string, content: string): Promise<void>;
  /** `shell.writeShortcutLink` (Windows only). */
  writeShortcutLink(path: string, operation: "create", options: WindowsShortcut): boolean;
  log: Pick<Logger, "info" | "error">;
}

type ShortcutResult = Result<{ created: boolean }, IpcCode>;

const SAVE_FAILED: ShortcutResult = {
  ok: false,
  code: "INTERNAL",
  message: "The shortcut could not be saved.",
};

/** `shortcut:create` after the handler found the game. */
export async function createShortcut(
  game: { id: string; title: string },
  deps: ShortcutDeps,
): Promise<ShortcutResult> {
  const windows = deps.platform === "win32";
  if (!shortcutsSupported(deps.platform)) {
    return {
      ok: false,
      code: "INTERNAL",
      message: "Shortcuts can be created on macOS and Windows only.",
    };
  }
  const extension = windows ? ".lnk" : ".webloc";
  const join = windows ? win32.join : posix.join;
  const chosen = await deps.dialogs.saveFile({
    title: "Create a shortcut",
    defaultPath: join(deps.desktopDir, shortcutFileName(game.title, extension)),
    filters: [{ name: "Shortcut", extensions: [extension.slice(1)] }],
  });
  if (chosen === null) return { ok: false, code: "CANCELLED", message: "No shortcut was created." };
  const path = chosen.toLowerCase().endsWith(extension) ? chosen : `${chosen}${extension}`;
  try {
    if (windows) {
      const options = windowsShortcutOptions(game.id, deps.execPath, game.title);
      if (!deps.writeShortcutLink(path, "create", options)) {
        throw new Error("shell.writeShortcutLink returned false");
      }
    } else {
      await deps.writeFile(path, weblocContent(game.id));
    }
  } catch (error) {
    deps.log.error("shortcut.failed", { gameId: game.id, error });
    return SAVE_FAILED;
  }
  deps.log.info("shortcut.created", { gameId: game.id, kind: extension.slice(1) });
  return { ok: true, data: { created: true } };
}
