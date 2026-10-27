// The one same-site function of architecture.md section 5. Pure: no Electron import, no I/O.
//
// The site is the scheme plus the registrable domain from the Public Suffix List, ICANN and private sections both
// (`allowPrivateDomains`, so `a.github.io` and `b.github.io` are different sites, as Chromium's schemeful site is
// Assumed to treat them). Ports never matter. Where no registrable domain exists the whole host is the site, so two
// different hosts never collapse into one site:
// - IPv4 and bracketed IPv6 addresses, and `localhost`;
// - a bare public suffix (`co.uk`, `github.io`) or a single-label host (`intranet`);
// - a host with a trailing dot (`example.com.`): tldts 7.4.19 reports its domain as `com.`, which would merge every
//   trailing-dot host under one TLD, so such a host is kept whole (stricter than Chromium; Assumed harmless).
// The host is the WHATWG parser's normalized ASCII host (lower case, punycode, IPv4 in dotted decimal).

import { parse } from "tldts";

const PSL_OPTIONS = { allowPrivateDomains: true, extractHostname: false } as const;

/** WHATWG serializes every IPv4 host as four dotted decimal numbers, whatever notation the input used. */
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function hostSite(host: string): string {
  if (host.startsWith("[") || IPV4.test(host) || host === "localhost" || host.endsWith("."))
    return host;
  const result = parse(host, PSL_OPTIONS);
  if (result.isIp) return host;
  return result.domain ?? host;
}

/**
 * The site of an origin, or of a URL whose origin is used: `scheme://registrable-domain` or `scheme://host`.
 * Throws a `TypeError` for input that does not parse or has no host (opaque origins such as `null`, `data:`,
 * `about:`); callers decide the scheme first and only ask for the site of a URL with a host.
 */
export function siteOf(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError("siteOf: not a URL");
  }
  if (url.hostname === "") throw new TypeError("siteOf: the URL has no host");
  return `${url.protocol}//${hostSite(url.hostname)}`;
}
