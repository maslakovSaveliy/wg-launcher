// The single redaction step every log record goes through (security.md section 9, S-12, AC-20).
//
// Callers must still never pass storage values, localStorage key names, record contents or snapshot bytes to the
// logger; this function is the safety net for what does reach it:
// - http, https, ws and wss URLs, also inside longer strings, become their origin (paths, queries and fragments can
//   hold tokens; user info is dropped with them);
// - `wglauncher:` deep-link input becomes its length only;
// - the home directory becomes `~`;
// - `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` entries are dropped at any depth;
// - binary data becomes a byte count; errors keep their name, code, message and stack, each redacted.

import { homedir } from "node:os";

const DROPPED_KEYS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>]+/gi;
const DEEP_LINK_IN_TEXT = /\bwglauncher:[^\s"'`<>]*/gi;
const MAX_DEPTH = 8;

/** A log record: plain data with string keys. */
export type LogRecord = Record<string, unknown>;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the home directory, written with either separator, when a separator or the end follows it. */
function homePattern(home: string): RegExp | null {
  const trimmed = home.replace(/[\\/]+$/, "");
  if (trimmed.length < 2) return null;
  const variants = new Set([trimmed, trimmed.replaceAll("\\", "/")]);
  const alternatives = [...variants].map(escapeRegExp).join("|");
  return new RegExp(`(?:${alternatives})(?=$|[\\\\/])`, "g");
}

function originOf(text: string): string {
  // Trailing punctuation is more likely prose than part of the URL.
  const match = /^(.*?)([.,;:!?)\]]*)$/.exec(text);
  const candidate = match?.[1] ?? text;
  const tail = match?.[2] ?? "";
  try {
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}${tail}`;
  } catch {
    return "[url]";
  }
}

function redactText(text: string, home: RegExp | null): string {
  let out = text.replace(DEEP_LINK_IN_TEXT, (link) => `[deep link, ${link.length} chars]`);
  out = out.replace(URL_IN_TEXT, originOf);
  if (home) out = out.replace(home, "~");
  return out;
}

function byteLength(value: unknown): number | null {
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return null;
}

function redactValue(
  value: unknown,
  home: RegExp | null,
  seen: Set<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactText(value, home);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value === null || typeof value !== "object") return value;

  const bytes = byteLength(value);
  if (bytes !== null) return `[${bytes} bytes]`;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "[invalid date]" : value.toISOString();
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[too deep]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      const code = (value as { code?: unknown }).code;
      const out: LogRecord = { name: value.name, message: redactText(value.message, home) };
      if (typeof code === "string" || typeof code === "number") out.code = code;
      if (value.stack) out.stack = redactText(value.stack, home);
      return out;
    }
    if (Array.isArray(value)) return value.map((item) => redactValue(item, home, seen, depth + 1));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      return `[${proto?.constructor?.name ?? "object"}]`;
    const out: LogRecord = {};
    for (const [key, item] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key.toLowerCase())) continue;
      out[redactText(key, home)] = redactValue(item, home, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Returns a redacted copy of `record`; the input is not changed.
 * @param home the home directory to replace with `~` (the current user's by default)
 */
export function redact(record: LogRecord, home: string = homedir()): LogRecord {
  return redactValue(record, homePattern(home), new Set(), 0) as LogRecord;
}
