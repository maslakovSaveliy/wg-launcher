// The snapshot worker's entry: a `utilityProcess` (architecture.md section 1) built as a second main-process entry.
// It owns encoding, hashing, compression and validation of `.wgsnap` files, so neither a parser bug nor memory
// exhaustion can take down the main process (security.md section 8). It never opens the database: everything it
// learns goes back to main as a `WorkerEvent`. The ports of quiescent frames arrive with `frame` commands.
import type { MessagePortMain } from "electron";
import type { WorkerPort } from "./frame-client.js";
import { createWorkerCore } from "./worker-core.js";

/** Electron's `MessagePortMain` as the frame client sees it; messages wait until `start()`. */
function adapt(port: MessagePortMain): WorkerPort {
  return {
    onMessage: (listener) => {
      port.on("message", (event) => listener(event.data));
      port.start();
    },
    onClose: (listener) => port.on("close", listener),
    postMessage: (message) => port.postMessage(message),
    close: () => port.close(),
  };
}

const parent = process.parentPort;
const core = createWorkerCore({
  post: (event) => parent.postMessage(event),
  allowFaults: __WG_FLAVOR__ === "test",
});
parent.on("message", (event) => {
  core.handle(event.data, event.ports.map(adapt)).catch((error: unknown) => {
    // Only a message the protocol does not know gets here; main never sends one.
    console.error(`snapshot worker: ${error instanceof Error ? error.message : "failed"}`);
  });
});
parent.postMessage({ type: "ready" });
