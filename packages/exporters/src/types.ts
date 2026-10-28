// The exporter interfaces of save-transfer.md section 3. One exporter instance serves one stub frame of the quiescent
// window; the snapshot worker assembles the `.wgsnap` file from the entries it writes.
import type { ExpCode, ImpCode } from "@wg-launcher/shared";
import type { PathSegment } from "@wg-launcher/snapshot";
import type { FrameScope } from "./scope.js";

export interface ExporterInfo {
  id: string;
  version: string;
}

/** v1 ships exactly one exporter (save-transfer.md section 3). */
export const GENERIC_EXPORTER: ExporterInfo = { id: "generic-web-storage", version: "1.0.0" };

/** A full storage key (snapshot-format.md section 4); `topLevelSite` is `null` for first-party storage. */
export interface StorageKey {
  origin: string;
  topLevelSite: string | null;
}

/** Which manifest storage key this frame is (`data/<keyIndex>/...`) and its key, for error details. */
export interface FrameTarget {
  keyIndex: number;
  storageKey: StorageKey;
}

export interface FrameExportRequest extends FrameTarget {
  scope: FrameScope;
}

/** `scope` is `"all"` for a full restore after the CDP wipe, an adapter's selection for a selective one. */
export interface FrameImportPlan extends FrameTarget {
  scope: FrameScope;
}

/** Counts, names and usage numbers; never values, never cookies. */
export interface FrameInventory {
  localStorageItems: number;
  databases: { name: string; version: number }[];
  /** `navigator.storage.estimate().usageDetails` when available (Chromium), else `null`. */
  usageDetails: Record<string, number> | null;
}

export type NotExportedKind = "fileSystem" | "cacheStorage" | "serviceWorkers";

export interface DatabaseSummary {
  name: string;
  version: number;
  stores: number;
  records: number;
}

/** What one export or import covered. */
export interface FrameSummary {
  localStorageItems: number;
  databases: DatabaseSummary[];
  /** Distinct blobs written or read. */
  blobs: number;
  /** Storage kinds found but not exported (save-transfer.md section 4, step 5); always empty for an import. */
  notExported: NotExportedKind[];
}

export interface WipeSummary {
  localStorageItems: number;
  databases: string[];
}

/** Receives each entry once: `data/<k>/...` files and `blobs/<sha256>`, whole. */
export interface EntrySink {
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** The entries of one storage key and the blobs they reference, in any order. */
export type EntrySource = AsyncIterable<{ path: string; bytes: Uint8Array }>;

export type FrameErrorCode = ExpCode | ImpCode | "INTERNAL";

/** Where a failure sits. Names of databases and stores, record keys and paths; never values. */
export interface FrameErrorDetail {
  storageKey?: StorageKey;
  database?: string;
  store?: string;
  recordKey?: unknown;
  /** Property path from the record root (snapshot-format.md section 6.3). */
  path?: PathSegment[];
  /** `Object.prototype.toString` of an unsupported value. */
  type?: string;
  reason?: string;
  /** The entry path an import failure belongs to. */
  entry?: string;
}

export interface FrameError {
  code: FrameErrorCode;
  /** Short English, no values. */
  message: string;
  detail?: FrameErrorDetail;
}

/** Errors are values (save-transfer.md section 3): a frame command never throws. */
export type FrameResult<T> = { ok: true; data: T } | { ok: false; error: FrameError };

export interface FrameExporter {
  readonly info: ExporterInfo;
  inventory(): Promise<FrameResult<FrameInventory>>;
  exportFrame(request: FrameExportRequest, out: EntrySink): Promise<FrameResult<FrameSummary>>;
  importFrame(source: EntrySource, plan: FrameImportPlan): Promise<FrameResult<FrameSummary>>;
  wipeSelected(scope: FrameScope): Promise<FrameResult<WipeSummary>>;
}
