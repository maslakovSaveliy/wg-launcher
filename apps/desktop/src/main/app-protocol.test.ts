import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The module registers the scheme through Electron, which is not available under Vitest; only the pure
// parts are tested here (the handler and its headers run in the e2e suite).
vi.mock("electron", () => ({ protocol: {} }));

const { APP_SCHEME_PRIVILEGES, PRODUCTION_CSP, SECURITY_HEADERS, resolveAppUrl } = await import(
  "./app-protocol.js"
);

const rendererDir = resolve("root", "renderer");
const coversDir = resolve("root", "userData", "covers");
const roots = { rendererDir, coversDir };
const resolveUrl = (url: string) => resolveAppUrl(url, roots);
const inside = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !resolve(dir, rel).startsWith("..");
};

const GAME_ID = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

describe("resolveAppUrl: renderer files", () => {
  it("serves index.html for the root of app://launcher", () => {
    expect(resolveUrl("app://launcher/")).toEqual({
      file: join(rendererDir, "index.html"),
      contentType: "text/html; charset=utf-8",
    });
  });

  it("serves a nested asset with its content type", () => {
    expect(resolveUrl("app://launcher/assets/index-AbC123.js?v=1")).toEqual({
      file: join(rendererDir, "assets", "index-AbC123.js"),
      contentType: "text/javascript; charset=utf-8",
    });
    expect(resolveUrl("app://launcher/assets/index.css")?.contentType).toBe(
      "text/css; charset=utf-8",
    );
  });

  it.each([
    "app://launcher/../../etc/passwd.js",
    "app://launcher/assets/../../../secret.js",
    "app://launcher/%2e%2e/%2e%2e/secret.js",
    "app://launcher/.%2e/secret.js",
  ])("never leaves the renderer directory for dot segments: %s", (url) => {
    const target = resolveUrl(url);
    if (target !== null) expect(inside(rendererDir, target.file)).toBe(true);
  });

  it.each([
    "app://launcher/%2e%2e%2fsecret.js",
    "app://launcher/assets/..%2f..%2fsecret.js",
    "app://launcher/..%5csecret.js",
    "app://launcher/%2Fetc%2Fpasswd.js",
    "app://launcher//etc/passwd.js",
    "app://launcher/C:/Windows/win.js",
    "app://launcher/C%3A%5CWindows%5Cwin.js",
    "app://launcher/a%00.js",
    "app://launcher/%E0%A4%A.js",
  ])("refuses an encoded separator, absolute path or bad encoding: %s", (url) => {
    expect(resolveUrl(url)).toBeNull();
  });

  it.each([
    "app://other/index.html",
    "app://launcher:8080/index.html",
    "app://user@launcher/index.html",
    "https://launcher/index.html",
    "file:///index.html",
    "not a url",
  ])("refuses another host, port, user info or scheme: %s", (url) => {
    expect(resolveUrl(url)).toBeNull();
  });

  it.each([
    "app://launcher/assets/",
    "app://launcher/assets",
    "app://launcher/index.js.map",
    "app://launcher/data.bin",
  ])("refuses directories and unknown file types: %s", (url) => {
    expect(resolveUrl(url)).toBeNull();
  });
});

describe("resolveAppUrl: covers", () => {
  it("serves a cover with the exact name pattern from the covers directory", () => {
    const name = `${GAME_ID}-0123456789abcdef.png`;
    expect(resolveUrl(`app://launcher/covers/${name}`)).toEqual({
      file: join(coversDir, name),
      contentType: "image/png",
    });
    expect(resolveUrl(`app://launcher/covers/${GAME_ID}-0123456789abcdef.jpg`)?.contentType).toBe(
      "image/jpeg",
    );
    expect(resolveUrl(`app://launcher/covers/${GAME_ID}-0123456789abcdef.webp`)?.contentType).toBe(
      "image/webp",
    );
  });

  it.each([
    `${GAME_ID}-0123456789abcdef.gif`,
    `${GAME_ID}-0123456789abcdef.svg`,
    `${GAME_ID.toUpperCase()}-0123456789abcdef.png`,
    `${GAME_ID.replace("-7e4f-", "-4e4f-")}-0123456789abcdef.png`,
    `${GAME_ID}.png`,
    `${GAME_ID}-0123456789abcde.png`,
    `${GAME_ID}-0123456789abcdef.png.png`,
    `x/${GAME_ID}-0123456789abcdef.png`,
    `..%2f${GAME_ID}-0123456789abcdef.png`,
    `..%2findex.html`,
    "",
  ])("refuses a cover name outside the pattern: %j", (name) => {
    expect(resolveUrl(`app://launcher/covers/${name}`)).toBeNull();
  });

  it("never serves a renderer file under the covers prefix", () => {
    expect(resolveUrl("app://launcher/covers/index.html")).toBeNull();
  });
});

describe("launcher scheme and headers", () => {
  it("registers exactly the privileges of security.md section 6", () => {
    expect(APP_SCHEME_PRIVILEGES).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    });
  });

  it("uses the production CSP of security.md section 6, word for word", () => {
    expect(PRODUCTION_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
        "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
    );
  });

  it("sends the security headers of security.md section 6 on every response", () => {
    expect(SECURITY_HEADERS).toEqual({
      "Content-Security-Policy": PRODUCTION_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    });
  });
});
