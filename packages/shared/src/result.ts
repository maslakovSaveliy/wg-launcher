import type { ErrorCode } from "./errors.js";

/** The IPC and internal result shape of architecture.md section 6. `message` is short English with no paths. */
export type Result<T, C extends string = ErrorCode> =
  | { ok: true; data: T }
  | { ok: false; code: C; message: string };
