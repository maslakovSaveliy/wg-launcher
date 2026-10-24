// Static file server for the progress-lab test fixture. No dependencies, loopback only.
//
//   node server.mjs --port <n>
//
// Serves public/ on 127.0.0.1 and [::1] at the same port, so both http://127.0.0.1:<n>/ and
// http://localhost:<n>/ work whichever address `localhost` resolves to. The two hosts are different
// sites, which lets iframe-host.html on one embed the game cross-site on the other. Paths under
// /coi/ serve the same files with COOP and COEP headers, so crossOriginIsolated is true there.
// Every request is logged to stdout as: <ISO time> <method> <host> <url> <status>.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const PUBLIC_DIR = resolve(import.meta.dirname, "public");
const COI_PREFIX = "/coi/";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const COI_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/**
 * Maps a request target to a file inside PUBLIC_DIR.
 * Returns { status } for a refused target, or { file, isolated } for one to serve.
 */
function resolveTarget(target) {
  if (!target.startsWith("/")) return { status: 400 };
  // Work on the raw path, never on a normalized URL, and decode exactly once.
  const rawPath = target.split(/[?#]/, 1)[0];
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 };
  }
  if (path.includes("\0") || path.includes("\\")) return { status: 400 };

  const isolated = path.startsWith(COI_PREFIX);
  if (isolated) path = path.slice(COI_PREFIX.length - 1);
  if (path.endsWith("/")) path += "index.html";

  const file = resolve(PUBLIC_DIR, `.${path}`);
  if (!file.startsWith(PUBLIC_DIR + sep)) return { status: 403 };
  return { file, isolated };
}

function send(res, status, headers, body) {
  res.writeHead(status, { "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

async function handle(req, res) {
  const headOnly = req.method === "HEAD";
  if (req.method !== "GET" && !headOnly) {
    send(res, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain" }, "Method Not Allowed\n");
    return;
  }

  const target = resolveTarget(req.url ?? "");
  if (target.status !== undefined) {
    send(res, target.status, { "Content-Type": "text/plain" }, `${target.status}\n`);
    return;
  }

  let body;
  try {
    body = await readFile(target.file);
  } catch (error) {
    // A missing file, a directory or a path through a file are all "not found".
    const notFound = ["ENOENT", "EISDIR", "ENOTDIR"].includes(error.code);
    send(
      res,
      notFound ? 404 : 500,
      { "Content-Type": "text/plain" },
      notFound ? "Not Found\n" : "Error\n",
    );
    return;
  }

  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(target.file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": body.length,
    // Revalidate always, so an edited asset is never served stale by the HTTP cache.
    "Cache-Control": "no-cache",
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
      if (!res.headersSent) send(res, 500, { "Content-Type": "text/plain" }, "Error\n");
      else res.destroy();
    });
  });
}

function listen(server, host, port) {
  return new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      resolveListening();
    });
  });
}

function parsePort() {
  const { values } = parseArgs({ options: { port: { type: "string" } }, strict: false });
  const port = Number(values.port);
  if (typeof values.port !== "string" || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Usage: node server.mjs --port <1-65535>");
    process.exit(2);
  }
  return port;
}

const port = parsePort();

try {
  await listen(createLoggingServer(), "127.0.0.1", port);
} catch (error) {
  console.error(`Cannot listen on 127.0.0.1:${port}: ${error.message}`);
  process.exit(1);
}
try {
  await listen(createLoggingServer(), "::1", port);
} catch (error) {
  // IPv6 loopback can be missing (some containers). 127.0.0.1 is enough there: browsers resolve
  // `localhost` to it. Any other failure, such as the port being taken on ::1, is real.
  if (error.code !== "EADDRNOTAVAIL" && error.code !== "EAFNOSUPPORT") {
    console.error(`Cannot listen on [::1]:${port}: ${error.message}`);
    process.exit(1);
  }
  console.warn("IPv6 loopback is unavailable; serving 127.0.0.1 only");
}

console.log(`progress-lab listening on http://localhost:${port}/ and http://127.0.0.1:${port}/`);
