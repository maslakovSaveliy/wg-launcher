// THROWAWAY spike (runtime-compat). Preload for the quiescent export/restore window ONLY (H14),
// a window whose documents are our own empty stubs; game windows never get a preload.
// It lets the main process run code in an isolated world of a SUBFRAME (variant c): Electron's
// main-process WebFrameMain has no executeJavaScriptInIsolatedWorld, the renderer's webFrame does.
const { ipcRenderer, webFrame } = require("electron");

ipcRenderer.on("wg:isolated", async (_event, message) => {
  let result = null;
  let error = null;
  try {
    result = await webFrame.executeJavaScriptInIsolatedWorld(message.worldId, [{ code: message.code }]);
  } catch (caught) {
    error = String(caught?.stack ?? caught);
  }
  ipcRenderer.send("wg:isolated-result", { id: message.id, result, error, href: location.href });
});
