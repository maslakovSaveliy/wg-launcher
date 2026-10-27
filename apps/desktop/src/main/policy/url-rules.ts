// URL decisions of security.md section 5 (AC-5) and architecture.md section 12 (AC-17) as pure functions. No
// Electron import: Task 8 wires them to `will-navigate`, `will-redirect`, `will-frame-navigate`, the window-open
// handler and `shell.openExternal`; the library's add handler calls `checkEntryUrl`.
//
// Every allow decision comes from the WHATWG parser (`new URL`), never from a string prefix. On top of that, an
// http or https input is refused before parsing when its raw text has a shape the parser would silently repair,
// because a repair is where two parsers (ours, Chromium's, the OS's) can disagree (Assumed rules, security.md
// section 5):
// - control characters, spaces and DEL anywhere (the parser trims or drops them: " https://x", "exa\tmple.com");
// - a backslash anywhere (the parser reads it as "/" for special schemes: "https:\\evil.com");
// - a scheme not followed by exactly "//" and a host ("https:evil.com", "https:///evil.com");
// - "@" or "%" in the authority (user info in any form, also empty as in "https://@evil.com"; percent-encoded host
//   characters such as "exa%2Emple.com", which the parser decodes into another host).
// After parsing, a host with an empty label ("example..com", ".example.com") is refused: it is never a real site, and
// tldts would give it a domain such as ".com" that merges unrelated hosts.
// Lengths are measured on the raw input before parsing and again on `href`, which percent-encoding can lengthen.

import type { Result } from "@wg-launcher/shared";
import type { Flavor } from "../flavor.js";
import { hasEmptyLabel, siteOf } from "./site.js";

export const MAX_URL_LENGTH = 2048;

export type TopNavigationDecision = "allow" | "ask-external" | "block";
export type FrameNavigationDecision = "allow" | "block";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const UNSAFE_CHARACTERS = /[\u0000-\u0020\u007f\\]/;
/** Scheme, then exactly "//", then the authority up to the first "/", "?" or "#". */
const HIERARCHICAL = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;
/** The literal development hosts of PRD OQ-3, with an optional port. Other spellings of 127.0.0.1 do not count. */
const DEV_AUTHORITY = /^(?:localhost|127\.0\.0\.1)(?::\d*)?$/i;
const DEV_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/** Development origins exist only in dev and test builds; production code passes the compile-time `FLAVOR`. */
const devOriginsAllowed = (flavor: Flavor): boolean => flavor === "dev" || flavor === "test";

interface ParsedWebUrl {
  url: URL;
  /** True when the raw authority is literally `localhost` or `127.0.0.1` (any port) and the parsed host agrees. */
  devHost: boolean;
}

/**
 * Parses an http or https URL whose raw text has none of the repaired shapes above, with a host and no user info.
 * Returns null for anything else (other schemes included). Never throws.
 */
function parseWebUrl(input: unknown): ParsedWebUrl | null {
  if (typeof input !== "string" || UNSAFE_CHARACTERS.test(input)) return null;
  const authority = HIERARCHICAL.exec(input)?.[1];
  if (!authority || authority.includes("@") || authority.includes("%")) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "" || url.username !== "" || url.password !== "") return null;
  if (hasEmptyLabel(url.hostname)) return null;
  return { url, devHost: DEV_AUTHORITY.test(authority) && DEV_HOSTS.has(url.hostname) };
}

/** https always; http only for a literal development host in a dev or test build. */
const isAllowedGameUrl = ({ url, devHost }: ParsedWebUrl, flavor: Flavor): boolean =>
  url.protocol === "https:" || (url.protocol === "http:" && devHost && devOriginsAllowed(flavor));

const NOT_ALLOWED: Result<never, "URL_NOT_ALLOWED"> = {
  ok: false,
  code: "URL_NOT_ALLOWED",
  message: "Only https web addresses with a host and no user name or password can be added.",
};

/**
 * The library's entry-URL rule (architecture.md section 12): https, a host, no user info, at most 2048
 * characters, stored as `url.href`; dev and test builds also accept `http://localhost` and `http://127.0.0.1`
 * on any port. The input is not trimmed: the renderer may trim visibly before sending.
 */
export function checkEntryUrl(input: string, flavor: Flavor): Result<string, "URL_NOT_ALLOWED"> {
  if (typeof input !== "string" || input.length > MAX_URL_LENGTH) return NOT_ALLOWED;
  const parsed = parseWebUrl(input);
  if (!parsed || !isAllowedGameUrl(parsed, flavor) || parsed.url.href.length > MAX_URL_LENGTH) {
    return NOT_ALLOWED;
  }
  return { ok: true, data: parsed.url.href };
}

/**
 * `will-navigate` and `will-redirect` of a game's main frame. `allow`: an allowed game URL on the entry's site
 * (www and apex are one site). `ask-external`: another http or https site; the caller prevents the navigation and,
 * if `isExternalUrlAllowed`, asks "Open in browser?". `block`: every other scheme, a malformed or
 * credential-carrying target, or an entry that is itself not an allowed entry URL in this flavor.
 */
export function decideTopNavigation(
  entryUrl: URL,
  target: string,
  flavor: Flavor,
): TopNavigationDecision {
  if (!(entryUrl instanceof URL) || !checkEntryUrl(entryUrl.href, flavor).ok) return "block";
  const parsed = parseWebUrl(target);
  if (!parsed) return "block";
  if (!isAllowedGameUrl(parsed, flavor)) return "ask-external";
  return siteOf(parsed.url.href) === siteOf(entryUrl.href) ? "allow" : "ask-external";
}

const FRAME_SCHEMES: ReadonlySet<string> = new Set(["https:", "http:", "blob:", "data:"]);
const FRAME_ABOUT_PAGES: ReadonlySet<string> = new Set(["blank", "srcdoc"]);

/**
 * `will-frame-navigate` of a subframe: https, http, `about:blank`, `about:srcdoc`, `blob:` and `data:` are
 * allowed (a query or fragment on the two about pages does not matter); every other scheme is blocked.
 */
export function decideFrameNavigation(target: string): FrameNavigationDecision {
  if (typeof target !== "string") return "block";
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "block";
  }
  if (FRAME_SCHEMES.has(url.protocol)) return "allow";
  return url.protocol === "about:" && FRAME_ABOUT_PAGES.has(url.pathname) ? "allow" : "block";
}

/**
 * The only gate before `shell.openExternal` (AGENTS.md security invariant 5): it parses, the scheme is https or
 * http, there is a host and no user info, and it is at most 2048 characters. The caller opens `new URL(url).href`
 * and shows the punycode host in its confirmation.
 */
export function isExternalUrlAllowed(url: string): boolean {
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return false;
  const parsed = parseWebUrl(url);
  return parsed !== null && parsed.url.href.length <= MAX_URL_LENGTH;
}
