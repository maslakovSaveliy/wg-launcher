import { describe, expect, it } from "vitest";
import type { Flavor } from "../flavor.js";
import {
  checkEntryUrl,
  decideFrameNavigation,
  decideTopNavigation,
  isExternalUrlAllowed,
  MAX_URL_LENGTH,
} from "./url-rules.js";

// security.md section 5 (AC-5, S-5) and architecture.md section 12 (AC-17). A false "allow" is the worst failure,
// so every hostile shape below must be refused.

const FLAVORS: readonly Flavor[] = ["dev", "test", "prod"];
const DEV_FLAVORS: readonly Flavor[] = ["dev", "test"];

/** A URL of exactly `length` characters on example.com. */
const urlOfLength = (length: number) => {
  const head = "https://example.com/";
  return head + "a".repeat(length - head.length);
};

// Inputs that are never an entry URL, never an allowed top-level target and never opened externally.
const HOSTILE_EVERYWHERE: readonly string[] = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "JavaScript:alert(1)",
  "  javascript:alert(1)",
  "\tjavascript:alert(1)",
  "java\nscript:alert(1)",
  "file:///etc/passwd",
  "FILE:///C:/Windows/win.ini",
  "wglauncher://launch/01890a5d-ac96-774b-bcce-b302099a8057",
  "app://launcher/index.html",
  "chrome://settings",
  "devtools://devtools/bundled/inspector.html",
  "data:text/html,<script>alert(1)</script>",
  "blob:https://example.com/0f3c1e5a-1111-4222-8333-444455556666",
  "about:blank",
  "about:srcdoc",
  "ftp://example.com/",
  "ws://example.com/",
  "mailto:a@example.com",
  // A fake credential in a URL is the test input itself (security.md section 5, S-5).
  // secretlint-disable-next-line
  "https://user:pass@example.com/",
  "https://user@example.com/",
  "https://example.com@evil.net/",
  "https://good.example@evil.example/",
  "https://@evil.com/",
  "https://:@evil.com/",
  "https:\\\\evil.com",
  "https:/\\evil.com",
  "https://example.com\\@evil.net",
  // Reads as a subdomain of example.com but parses as host evil.com with path "/.example.com"; only the backslash
  // refusal catches it.
  "https://evil.com\\.example.com/",
  // Hosts with an empty label: tldts gives domain `.com` for `example..com`, which would merge such hosts.
  "https://example..com/",
  "https://evil..com/",
  "https://.example.com/",
  "https://example.com../",
  "https://a..co.uk/",
  "https://x.a..github.io/",
  "https://./",
  "https://../",
  "https:evil.com",
  "https:///evil.com",
  "https://exa%2Emple.com/",
  "https://ex%61mple.com/",
  " https://example.com/",
  "https://example.com/ ",
  "https://exa\tmple.com/",
  "https://example.com/\n",
  "https://exa\u0000mple.com/",
  "https://example.com/\u007f",
  "",
  "https://",
  "not a url",
  urlOfLength(MAX_URL_LENGTH + 1),
];

/** Hostile inputs whose only raw shape comes after the authority of `https://example.com`. */
const TAIL_ONLY = ["https://example.com/ ", "https://example.com/\n", "https://example.com/\u007f"];

describe("MAX_URL_LENGTH", () => {
  it("is 2048 characters", () => {
    expect(MAX_URL_LENGTH).toBe(2048);
  });
});

