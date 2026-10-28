// The quiescent window's interceptor (save-transfer.md section 5, step 2, QW-1 and QW-3). While a job runs, the game's
// session answers http and https itself: the job's exact stub URLs get their stub page, every other request gets
// `403` with an empty body, and nothing is ever passed on to the network (no `net.fetch` or `ses.fetch`: the spike's
// passthrough was fail-open). `webRequest.onBeforeRequest` is a second layer that cancels everything but the stub
// URLs. Registration and removal are paired: a registration that throws removes what was registered before it, and
// `dispose` removes everything, once. Log lines name origins only (QW-9).
import type { Logger } from "../../log/logger.js";
import type { StubPage } from "./stub.js";

/** The parts of an Electron `Session` the interceptor uses. */
export interface InterceptorSession {
  protocol: {
    handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
    unhandle(scheme: string): void;
  };
  webRequest: {
    onBeforeRequest(
      listener:
        | ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void)
        | null,
    ): void;
  };
}

export interface Interceptor {
  /** Removes the handlers and the listener; idempotent. */
  dispose(): void;
  /** The origins of the refused requests so far, each once (for the job's log). */
  refused(): string[];
}

const SCHEMES = ["http", "https"] as const;

function originOf(url: string): string {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? "[opaque]" : origin;
  } catch {
    return "[not a URL]";
  }
}

export function installInterceptor(
  ses: InterceptorSession,
  pages: ReadonlyMap<string, StubPage>,
  log: Pick<Logger, "warn">,
): Interceptor {
  const refused = new Set<string>();
  const refuse = (url: string) => {
    const origin = originOf(url);
    if (!refused.has(origin)) log.warn("snapshot.quiescent.request-refused", { origin });
    refused.add(origin);
  };
  const handler = (request: Request): Response => {
    const page = request.method === "GET" ? pages.get(request.url) : undefined;
    if (page === undefined) {
      refuse(request.url);
      return new Response(null, { status: 403 });
    }
    return new Response(page.body, { status: 200, headers: page.headers });
  };

  const handled: string[] = [];
  let listening = false;
  const dispose = () => {
    for (const scheme of handled.splice(0)) {
      try {
        ses.protocol.unhandle(scheme);
      } catch {
        // Nothing is left to remove for this scheme.
      }
    }
    if (listening) {
      listening = false;
      ses.webRequest.onBeforeRequest(null);
    }
  };
  try {
    for (const scheme of SCHEMES) {
      ses.protocol.handle(scheme, handler);
      handled.push(scheme);
    }
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = pages.has(details.url);
      if (!allowed) refuse(details.url);
      callback({ cancel: !allowed });
    });
    listening = true;
  } catch (error) {
    dispose();
    throw error;
  }
  return { dispose, refused: () => [...refused] };
}
