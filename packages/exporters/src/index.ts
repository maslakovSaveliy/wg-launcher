// `@wg-launcher/exporters`: the generic web storage exporter of one quiescent stub frame, its frame protocol, the
// declarative adapters and the flush-state decision. Web APIs only (web-only.test.ts).
export { ADAPTERS } from "./adapters/index.js";
export {
  type Adapter,
  AdapterError,
  adapterScope,
  MODULE_NAME,
  parseAdapter,
} from "./adapters/schema.js";
export { decideFlushState, type FlushObservation, type HookRun, PROMPT_CLOSE_MS } from "./flush.js";
export { createFrameExporter } from "./frame-exporter.js";
export { type FramePort, serveFrame } from "./frame-server.js";
export { FrameCommand, FrameReply, isRequestNonce, MAX_ENTRY_CHUNK_BYTES } from "./protocol.js";
export { ALL, type FrameScope, type Selection, selectsDatabase, selectsKey } from "./scope.js";
export * from "./types.js";