describe("checkEntryUrl", () => {
  it("accepts an https URL and returns url.href", () => {
    for (const flavor of FLAVORS) {
      expect(checkEntryUrl("https://example.com", flavor)).toEqual({
        ok: true,
        data: "https://example.com/",
      });
      expect(checkEntryUrl("https://games.example.co.uk:8443/play/?level=2#start", flavor)).toEqual(
        {
          ok: true,
          data: "https://games.example.co.uk:8443/play/?level=2#start",
        },
      );
    }
  });

  it("normalizes upper case and stores the punycode host of an IDN", () => {
    expect(checkEntryUrl("HTTPS://WWW.EXAMPLE.COM/Play", "prod")).toEqual({
      ok: true,
      data: "https://www.example.com/Play",
    });
    expect(checkEntryUrl("https://ex\u0430mple.com/", "prod")).toEqual({
      ok: true,
      data: "https://xn--exmple-4nf.com/",
    });
  });

  it("accepts https on an IP address or localhost (a host is all the rule needs)", () => {
    expect(checkEntryUrl("https://192.168.0.10/", "prod")).toMatchObject({ ok: true });
    expect(checkEntryUrl("https://[::1]:8443/", "prod")).toMatchObject({ ok: true });
  });

  it("refuses every hostile input with URL_NOT_ALLOWED and a short message", () => {
    for (const flavor of FLAVORS) {
      for (const input of HOSTILE_EVERYWHERE) {
        const result = checkEntryUrl(input, flavor);
        expect(result.ok, `${flavor}: ${JSON.stringify(input)}`).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("URL_NOT_ALLOWED");
          expect(result.message.length).toBeGreaterThan(0);
          expect(result.message).not.toContain(input.trim() || "\u0000never");
        }
      }
    }
  });

  it("measures the length before parsing: 2048 characters pass, 2049 fail", () => {
    expect(checkEntryUrl(urlOfLength(2048), "prod")).toEqual({ ok: true, data: urlOfLength(2048) });
    expect(checkEntryUrl(urlOfLength(2049), "prod")).toMatchObject({ ok: false });
  });

  it("refuses a URL whose href grows past 2048 characters through percent-encoding", () => {
    // 1000 "é" are 1020 input characters but 6000+ characters once encoded as %C3%A9.
    const input = `https://example.com/${"\u00e9".repeat(1000)}`;
    expect(input.length).toBeLessThanOrEqual(2048);
    expect(checkEntryUrl(input, "prod")).toMatchObject({ ok: false, code: "URL_NOT_ALLOWED" });
  });

  it("refuses plain http in every flavor except for the two development hosts", () => {
    for (const flavor of FLAVORS) {
      expect(checkEntryUrl("http://example.com/", flavor)).toMatchObject({ ok: false });
      expect(checkEntryUrl("http://192.168.0.10/", flavor)).toMatchObject({ ok: false });
    }
  });

  it("accepts http://localhost and http://127.0.0.1 on any port in dev and test builds only", () => {
    for (const flavor of DEV_FLAVORS) {
      expect(checkEntryUrl("http://localhost:4417/", flavor)).toEqual({
        ok: true,
        data: "http://localhost:4417/",
      });
      expect(checkEntryUrl("http://127.0.0.1:5173/index.html", flavor)).toEqual({
        ok: true,
        data: "http://127.0.0.1:5173/index.html",
      });
      expect(checkEntryUrl("http://localhost/", flavor)).toMatchObject({ ok: true });
      expect(checkEntryUrl("http://LOCALHOST:1/", flavor)).toMatchObject({
        ok: true,
        data: "http://localhost:1/",
      });
    }
    expect(checkEntryUrl("http://localhost:4417/", "prod")).toMatchObject({ ok: false });
    expect(checkEntryUrl("http://127.0.0.1:4417/", "prod")).toMatchObject({ ok: false });
  });

  it("accepts only the literal development hosts, not other spellings the parser maps to them", () => {
    const lookalikes = [
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://127.0.0.2/",
      "http://[::1]/",
      "http://localhost./",
      "http://sub.localhost/",
      "http://localhost.example.com/",
      "http://user@localhost/",
      "http://localhost@evil.com/",
    ];
    for (const flavor of FLAVORS) {
      for (const input of lookalikes) {
        expect(checkEntryUrl(input, flavor).ok, `${flavor}: ${input}`).toBe(false);
      }
    }
  });

  it("never throws on any input", () => {
    for (const input of [...HOSTILE_EVERYWHERE, "%", "https://[", "https://a b.com", "\ud800"]) {
      expect(() => checkEntryUrl(input, "prod")).not.toThrow();
    }
  });
});

