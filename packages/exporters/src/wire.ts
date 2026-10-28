// `@wg-launcher/exporters/wire`: what the launcher's main side and the snapshot worker share with the quiescent
// frames (the frame protocol, the frame server, scopes and the data types) without any DOM type. The DOM-bound
// exporter itself is only in the package's main entry, which only the quiescent preload bundles.
export { ADAPTERS } from "./adapters/index.js";
export { type Adapter, adapterScope } from "./adapters/schema.js";
export { decideFlushState, type FlushObservation } from "./flush.js";
export { type FramePort, serveFrame } from "./frame-server.js";
export { FrameCommand, FrameReply, isRequestNonce, MAX_ENTRY_CHUNK_BYTES } from "./protocol.js";
export { ALL, type FrameScope, type Selection, selectsDatabase, selectsKey } from "./scope.js";
export * from "./types.js";
