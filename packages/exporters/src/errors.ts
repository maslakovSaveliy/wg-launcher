// Failures inside a frame command. Commands throw `FrameFailure` internally and turn every throw into an error value
// at their boundary (`settle`), because a throwing isolated-world script resolves to `undefined` (save-transfer.md
// section 3).
import { ExportError, SnapError } from "@wg-launcher/snapshot";
import type { FrameError, FrameErrorCode, FrameErrorDetail, FrameResult } from "./types.js";

export class FrameFailure extends Error {
  readonly code: FrameErrorCode;
  readonly detail: FrameErrorDetail | undefined;

  constructor(code: FrameErrorCode, message: string, detail?: FrameErrorDetail) {
    super(message);
    this.name = "FrameFailure";
    this.code = code;
    this.detail = detail;
  }
}

/** The DOMException name of a failure, from any realm (a fake storage may throw its own). */
export function errorName(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : undefined;
}

export const isQuotaError = (error: unknown) => errorName(error) === "QuotaExceededError";

/**
 * Which command a failure belongs to. A snapshot format error (SnapError) is an import's `IMP_RECORD_INVALID`; on the
 * export path, which never decodes snapshot data, it is unexpected and `INTERNAL`.
 */
export type Direction = "export" | "import";

/** An error value for any throw; unexpected ones are INTERNAL and name only the error type, never values. */
export function toFrameError(
  error: unknown,
  context: FrameErrorDetail = {},
  direction: Direction = "export",
): FrameError {
  if (error instanceof FrameFailure) {
    const detail = { ...context, ...error.detail };
    return { code: error.code, message: error.message, ...(isEmpty(detail) ? {} : { detail }) };
  }
  if (error instanceof ExportError) {
    const { path, type, reason } = error.detail;
    const detail = { ...context, path, type, ...(reason === undefined ? {} : { reason }) };
    return { code: error.code, message: error.message, detail };
  }
  if (error instanceof SnapError && direction === "import") {
    // A data file the importer cannot read as recorded (a RegExp that does not compile is one).
    return { code: "IMP_RECORD_INVALID", message: error.message, detail: context };
  }
  const name = errorName(error) ?? "Error";
  return { code: "INTERNAL", message: `unexpected ${name} in the frame`, detail: context };
}

const isEmpty = (detail: FrameErrorDetail) => Object.keys(detail).length === 0;

/** Runs one command and returns its outcome as a value. */
export async function settle<T>(
  run: () => Promise<T>,
  direction: Direction = "export",
): Promise<FrameResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: toFrameError(error, {}, direction) };
  }
}

/** Adds where a failure happened (database, store, record) and rethrows it as a FrameFailure. */
export async function within<T>(
  context: FrameErrorDetail,
  run: () => Promise<T>,
  direction: Direction = "export",
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const value = toFrameError(error, context, direction);
    throw new FrameFailure(value.code, value.message, value.detail);
  }
}

/** The synchronous form of `within`. */
export function at<T>(context: FrameErrorDetail, run: () => T, direction: Direction = "export"): T {
  try {
    return run();
  } catch (error) {
    const value = toFrameError(error, context, direction);
    throw new FrameFailure(value.code, value.message, value.detail);
  }
}