describe("decideTopNavigation", () => {
  const entry = new URL("https://example.com/game/");

  it("allows the same site, including www and apex redirects both ways (Review Focus 1)", () => {
    for (const flavor of FLAVORS) {
      expect(decideTopNavigation(entry, "https://example.com/level/2", flavor)).toBe("allow");
      expect(decideTopNavigation(entry, "https://www.example.com/", flavor)).toBe("allow");
      expect(
        decideTopNavigation(new URL("https://www.example.com/"), "https://example.com/", flavor),
      ).toBe("allow");
      expect(decideTopNavigation(entry, "https://cdn.example.com:8443/x?y#z", flavor)).toBe(
        "allow",
      );
    }
  });

  it("asks before sending another http or https site to the browser", () => {
    const others = [
      "https://login.other.com/",
      "https://example.com.evil.net/",
      "https://evil-example.com/",
      "https://example.co.uk/",
      "https://xn--exmple-4nf.com/",
      "https://ex\u0430mple.com/",
      "http://example.com/",
      "http://www.example.com/",
      "https://192.168.0.10/",
      "https://example.com./",
      "https://com/",
    ];
    for (const flavor of FLAVORS) {
      for (const target of others) {
        expect(decideTopNavigation(entry, target, flavor), `${flavor}: ${target}`).toBe(
          "ask-external",
        );
      }
    }
  });

  it("separates co.uk siblings and github.io siblings", () => {
    expect(decideTopNavigation(new URL("https://a.co.uk/"), "https://b.co.uk/", "prod")).toBe(
      "ask-external",
    );
    expect(decideTopNavigation(new URL("https://a.co.uk/"), "https://www.a.co.uk/", "prod")).toBe(
      "allow",
    );
    expect(
      decideTopNavigation(new URL("https://a.github.io/"), "https://b.github.io/", "prod"),
    ).toBe("ask-external");
    expect(
      decideTopNavigation(new URL("https://a.github.io/"), "https://a.github.io/x/", "prod"),
    ).toBe("allow");
  });

  it("blocks every other scheme and every malformed or credential-carrying target", () => {
    const blocked = HOSTILE_EVERYWHERE.filter(
      (t) => t.length <= MAX_URL_LENGTH && !TAIL_ONLY.includes(t),
    );
    for (const flavor of FLAVORS) {
      for (const target of blocked) {
        expect(
          decideTopNavigation(entry, target, flavor),
          `${flavor}: ${JSON.stringify(target)}`,
        ).toBe("block");
      }
    }
  });

  it("ignores raw shapes after the authority of a target: Chromium keeps a backslash there (R25)", () => {
    for (const flavor of FLAVORS) {
      // What Chromium handed will-navigate for a same-site link (Task 8 e2e, 2026-10-28).
      expect(
        decideTopNavigation(
          entry,
          "https://example.com/navigation.html?q=a\\b%20c#x\\y%20z",
          flavor,
        ),
      ).toBe("allow");
      expect(decideTopNavigation(entry, "https://example.com/a\\b/c d?e f#g h", flavor)).toBe(
        "allow",
      );
      for (const target of TAIL_ONLY) {
        expect(decideTopNavigation(entry, target, flavor), JSON.stringify(target)).toBe("allow");
      }
      // Another site with such a tail is still only offered; the external gate stays strict.
      expect(decideTopNavigation(entry, "https://other.example/q?a\\b", flavor)).toBe(
        "ask-external",
      );
      expect(isExternalUrlAllowed("https://other.example/q?a\\b")).toBe(false);
      // In the authority the shapes still block.
      expect(decideTopNavigation(entry, "https://evil.com\\.example.com/", flavor)).toBe("block");
      expect(decideTopNavigation(entry, "https://exa mple.com/", flavor)).toBe("block");
      expect(decideTopNavigation(entry, "https://example.com\\@evil.net/", flavor)).toBe("block");
    }
  });

  it("does not limit the length of a same-site target (only external opening is limited)", () => {
    expect(decideTopNavigation(entry, urlOfLength(5000), "prod")).toBe("allow");
  });

  it("treats the development hosts as a site in dev and test builds only", () => {
    const dev = new URL("http://localhost:4417/");
    for (const flavor of DEV_FLAVORS) {
      expect(decideTopNavigation(dev, "http://localhost:4417/next", flavor)).toBe("allow");
      expect(decideTopNavigation(dev, "http://localhost:9999/", flavor)).toBe("allow");
      expect(decideTopNavigation(dev, "http://127.0.0.1:4417/", flavor)).toBe("ask-external");
      expect(decideTopNavigation(dev, "https://localhost:4417/", flavor)).toBe("ask-external");
      expect(decideTopNavigation(dev, "http://2130706433:4417/", flavor)).toBe("ask-external");
      expect(decideTopNavigation(entry, "http://localhost:4417/", flavor)).toBe("ask-external");
    }
    // A production build never navigates a game to a development origin, even from a stored dev entry.
    expect(decideTopNavigation(dev, "http://localhost:4417/next", "prod")).toBe("block");
    expect(decideTopNavigation(entry, "http://localhost:4417/", "prod")).toBe("ask-external");
  });

  it("never lets empty-label hosts share a site, whatever the entry", () => {
    for (const flavor of FLAVORS) {
      expect(
        decideTopNavigation(new URL("https://example..com/"), "https://evil..com/", flavor),
      ).toBe("block");
      expect(decideTopNavigation(new URL("https://a..co.uk/"), "https://b..co.uk/", flavor)).toBe(
        "block",
      );
      expect(
        decideTopNavigation(new URL("https://x.a..github.io/"), "https://y.b..github.io/", flavor),
      ).toBe("block");
      expect(decideTopNavigation(entry, "https://.example.com/", flavor)).toBe("block");
    }
  });

  it("blocks everything when the entry itself is not an allowed entry URL", () => {
    for (const bad of ["http://example.com/", "https://user@example.com/", "file:///game.html"]) {
      expect(decideTopNavigation(new URL(bad), "https://example.com/", "prod"), bad).toBe("block");
    }
  });

  it("never throws", () => {
    for (const target of [...HOSTILE_EVERYWHERE, "%", "https://[", "\ud800"]) {
      expect(() => decideTopNavigation(entry, target, "prod")).not.toThrow();
    }
  });
});

