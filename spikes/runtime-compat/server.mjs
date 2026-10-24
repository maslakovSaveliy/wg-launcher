// THROWAWAY spike server (runtime-compat). Not product code. No dependencies, loopback only.
//
//   node server.mjs --port <n> [--token <secret>] [--allow-origin <origin> ...] [--results-dir <dir>]
//
// - Serves probe/ on 127.0.0.1 and [::1] (so http://localhost:<n>/ and http://127.0.0.1:<n>/ both work).
// - Paths under /coi/ serve the same files with COOP/COEP/CORP headers (same convention as the
//   progress-lab fixture), so crossOriginIsolated is true there.
// - /vendor/wasm-feature-detect.js serves the wasm-feature-detect ESM build from electron/node_modules.
// - POST /results/<runtime> with a JSON body writes results/<runtime>-<version>-<UTC timestamp>.json
//   (home directory and user name replaced) and prints "RESULT <relative path> <kind>" on stdout.
//   The POST must carry the per-run secret in an X-WG-Token header (run.mjs passes --token and gives
//   the probe the same value as ?token=; without --token the server makes one and prints "TOKEN ...").
//   Its Origin must be this server's own origin or one given with --allow-origin (Tauri assets in
//   Task 6); only those get CORS headers. So another page open in a browser cannot write results.
// - Every request is logged to stdout as: <ISO time> <method> <host> <url> <status>.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, userInfo } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const ROOT = import.meta.dirname;
const PROBE_DIR = resolve(ROOT, "probe");
const VENDOR = {
  "/vendor/wasm-feature-detect.js": resolve(
    ROOT,
    "electron/node_modules/wasm-feature-detect/dist/esm/index.js",
  ),
};
const COI_PREFIX = "/coi/";
const MAX_BODY = 8 * 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

const COI_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const { values: args } = parseArgs({
  options: {
    port: { type: "string" },
    token: { type: "string" },
    "allow-origin": { type: "string", multiple: true },
    "results-dir": { type: "string" },
  },
  strict: true,
});
const port = Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: node server.mjs --port <1-65535> [--results-dir <dir>]");
  process.exit(2);
}
const resultsDir = resolve(args["results-dir"] ?? resolve(ROOT, "results"));
const TOKEN = args.token ?? randomBytes(16).toString("hex");
if (!/^[A-Za-z0-9_-]{16,128}$/.test(TOKEN)) {
  console.error("--token must be 16 to 128 characters of [A-Za-z0-9_-]");
  process.exit(2);
}
const OWN_ORIGINS = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
const EXTRA_ORIGINS = new Set(args["allow-origin"] ?? []);

/** CORS headers only for an explicitly allowed foreign origin (never "*"). */
function corsHeaders(origin) {
  if (!origin || !EXTRA_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-WG-Token",
    // Readable from a COEP: require-corp page on that origin.
    "Cross-Origin-Resource-Policy": "cross-origin",
    Vary: "Origin",
  };
}

