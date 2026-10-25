// Error classes of the snapshot codec. Web APIs only: this file runs in the quiescent preload and in the snapshot
// worker (snapshot-format.md section 6.1), so it imports nothing from `node:`.
import type { ExpCode, SnapCode } from "@wg-launcher/shared";

/** A snapshot that breaks the format (snapshot-format.md section 8). Never carries data content. */
export class SnapError extends Error {
  readonly code: SnapCode;
  /** The entry path inside the archive, when the failure belongs to one entry. */
  readonly path?: string;

  constructor(code: SnapCode, message: string, path?: string) {
    super(message);
    this.name = "SnapError";
    this.code = code;
    if (path !== undefined) {
      this.path = path;
    }
  }
}

/** One step of a property path from the record root: a property key, an array index or a Map/Set entry index. */
export type PathSegment = string | number;

/**
 * Where an unsupported value sits (snapshot-format.md section 6.3). The record layer fills `path` and `type`; the
 * exporter (Task 12) adds the storage key, database, store and record key it is working on.
 */
export interface ExportErrorDetail {
  path: PathSegment[];
  /** `Object.prototype.toString` of the offending value, for example `[object Error]`. */
  type: string;
  storageKey?: { origin: string; topLevelSite: string | null };
  database?: string;
  store?: string;
  recordKey?: unknown;
}

/** A value that the format cannot hold (snapshot-format.md section 6.3, save-transfer.md section 4). */
export class ExportError extends Error {
  readonly code: ExpCode;
  readonly detail: ExportErrorDetail;

  constructor(code: ExpCode, message: string, detail: ExportErrorDetail) {
    super(message);
    this.name = "ExportError";
    this.code = code;
    this.detail = detail;
  }
}
