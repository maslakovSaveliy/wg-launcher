// The Web APIs one frame's exporter works with. Kept apart from types.ts, which the launcher's main side and the
// snapshot worker also read (through `@wg-launcher/exporters/wire`) and which must therefore name no DOM type.
/** The Web APIs of the frame's isolated world. Injected, so that tests can replace one (a full localStorage). */
export interface FrameEnv {
  localStorage: Storage;
  indexedDB: IDBFactory;
  /** Hashes the blobs an import receives (`blobs/<sha256>` must match its name). */
  crypto: Crypto;
  /** `navigator.storage`, for `usageDetails`; absent where the API is missing. */
  storage?: Pick<StorageManager, "estimate">;
}
