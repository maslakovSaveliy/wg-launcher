// A static server for the game-window e2e pages (`e2e/pages/`), for cases progress-lab cannot serve: permissions,
// navigation targets, popups, a download, redirects, a slow response. Loopback only (security.md S-18), a free port.
// Not a game: these pages only report what the browser let them do.

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

const PAGES = join(import.meta.dirname, "pages");
const NAME = /^\/([a-z-]+\.html)$/;

export interface TestPages {
  /** `http://127.0.0.1:<port>`: a development origin, so an entry URL in the test flavor. */
  origin: string;
  stop(): Promise<void>;
}

/**
 * Routes: `/<name>.html` from `e2e/pages`; `/redirect?to=<url>` answers 302 to `to`; `/download` sends an
 * attachment; `/slow?ms=<n>` answers a page after `n` ms (at most 10 000).
 */
export async function startTestPages(): Promise<TestPages> {
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, type: string, body: string | Buffer, headers = {}) => {
      response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
      response.end(body);
    };
    if (url.pathname === "/redirect") {
      response.writeHead(302, { Location: url.searchParams.get("to") ?? "/" });
      response.end();
      return;
    }
    if (url.pathname === "/download") {
      send(200, "application/octet-stream", "not a game\n", {
        "Content-Disposition": 'attachment; filename="download.bin"',
      });
      return;
    }
    if (url.pathname === "/slow") {
      const ms = Math.min(Number(url.searchParams.get("ms") ?? "1000") || 0, 10_000);
      setTimeout(
        () => send(200, "text/html; charset=utf-8", "<!doctype html><title>slow</title>"),
        ms,
      );
      return;
    }
    const name = NAME.exec(url.pathname)?.[1];
    if (!name) {
      send(404, "text/plain", "not found");
      return;
    }
    try {
      send(200, "text/html; charset=utf-8", await readFile(join(PAGES, name)));
    } catch {
      send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("test pages: no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
