import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { appMenuTemplate } from "./app-menu.js";

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu as MenuItemConstructorOptions[]) : []),
  ]);
}

const PLATFORMS = ["darwin", "win32", "linux"] as const;
const FLAVORS = ["prod", "test", "dev"] as const;

describe("appMenuTemplate (architecture.md section 9)", () => {
  it("has the fullscreen toggle (role togglefullscreen) on every platform and flavor", () => {
    for (const platform of PLATFORMS) {
      for (const flavor of FLAVORS) {
        const items = flatten(appMenuTemplate(platform, flavor));
        expect(
          items.filter((item) => item.role === "togglefullscreen"),
          `${platform} ${flavor}`,
        ).toHaveLength(1);
      }
    }
  });

  it("puts no accelerator on Esc, so Esc always reaches the game", () => {
    for (const platform of PLATFORMS) {
      for (const flavor of FLAVORS) {
        for (const item of flatten(appMenuTemplate(platform, flavor))) {
          expect(String(item.accelerator ?? "")).not.toMatch(/esc/i);
        }
      }
    }
  });

  it("keeps the edit roles (copy and paste in the launcher's fields need them on macOS)", () => {
    for (const platform of PLATFORMS) {
      expect(flatten(appMenuTemplate(platform, "prod")).map((item) => item.role)).toContain(
        "editMenu",
      );
    }
    expect(appMenuTemplate("darwin", "prod")[0]?.role).toBe("appMenu");
  });

  it("offers reload and developer tools in the dev flavor only", () => {
    const devOnly = ["reload", "forceReload", "toggleDevTools"];
    for (const platform of PLATFORMS) {
      const roles = (flavor: (typeof FLAVORS)[number]) =>
        flatten(appMenuTemplate(platform, flavor)).map((item) => item.role);
      expect(roles("dev")).toEqual(expect.arrayContaining(devOnly));
      for (const flavor of ["prod", "test"] as const) {
        expect(roles(flavor).filter((role) => devOnly.includes(String(role)))).toEqual([]);
      }
    }
  });
});
