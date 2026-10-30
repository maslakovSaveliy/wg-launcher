// The quiescent window's stub documents (save-transfer.md section 5, steps 7 and QW-10): our own empty page at a game
// origin, served by the interceptor and never by the network. A stub is `text/html` with `Cache-Control: no-store`
// and a CSP that runs no script, loads nothing and frames only the job's iframe stub origins; its body holds only
// those iframes. The preload still runs in it (a page CSP does not restrict a preload: the spike's subframe preload
// worked under `script-src 'none'`, RESULTS.md H14c).

import { STUB_PATH } from "./channels.js";

export { STUB_PATH };

/** The CSP of every stub before its `frame-src`. */
export const STUB_CSP_BASE =
  "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'";

/**
 * The stub URL at `origin` for the job `jobNonce`. A frame that resolves a storage key carries its manifest index
 * `key`; a top-level page that only hosts iframes has none (its own storage is not part of the job).
 */
export function stubUrl(origin: string, jobNonce: string, key?: number): string {
  const url = new URL(STUB_PATH, origin);
  url.searchParams.set("job", jobNonce);
  if (key !== undefined) url.searchParams.set("key", String(key));
  return url.href;
}

export interface StubPage {
  headers: Record<string, string>;
  body: string;
}

const HEAD = '<!doctype html><html><head><meta charset="utf-8"><title>WGLauncher</title></head>';

const escapeAttribute = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** A stub holding one iframe per URL of `iframes` (themselves stub URLs of the job). */
export function stubPage(iframes: readonly string[]): StubPage {
  const origins = [...new Set(iframes.map((url) => new URL(url).origin))];
  const frameSrc = origins.length > 0 ? origins.join(" ") : "'none'";
  const frames = iframes.map((url) => `<iframe src="${escapeAttribute(url)}"></iframe>`).join("");
  return {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `${STUB_CSP_BASE}; frame-src ${frameSrc}`,
    },
    body: `${HEAD}<body>${frames}</body></html>`,
  };
}
