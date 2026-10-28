import { describe, expect, it, vi } from "vitest";
import {
  createShortcut,
  type ShortcutDeps,
  shortcutFileName,
  shortcutsSupported,
  weblocContent,
  windowsShortcutOptions,
  xmlEscape,
} from "./shortcuts.js";

const ID = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
const OTHER = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c";

describe("the macOS .webloc shortcut (architecture.md section 8)", () => {
  it("is a plist whose only content is the deep link of the game", () => {
    expect(weblocContent(ID)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "\t<key>URL</key>",
        `\t<string>wglauncher://launch/${ID}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
  });

  it("varies only in the id", () => {
    expect(weblocContent(OTHER)).toBe(weblocContent(ID).replace(ID, OTHER));
  });

  it("refuses anything but a lowercase UUIDv7, so no other text can reach the file", () => {
    for (const bad of [ID.toUpperCase(), `${ID}/`, "x</string><string>evil", ""]) {
      expect(() => weblocContent(bad)).toThrow(TypeError);
    }
  });

  it("escapes XML text", () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("the Windows shortcut (architecture.md section 8; not tested on Windows)", () => {
  it("starts the executable with --launch-game=<id> and its own icon", () => {
    expect(windowsShortcutOptions(ID, "C:\\Apps\\WGLauncher.exe", "Some game")).toEqual({
      target: "C:\\Apps\\WGLauncher.exe",
      args: `--launch-game=${ID}`,
      description: "Some game (WGLauncher)",
      icon: "C:\\Apps\\WGLauncher.exe",
      iconIndex: 0,
    });
  });

  it("refuses an id that is not a lowercase UUIDv7, so no switch can be added to the arguments", () => {
    expect(() => windowsShortcutOptions(`${ID} --inspect`, "x.exe", "t")).toThrow(TypeError);
  });
});

describe("shortcutFileName", () => {
  it("keeps a plain title and adds the extension", () => {
    expect(shortcutFileName("My Game 2", ".webloc")).toBe("My Game 2.webloc");
  });

  it("replaces characters that file systems refuse and control characters", () => {
    expect(shortcutFileName('a/b\\c:d*e?f"g<h>i|j\u0000k\u001fl', ".lnk")).toBe(
      "a-b-c-d-e-f-g-h-i-j-k-l.lnk",
    );
  });

  it("drops format characters such as U+202E (right-to-left override), which could disguise the name (review fix 5)", () => {
    expect(shortcutFileName("evil\u202Eknl.exe", ".lnk")).toBe("evilknl.exe.lnk");
    expect(shortcutFileName("a\u200Bb\u2066c\uFEFF", ".webloc")).toBe("abc.webloc");
    expect(shortcutFileName("\u202E\u200F", ".lnk")).toBe("WGLauncher game.lnk");
  });

  it("never gives a Windows reserved device name, with or without an extension, in any case (review fix 5)", () => {
    for (const reserved of [
      "CON",
      "prn",
      "Aux",
      "nul",
      "COM1",
      "com9",
      "LPT1",
      "lpt9",
      "CON.txt",
      "nul.tar.gz",
      "Con ",
    ]) {
      expect(shortcutFileName(reserved, ".lnk"), reserved).toBe("WGLauncher game.lnk");
    }
    for (const fine of ["CONSOLE", "COM10", "LPT0", "my con", "AUXILIARY"]) {
      expect(shortcutFileName(fine, ".lnk"), fine).toBe(`${fine}.lnk`);
    }
  });

  it("never starts with a dot, never is empty, and is at most 100 characters before the extension", () => {
    expect(shortcutFileName("..hidden", ".lnk")).toBe("hidden.lnk");
    expect(shortcutFileName("  ", ".lnk")).toBe("WGLauncher game.lnk");
    expect(shortcutFileName("x".repeat(300), ".webloc")).toBe(`${"x".repeat(100)}.webloc`);
  });
});

function deps(patch: Partial<ShortcutDeps> = {}): ShortcutDeps & {
  writeFile: ReturnType<typeof vi.fn>;
  writeShortcutLink: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
} {
  const saveFile = vi.fn(async () => "/volume/desk/Desktop/My Game.webloc" as string | null);
  const base = {
    platform: "darwin" as NodeJS.Platform,
    execPath: "/Applications/WGLauncher.app/Contents/MacOS/WGLauncher",
    desktopDir: "/volume/desk/Desktop",
    dialogs: { saveFile },
    writeFile: vi.fn(async () => undefined),
    writeShortcutLink: vi.fn(() => true),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() },
    saveFile,
  };
  return Object.assign(base, patch) as never;
}

describe("shortcutsSupported (review fix 4)", () => {
  it("is true on macOS and Windows only", () => {
    expect(shortcutsSupported("darwin")).toBe(true);
    expect(shortcutsSupported("win32")).toBe(true);
    expect(shortcutsSupported("linux")).toBe(false);
    expect(shortcutsSupported("freebsd")).toBe(false);
  });
});

describe("createShortcut (shortcut:create)", () => {
  const game = { id: ID, title: "My Game" };

  it("on macOS asks where to save, defaulting to the Desktop, and writes the .webloc there", async () => {
    const d = deps();
    expect(await createShortcut(game, d)).toEqual({ ok: true, data: { created: true } });
    expect(d.saveFile).toHaveBeenCalledWith({
      title: "Create a shortcut",
      defaultPath: "/volume/desk/Desktop/My Game.webloc",
      filters: [{ name: "Shortcut", extensions: ["webloc"] }],
    });
    expect(d.writeFile).toHaveBeenCalledWith(
      "/volume/desk/Desktop/My Game.webloc",
      weblocContent(ID),
    );
    expect(d.writeShortcutLink).not.toHaveBeenCalled();
  });

  it("adds the extension when the chosen name has none", async () => {
    const d = deps();
    d.saveFile.mockResolvedValueOnce("/tmp/short");
    await createShortcut(game, d);
    expect(d.writeFile).toHaveBeenCalledWith("/tmp/short.webloc", weblocContent(ID));
  });

  it("on Windows writes a .lnk through shell.writeShortcutLink", async () => {
    const d = deps({ platform: "win32", execPath: "C:\\W\\WGLauncher.exe", desktopDir: "C:\\D" });
    d.saveFile.mockResolvedValueOnce("C:\\D\\My Game.lnk");
    expect(await createShortcut(game, d)).toEqual({ ok: true, data: { created: true } });
    expect(d.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "Shortcut", extensions: ["lnk"] }] }),
    );
    expect(d.writeShortcutLink).toHaveBeenCalledWith(
      "C:\\D\\My Game.lnk",
      "create",
      windowsShortcutOptions(ID, "C:\\W\\WGLauncher.exe", "My Game"),
    );
    expect(d.writeFile).not.toHaveBeenCalled();
  });

  it("is CANCELLED when the dialog is cancelled, and writes nothing", async () => {
    const d = deps();
    d.saveFile.mockResolvedValueOnce(null);
    expect(await createShortcut(game, d)).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(d.writeFile).not.toHaveBeenCalled();
  });

  it("reports a failed write as INTERNAL without a path in the message", async () => {
    const mac = deps({
      writeFile: vi.fn(async () => Promise.reject(new Error("EACCES /volume/desk"))),
    });
    const win = deps({ platform: "win32", writeShortcutLink: vi.fn(() => false) });
    for (const d of [mac, win]) {
      const result = await createShortcut(game, d);
      expect(result).toEqual({
        ok: false,
        code: "INTERNAL",
        message: "The shortcut could not be saved.",
      });
      expect(d.log.error).toHaveBeenCalled();
    }
  });

  it("is not offered on other systems", async () => {
    const d = deps({ platform: "linux" });
    expect(await createShortcut(game, d)).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(d.saveFile).not.toHaveBeenCalled();
  });
});