function tokenMatches(value) {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const HOME = homedir();
const USER = userInfo().username;
const REPO = resolve(ROOT, "../..");

/** Replaces machine-specific paths and the user name, so committed JSON holds no personal data. */
function sanitize(text) {
  let out = text.split(TOKEN).join("<token>").split(REPO).join("<repo>").split(HOME).join("~");
  if (USER.length >= 3) out = out.split(USER).join("<user>");
  return out;
}

function send(res, status, headers, body) {
  res.writeHead(status, { "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function resolveStatic(target) {
  if (!target.startsWith("/")) return { status: 400 };
  let path;
  try {
    path = decodeURIComponent(target.split(/[?#]/, 1)[0]);
  } catch {
    return { status: 400 };
  }
  if (path.includes("\0") || path.includes("\\")) return { status: 400 };
  if (VENDOR[path]) return { file: VENDOR[path], isolated: false };
  const isolated = path.startsWith(COI_PREFIX);
  if (isolated) {
    path = path.slice(COI_PREFIX.length - 1);
    if (VENDOR[path]) return { file: VENDOR[path], isolated };
  }
  if (path.endsWith("/")) path += "index.html";
  const file = resolve(PROBE_DIR, `.${path}`);
  if (!file.startsWith(PROBE_DIR + sep)) return { status: 403 };
  return { file, isolated };
}

function safeName(value, fallback) {
  const text = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(text) ? text : fallback;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handlePost(req, res) {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);
  const match = /^\/results\/([A-Za-z0-9._-]{1,32})$/.exec((req.url ?? "").split("?")[0]);
  if (!match) {
    send(res, 404, { "Content-Type": "text/plain", ...cors }, "Not Found\n");
    return;
  }
  // Non-browser clients send no Origin; browsers always do on POST.
  if (origin && !OWN_ORIGINS.has(origin) && !EXTRA_ORIGINS.has(origin)) {
    send(res, 403, { "Content-Type": "text/plain" }, "Origin not allowed\n");
    return;
  }
  if (!tokenMatches(req.headers["x-wg-token"])) {
    send(res, 403, { "Content-Type": "text/plain", ...cors }, "Missing or wrong X-WG-Token\n");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    send(res, 400, { "Content-Type": "text/plain", ...cors }, `Bad JSON: ${error.message}\n`);
    return;
  }
  const runtime = match[1];
  const version = safeName(payload?.runtime?.version, "unknown");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, ".$1Z");
  mkdirSync(resultsDir, { recursive: true });
  const file = resolve(resultsDir, `${runtime}-${version}-${stamp}.json`);
  writeFileSync(file, `${sanitize(JSON.stringify(payload, null, 2))}\n`);
  const rel = relative(ROOT, file);
  console.log(`RESULT ${rel} ${safeName(payload?.kind, "unknown")}`);
  send(
    res,
    201,
    { "Content-Type": "application/json", ...cors },
    JSON.stringify({ file: rel }),
  );
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    const cors = corsHeaders(req.headers.origin);
    send(res, Object.keys(cors).length ? 204 : 403, cors, "");
    return;
  }
  if (req.method === "POST") {
    await handlePost(req, res);
    return;
  }
  const headOnly = req.method === "HEAD";
  if (req.method !== "GET" && !headOnly) {
    send(res, 405, { Allow: "GET, HEAD, POST, OPTIONS", "Content-Type": "text/plain" }, "405\n");
    return;
  }
  const target = resolveStatic(req.url ?? "");
  if (target.status !== undefined) {
    send(res, target.status, { "Content-Type": "text/plain" }, `${target.status}\n`);
    return;
  }
  let body;
  try {
    body = await readFile(target.file);
  } catch (error) {
    const notFound = ["ENOENT", "EISDIR", "ENOTDIR"].includes(error.code);
    send(res, notFound ? 404 : 500, { "Content-Type": "text/plain" }, notFound ? "404\n" : "500\n");
    return;
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(target.file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(target.isolated ? COI_HEADERS : {}),
  });
  res.end(headOnly ? undefined : body);
}

function createLoggingServer() {
  return createServer((req, res) => {
    res.on("finish", () => {
      console.log(
        `${new Date().toISOString()} ${req.method} ${req.headers.host ?? "-"} ${req.url} ${res.statusCode}`,
      );
    });
    handle(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) send(res, 500, { "Content-Type": "text/plain" }, "500\n");
      else res.destroy();
    });
  });
}

function listen(server, host) {
  return new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      resolveListening();
    });
  });
}

try {
  await listen(createLoggingServer(), "127.0.0.1");
} catch (error) {
  console.error(`Cannot listen on 127.0.0.1:${port}: ${error.message}`);
  process.exit(1);
}
try {
  await listen(createLoggingServer(), "::1");
} catch (error) {
  if (error.code !== "EADDRNOTAVAIL" && error.code !== "EAFNOSUPPORT") {
    console.error(`Cannot listen on [::1]:${port}: ${error.message}`);
    process.exit(1);
  }
  console.warn("IPv6 loopback is unavailable; serving 127.0.0.1 only");
}
if (!args.token) console.log(`TOKEN ${TOKEN}`);
console.log(`spike server listening on http://localhost:${port}/ (results -> ${sanitize(resultsDir)})`);