describe("decideFrameNavigation", () => {
  it("allows https, http, about:blank, about:srcdoc, blob: and data: subframes", () => {
    for (const target of [
      "https://cdn.other.com/frame.html",
      "http://ads.example.net/",
      "HTTPS://Example.com/",
      "about:blank",
      "about:blank#top",
      "about:srcdoc",
      "blob:https://example.com/0f3c1e5a-1111-4222-8333-444455556666",
      "data:text/html,<p>hi there</p>",
    ]) {
      expect(decideFrameNavigation(target), target).toBe("allow");
    }
  });

  it("blocks every other scheme and unparsable targets", () => {
    for (const target of [
      "javascript:alert(1)",
      "  JAVASCRIPT:alert(1)",
      "file:///etc/passwd",
      "wglauncher://launch/01890a5d-ac96-774b-bcce-b302099a8057",
      "app://launcher/index.html",
      "chrome://settings",
      "about:settings",
      "about:config",
      "ftp://example.com/",
      "filesystem:https://example.com/temporary/x",
      "",
      "not a url",
    ]) {
      expect(decideFrameNavigation(target), JSON.stringify(target)).toBe("block");
    }
  });
});

describe("isExternalUrlAllowed", () => {
  it("allows a plain https or http URL with a host", () => {
    for (const url of [
      "https://example.com/",
      "https://example.com",
      "http://example.com/page?x=1#y",
      "HTTPS://WWW.EXAMPLE.COM/",
      "https://medium.com/@someone",
      "https://ex\u0430mple.com/",
      "https://192.168.0.10:8080/",
      urlOfLength(2048),
    ]) {
      expect(isExternalUrlAllowed(url), url).toBe(true);
    }
  });

  it("refuses every hostile input", () => {
    for (const url of HOSTILE_EVERYWHERE) {
      expect(isExternalUrlAllowed(url), JSON.stringify(url)).toBe(false);
    }
  });

  it("refuses 2049 characters, measured before parsing", () => {
    expect(isExternalUrlAllowed(urlOfLength(2049))).toBe(false);
  });

  it("never throws and refuses non-string input", () => {
    for (const url of [undefined, null, 42, {}, ["https://example.com/"]]) {
      expect(isExternalUrlAllowed(url as unknown as string)).toBe(false);
    }
  });
});
