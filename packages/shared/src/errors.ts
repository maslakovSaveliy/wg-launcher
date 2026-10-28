// Every result code named in the specs. A code that is not here is not a result code: `SW_STOP_FAILED` and
// `IPC_FORBIDDEN_SENDER` (architecture.md) are log event names. `errors.test.ts` compares these lists with the
// specs, so a code added to a spec without being added here fails the test.

/** IPC codes of architecture.md section 6. */
export const IPC_CODES = [
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "URL_NOT_ALLOWED",
  "GAME_RUNNING",
  "GAME_BUSY",
  "NEEDS_RECOVERY",
  "CANCELLED",
  "LIBRARY_READ_ONLY",
  "INTERNAL",
] as const;

/** Snapshot format codes (snapshot-format.md). */
export const SNAP_CODES = [
  "SNAP_ABSOLUTE_PATH",
  "SNAP_BAD_PATH",
  "SNAP_BAD_PATH_ENCODING",
  "SNAP_CONTENT_HASH_MISMATCH",
  "SNAP_DEVICE",
  "SNAP_DUPLICATE_PATH",
  "SNAP_ENTRY_HASH_MISMATCH",
  "SNAP_ENTRY_TOO_LARGE",
  "SNAP_FILE_TOO_LARGE",
  "SNAP_HARDLINK",
  "SNAP_MANIFEST_INVALID",
  "SNAP_MANIFEST_TOO_LARGE",
  "SNAP_MISSING_ENTRY",
  "SNAP_MISSING_MANIFEST",
  "SNAP_NON_NFC_PATH",
  "SNAP_PATH_TRAVERSAL",
  "SNAP_RATIO_EXCEEDED",
  "SNAP_RECORD_INVALID",
  "SNAP_SIZE_MISMATCH",
  "SNAP_SYMLINK",
  "SNAP_TAR_INVALID",
  "SNAP_TOO_MANY_ENTRIES",
  "SNAP_TOTAL_TOO_LARGE",
  "SNAP_TRAILING_DATA",
  "SNAP_TRUNCATED",
  "SNAP_UNEXPECTED_ENTRY",
  "SNAP_UNKNOWN_FORMAT",
  "SNAP_UNSUPPORTED_ENTRY_TYPE",
  "SNAP_UNSUPPORTED_VERSION",
  "SNAP_ZSTD_INVALID",
  "SNAP_ZSTD_NO_CHECKSUM",
] as const;

/** Export codes (save-transfer.md). */
export const EXP_CODES = [
  "EXP_KEY_GENERATOR_EXHAUSTED",
  "EXP_QUIESCENCE_VIOLATION",
  "EXP_SHARED_REFERENCE",
  "EXP_STORAGE_KEY_MISMATCH",
  "EXP_TIMEOUT",
  "EXP_TOO_DEEP",
  "EXP_UNSUPPORTED_STORAGE_KEY",
  "EXP_UNSUPPORTED_VALUE",
] as const;

/** Import (restore) codes (save-transfer.md). */
export const IMP_CODES = [
  "IMP_BACKUP_FAILED",
  "IMP_KEY_MISMATCH",
  "IMP_PLAN_CHANGED",
  "IMP_QUIESCENCE_VIOLATION",
  "IMP_QUOTA_EXCEEDED",
  "IMP_RECORD_INVALID",
  "IMP_RECOVERY_FAILED",
  "IMP_REVISION_CONFLICT",
  "IMP_STORAGE_KEY_MISMATCH",
  "IMP_TARGET_NOT_EMPTY",
  "IMP_VERIFY_MISMATCH",
  "IMP_WIPE_FAILED",
] as const;

export type IpcCode = (typeof IPC_CODES)[number];
export type SnapCode = (typeof SNAP_CODES)[number];
export type ExpCode = (typeof EXP_CODES)[number];
export type ImpCode = (typeof IMP_CODES)[number];

export const ERROR_CODES = [...IPC_CODES, ...SNAP_CODES, ...EXP_CODES, ...IMP_CODES] as const;

/** Every result code the launcher can return. */
export type ErrorCode = IpcCode | SnapCode | ExpCode | ImpCode;
