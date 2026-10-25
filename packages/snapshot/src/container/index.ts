// `@wg-launcher/snapshot/container`: the Node-only `.wgsnap` container (node:zlib, node:crypto, node:stream), used only
// by the snapshot worker. Never re-exported from src/index.ts, which stays Web-APIs-only for the quiescent preload
// (Ruling R10).
export { SnapError } from "../errors.js";
export { computeContentHash } from "./content-hash.js";
export { canonicalJson } from "./jcs.js";
export { DEFAULT_LIMITS, type Limits, resolveLimits } from "./limits.js";
export { type Manifest, ManifestSchema, manifestSchema, parseManifest } from "./manifest.js";
export {
  blobPath,
  type DataPath,
  isDataDirectory,
  localStoragePath,
  parseDataPath,
  schemaPath,
  storePath,
} from "./paths.js";
export {
  type ReadOptions,
  readEntries,
  type StorageKeySummary,
  type ValidatedSnapshot,
  validateSnapshot,
} from "./reader.js";
export { type SnapshotFile, type SnapshotInput, writeSnapshot } from "./writer.js";
export { ZstdFrameWalker } from "./zstd-frame.js";
