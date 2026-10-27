import { describe, expect, it } from "vitest";
import { siteOf } from "./site.js";

// architecture.md section 5: one function decides "same site": the scheme plus the registrable domain from the
// Public Suffix List (private section included), or the host itself for IP addresses and `localhost`.

describe("siteOf", () => {
  it("is the scheme plus the registrable domain", () => {
    expect(siteOf("https://example.com")).toBe("https://example.com");
    expect(siteOf("https://www.example.com")).toBe("https://example.com");
    expect(siteOf("https://a.b.c.example.com")).toBe("https://example.com");
  });

  it("takes a full URL and uses only its origin; the port never matters", () => {
    expect(siteOf("https://www.example.com:8443/path?q=1#h")).toBe("https://example.com");
    expect(siteOf("https://example.com:1")).toBe(siteOf("https://example.com:2"));
  });

  it("is schemeful: http and https are different sites", () => {
    expect(siteOf("http://example.com")).toBe("http://example.com");
    expect(siteOf("http://example.com")).not.toBe(siteOf("https://example.com"));
  });

  it("separates two registrable domains under co.uk and keeps subdomains together", () => {
    expect(siteOf("https://a.co.uk")).toBe("https://a.co.uk");
    expect(siteOf("https://b.co.uk")).toBe("https://b.co.uk");
    expect(siteOf("https://www.a.co.uk")).toBe("https://a.co.uk");
  });

  it("uses the private section of the PSL: github.io siblings are different sites", () => {
    expect(siteOf("https://a.github.io")).toBe("https://a.github.io");
    expect(siteOf("https://b.github.io")).toBe("https://b.github.io");
    expect(siteOf("https://x.a.github.io")).toBe("https://a.github.io");
  });

  it("uses the whole host when there is no registrable domain, so hosts never collapse into one site", () => {
    expect(siteOf("https://co.uk")).toBe("https://co.uk");
    expect(siteOf("https://github.io")).toBe("https://github.io");
    expect(siteOf("http://intranet")).toBe("http://intranet");
    expect(siteOf("http://other")).toBe("http://other");
  });

  it("uses the host itself for IP addresses and localhost", () => {
    expect(siteOf("http://127.0.0.1:4417")).toBe("http://127.0.0.1");
    expect(siteOf("http://localhost:5173")).toBe("http://localhost");
    expect(siteOf("https://192.168.0.10")).toBe("https://192.168.0.10");
    expect(siteOf("https://192.168.0.11")).toBe("https://192.168.0.11");
    expect(siteOf("http://[::1]:8080")).toBe("http://[::1]");
    expect(siteOf("http://localhost")).not.toBe(siteOf("http://127.0.0.1"));
  });

  it("uses the parser's normalized host: upper case, IPv4 in other notations, percent-encoding", () => {
    expect(siteOf("HTTPS://WWW.EXAMPLE.COM")).toBe("https://example.com");
    expect(siteOf("http://2130706433/")).toBe("http://127.0.0.1");
    expect(siteOf("https://ex%61mple.com")).toBe("https://example.com");
  });

  it("keeps an IDN lookalike apart from the ASCII name (punycode host)", () => {
    // "exаmple.com" with a Cyrillic "а" (U+0430).
    expect(siteOf("https://ex\u0430mple.com")).toBe("https://xn--exmple-4nf.com");
    expect(siteOf("https://ex\u0430mple.com")).not.toBe(siteOf("https://example.com"));
  });

  it("does not let a lookalike suffix or prefix share the site", () => {
    expect(siteOf("https://example.com.evil.net")).toBe("https://evil.net");
    expect(siteOf("https://evil-example.com")).toBe("https://evil-example.com");
  });

  it("uses the whole host when a label is empty (tldts would give `.com` for `example..com`)", () => {
    expect(siteOf("https://example..com")).toBe("https://example..com");
    expect(siteOf("https://example..com")).not.toBe(siteOf("https://evil..com"));
    expect(siteOf("https://a..co.uk")).not.toBe(siteOf("https://b..co.uk"));
    expect(siteOf("https://x.a..github.io")).not.toBe(siteOf("https://y.b..github.io"));
    // A leading empty label must not merge with the name after it.
    expect(siteOf("https://.example.com")).toBe("https://.example.com");
    expect(siteOf("https://.example.com")).not.toBe(siteOf("https://example.com"));
    expect(siteOf("https://example.com..")).toBe("https://example.com..");
  });

  it("treats a host with a trailing dot as its own site (tldts would give `com.`)", () => {
    expect(siteOf("https://example.com.")).toBe("https://example.com.");
    expect(siteOf("https://www.example.com.")).toBe("https://www.example.com.");
    expect(siteOf("https://example.com.")).not.toBe(siteOf("https://example.com"));
  });

  it("throws a TypeError for input without a host (opaque origins, unparsable text)", () => {
    for (const input of [
      "null",
      "",
      "not a url",
      "data:text/html,x",
      "about:blank",
      "javascript:1",
    ]) {
      expect(() => siteOf(input), input).toThrow(TypeError);
    }
  });
});
