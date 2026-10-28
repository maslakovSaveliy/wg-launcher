// The application menu: Electron's standard roles only, with the fullscreen toggle of architecture.md section 9
// (role `togglefullscreen`: Ctrl+Cmd+F on macOS, F11 elsewhere, Electron's defaults) and no accelerator on Esc, which
// always stays with the game. Reload and developer tools exist in the dev flavor only. On macOS the menu acts on the
// focused window, so the toggle works in every game window.

import type { MenuItemConstructorOptions } from "electron";
import type { Flavor } from "./flavor.js";

export function appMenuTemplate(
  platform: NodeJS.Platform,
  flavor: Flavor,
): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [{ role: "togglefullscreen" }];
  if (flavor === "dev") {
    view.push(
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
    );
  }
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "View", submenu: view },
    { role: "windowMenu" },
  ];
}
