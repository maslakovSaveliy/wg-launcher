// The main-process log: `logs/main.log`, one JSON record per line, rotated (security.md section 9).
// Every record goes through `redact`. Writes are queued and asynchronous, so logging never blocks the main thread
// (architecture.md section 13), and a failing write never throws into the caller.

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type LogRecord, redact } from "./redact.js";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(event: string, fields?: LogRecord): void;
  warn(event: string, fields?: LogRecord): void;
  error(event: string, fields?: LogRecord): void;
  /** Resolves when every record logged so far has been written. */
  flush(): Promise<void>;
}

export interface LoggerOptions {
  maxBytes?: number;
  /** main.log plus rotated main.log.1 to main.log.<maxFiles - 1>. */
  maxFiles?: number;
  now?: () => Date;
  home?: string;
}

const FILE = "main.log";
const DEFAULTS = { maxBytes: 5 * 1024 * 1024, maxFiles: 5 } as const;

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export function createLogger(logsDir: string, options: LoggerOptions = {}): Logger {
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
  const now = options.now ?? (() => new Date());
  const file = join(logsDir, FILE);
  let size: number | null = null;
  let queue: Promise<void> = mkdir(logsDir, { recursive: true }).then(() => undefined);
  let reportedFailure = false;

  const rotate = async () => {
    await rm(`${file}.${maxFiles - 1}`, { force: true });
    for (let i = maxFiles - 2; i >= 1; i--) {
      await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => undefined);
    }
    await rename(file, `${file}.1`);
    size = 0;
  };

  const write = async (line: string) => {
    size ??= await sizeOf(file);
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) await rotate();
    await appendFile(file, line);
    size += bytes;
  };

  const log = (level: LogLevel, event: string, fields: LogRecord = {}) => {
    const head = { time: now().toISOString(), level, event };
    // The head keys come first and cannot be overridden by a field of the same name.
    const record = redact(Object.assign({ ...head }, fields, head), options.home);
    const line = `${JSON.stringify(record)}\n`;
    queue = queue
      .then(() => write(line))
      .catch((error: unknown) => {
        size = null;
        if (!reportedFailure) {
          reportedFailure = true;
          console.error("WGLauncher: writing the log failed", redact({ error }, options.home));
        }
      });
  };

  return {
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    flush: () => queue,
  };
}

/** The production limits: 5 files of 5 MiB (architecture.md section 3). */
createLogger.defaults = DEFAULTS;
