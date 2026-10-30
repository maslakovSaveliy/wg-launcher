// The quiescent preload (save-transfer.md section 5, steps 9 and 10, QW-5 and QW-6): a sandboxed CommonJS bundle that
// runs in the isolated world of each frame of a quiescent window, never in a game window. In a frame whose URL is
// not a stub URL that resolves a storage key (`about:blank`, a top page that only hosts iframes) it does nothing.
// Otherwise it says hello with the job nonce from its URL; main answers with one end of a message port, on which the
// generic exporter serves the snapshot worker's typed commands (`serveFrame`). It exposes nothing to the main world
// (no contextBridge), evaluates no code it receives, and reads storage through the Web APIs of its own world.
// First: zod must be jitless before the exporters' schemas are built (zod-jitless.ts).
import "./zod-jitless.js";
import { createFrameExporter, serveFrame } from "@wg-launcher/exporters";
import { ipcRenderer } from "electron";
import { HELLO_CHANNEL, PORT_CHANNEL, STUB_PATH } from "../main/snapshots/quiescent/channels.js";

const JOB = /^[0-9a-f]{32}$/;
const KEY = /^(0|[1-9][0-9]?)$/;

/** The job nonce of a stub URL that resolves a key (`?job=<nonce>&key=<k>`, nothing else), or null. */
function jobOf(location: Location): string | null {
  if (location.protocol !== "http:" && location.protocol !== "https:") return null;
  if (location.pathname !== STUB_PATH || location.hash !== "") return null;
  const params = new URLSearchParams(location.search);
  const job = params.get("job");
  const key = params.get("key");
  if ([...params.keys()].length !== 2 || job === null || key === null) return null;
  return JOB.test(job) && KEY.test(key) ? job : null;
}

const job = jobOf(window.location);
if (job !== null) {
  ipcRenderer.once(PORT_CHANNEL, (event) => {
    const [port] = event.ports;
    if (port === undefined || event.ports.length !== 1) return;
    serveFrame(
      port,
      createFrameExporter({ localStorage, indexedDB, crypto, storage: navigator.storage }),
    );
  });
  ipcRenderer.send(HELLO_CHANNEL, { job });
}
