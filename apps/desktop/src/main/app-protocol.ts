// The privileged `app://launcher` scheme that serves the launcher UI (security.md section 6).
//
// - `registerAppScheme()` runs once before `ready` with exactly `standard`, `secure`, `supportFetchAPI` and `codeCache`.
// - `handleAppProtocol()` is installed on the launcher's session only. It serves files from the built renderer
//   directory and covers from `covers/` with the exact name pattern; everything else is 404. Every response,
//   404 included, carries the CSP and the security headers below.

import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { protocol, type Session } from "electron";

export const APP_SCHEME = "app";
export const LAUNCHER_HOST = "launcher";
export const LAUNCHER_ORIGIN = `${APP_SCHEME}://${LAUNCHER_HOST}`;
export const LAUNCHER_URL = `${LAUNCHER_ORIGIN}/`;

/** Not `bypassCSP`, `corsEnabled`, `allowServiceWorkers`, `stream` or `allowExtensions`. */
export const APP_SCHEME_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  codeCache: true,
});

export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": PRODUCTION_CSP,
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
});

const RENDERER_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
const COVER_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * `covers/<gameId>-<random>.<png|jpg|webp>` (architecture.md section 3): a lowercase UUIDv7, a dash, 16 lowercase
 * hex digits (8 random bytes) and the extension. Whoever writes covers (Task 9) must use exactly this form.
 */
export const COVER_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{16}\.(?:png|jpg|webp)$/;

export interface AppTarget {
  file: string;
  contentType: string;
}

export interface AppRoots {
  rendererDir: string;
  coversDir: string;
}

/** Decodes one path segment exactly once; null for anything that could name another directory. */
function decodeSegment(segment: string): string | null {
  if (segment === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded === "." || decoded === "..") return null;
  if (/[/\\:\0]/.test(decoded)) return null;
  return decoded;
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Maps an `app://launcher/...` URL to a file, or null (404). Pure: no file system access. The URL parser already
 * removes `.` and `..` segments (also as `%2e`); each remaining segment is decoded once and refused if it holds a
 * separator, a drive colon, NUL or a dot segment, and the joined path must stay inside its root.
 */
export function resolveAppUrl(url: string, roots: AppRoots): AppTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== LAUNCHER_HOST) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;

  const raw = parsed.pathname === "/" ? ["index.html"] : parsed.pathname.slice(1).split("/");
  const segments: string[] = [];
  for (const segment of raw) {
    const decoded = decodeSegment(segment);
    if (decoded === null) return null;
    segments.push(decoded);
  }

  if (segments[0] === "covers") {
    const name = segments[1];
    if (segments.length !== 2 || name === undefined || !COVER_NAME.test(name)) return null;
    const contentType = COVER_TYPES[extname(name)];
    return contentType ? { file: join(roots.coversDir, name), contentType } : null;
  }

  const file = resolve(roots.rendererDir, ...segments);
  if (!isInside(roots.rendererDir, file)) return null;
  const contentType = RENDERER_TYPES[extname(file)];
  return contentType ? { file, contentType } : null;
}

/** Registers the scheme's privileges. Must run once, before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } },
  ]);
}

function respond(status: number, body: Uint8Array | null, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": contentType },
  });
}

const notFound = () =>
  respond(404, new TextEncoder().encode("Not Found\n"), "text/plain; charset=utf-8");

/**
 * Serves `app://launcher` on `session` only. Besides the pure URL check, the real path of the file (symbolic links
 * resolved) must still be inside the real path of its root.
 */
export function handleAppProtocol(session: Session, rendererDir: string, coversDir: string): void {
  const roots: AppRoots = { rendererDir: resolve(rendererDir), coversDir: resolve(coversDir) };
  session.protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();
    const target = resolveAppUrl(request.url, roots);
    if (target === null) return notFound();
    const root = isInside(roots.coversDir, target.file) ? roots.coversDir : roots.rendererDir;
    try {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(target.file)]);
      if (!isInside(realRoot, realFile)) return notFound();
      const body = await readFile(realFile);
      return respond(200, request.method === "HEAD" ? null : body, target.contentType);
    } catch {
      return notFound();
    }
  });
}
