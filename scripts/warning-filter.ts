// The one warning the Vitest setup drops (scripts/vitest-setup.ts).

const SQLITE_NOTICE = "SQLite is an experimental feature";

/** The part of `process` this module wraps. */
export interface WarningTarget {
  emitWarning: (warning: string | Error, ...rest: never[]) => void;
}

/**
 * Wraps `target.emitWarning` so that node:sqlite's experimental-feature notice (printed by plain Node 24 when the
 * module loads, never by Electron 45's Node) is dropped. Every other call, including any other ExperimentalWarning,
 * is passed on unchanged.
 */
export function dropSqliteNotice(target: WarningTarget): void {
  const original = target.emitWarning;
  target.emitWarning = (warning, ...rest) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.startsWith(SQLITE_NOTICE)) return;
    return original.call(target, warning, ...rest);
  };
}
