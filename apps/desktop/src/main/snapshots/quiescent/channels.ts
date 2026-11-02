// Names the quiescent preload and the main process share. No import: the sandboxed preload bundles this file.

/** The path of every stub document (save-transfer.md section 5, step 7). */
export const STUB_PATH = "/__wg_quiescent__";

/** The preload's hello (`ipcRenderer.send`), and main's answer that carries the port (`WebFrameMain.postMessage`). */
export const HELLO_CHANNEL = "wg:quiescent:hello";
export const PORT_CHANNEL = "wg:quiescent:port";
