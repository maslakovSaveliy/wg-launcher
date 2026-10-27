// Untrusted launch input of architecture.md section 8 (AC-19, S-11): the `wglauncher://launch/<gameId>` deep link
// (macOS `open-url`, or a command-line argument on Windows) and the `--launch-game=<gameId>` argument of a
// shortcut. Pure and total: never throws. A result never carries the raw value, only its length, so callers can
// log it without logging attacker-chosen text.
//
// Rules (Assumed details):
// - A deep link must be exactly `wglauncher://launch/` followed by a lowercase UUIDv7 (`isUuidV7`), nothing else:
//   no trailing slash, query, fragment, port, user info, extra segment, upper case or surrounding space.
// - On a command line, a launch argument is one that starts with `--launch-game` or with `wglauncher:` (both
//   compared case-insensitively, so `--LAUNCH-GAME=` or `WGLAUNCHER://` are launch arguments, and invalid). All
//   other arguments (the executable, the app path, Electron and Chromium switches, `--`) are ignored.
// - No launch argument is `none`; exactly one is parsed; two or more, even identical ones, are `invalid`, because
//   an extra argument may have been injected.
// - Nothing is split: an argument with spaces or `--` inside is one value, which fails the id pattern.

import { isUuidV7 } from "@wg-launcher/shared";

export type LaunchInput =
  | { kind: "launch"; gameId: string }
  | { kind: "invalid"; length: number }
  | { kind: "none" };

const DEEP_LINK_PREFIX = "wglauncher://launch/";
const ARGUMENT_PREFIX = "--launch-game=";

const invalid = (value: unknown): LaunchInput => ({
  kind: "invalid",
  length: typeof value === "string" ? value.length : 0,
});

/** The whole string must be the prefix plus a lowercase UUIDv7, which is the regex of architecture.md section 8. */
export function parseDeepLink(url: string): LaunchInput {
  if (typeof url !== "string" || !url.startsWith(DEEP_LINK_PREFIX)) return invalid(url);
  const gameId = url.slice(DEEP_LINK_PREFIX.length);
  return isUuidV7(gameId) ? { kind: "launch", gameId } : invalid(url);
}

const isLaunchArgument = (arg: string): boolean => {
  const lower = arg.toLowerCase();
  return lower.startsWith("--launch-game") || lower.startsWith("wglauncher:");
};

/** `argv` as Electron gives it (`process.argv`, or the `second-instance` event's argv). */
export function parseLaunchInput(argv: readonly string[]): LaunchInput {
  if (!Array.isArray(argv)) return { kind: "none" };
  const candidates = argv.filter(
    (arg): arg is string => typeof arg === "string" && isLaunchArgument(arg),
  );
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) {
    return { kind: "invalid", length: candidates.reduce((sum, arg) => sum + arg.length, 0) };
  }
  const [arg = ""] = candidates;
  if (arg.startsWith(ARGUMENT_PREFIX)) {
    const gameId = arg.slice(ARGUMENT_PREFIX.length);
    return isUuidV7(gameId) ? { kind: "launch", gameId } : invalid(arg);
  }
  return parseDeepLink(arg);
}
