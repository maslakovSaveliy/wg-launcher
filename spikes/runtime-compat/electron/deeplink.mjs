// THROWAWAY spike (runtime-compat). Entry point of the PACKAGED spike app for H15 only: logs every
// open-url and second-instance event with the parsed game id to <userData>/deeplink-log.jsonl.
// Not product code.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow } from "electron";

const logFile = join(app.getPath("userData"), "deeplink-log.jsonl");

function log(event, data = {}) {
  // Before ready the user-data directory may not exist yet (first launch).
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data })}\n`);
}

function idFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "wgspike:" ? parsed.searchParams.get("id") : null;
  } catch {
    return null;
  }
}

function idFromArgv(argv) {
  for (const arg of argv) {
    const flag = /^--launch-game=(.+)$/.exec(arg);
    if (flag) return flag[1];
    if (arg.startsWith("wgspike://")) return idFromUrl(arg);
  }
  return null;
}

// macOS delivers deep links as open-url; it must be registered before ready.
app.on("open-url", (event, url) => {
  event.preventDefault();
  log("open-url", { url, id: idFromUrl(url) });
});

const gotLock = app.requestSingleInstanceLock({ from: "wgspike" });
log("start", { argv: process.argv.slice(1), gotLock, idFromArgv: idFromArgv(process.argv) });

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, _cwd, additionalData) => {
    log("second-instance", { argv: argv.slice(1), id: idFromArgv(argv), additionalData });
  });
  app.whenReady().then(() => {
    const registered = app.setAsDefaultProtocolClient("wgspike");
    log("ready", { setAsDefaultProtocolClient: registered, isDefault: app.isDefaultProtocolClient("wgspike") });
    const win = new BrowserWindow({ width: 420, height: 160, webPreferences: { sandbox: true, contextIsolation: true } });
    win.loadURL("data:text/html,<p style='font:16px system-ui'>wgspike deep-link test (THROWAWAY)</p>");
  });
  app.on("window-all-closed", () => app.quit());
}
