// Which service worker started during a job, by the origin of its scope (for the canary's log; origins only, QW-9).
import type { JobSession } from "./job.js";

/**
 * Worker versions and registrations as the `ServiceWorker` CDP domain reports them (enabled in step 5): a version
 * that starts is named there before Electron's own lookups know it.
 */
export class WorkerScopes {
  readonly #scopes = new Map<string, string>();
  readonly #registrations = new Map<string, string>();
  onEvent(method: string, params: unknown): void {
    if (method === "ServiceWorker.workerRegistrationUpdated") {
      const list = (
        params as { registrations?: Array<{ registrationId?: unknown; scopeURL?: unknown }> }
      ).registrations;
      for (const r of list ?? []) {
        if (typeof r.registrationId === "string" && typeof r.scopeURL === "string") {
          this.#scopes.set(r.registrationId, r.scopeURL);
        }
      }
    } else if (method === "ServiceWorker.workerVersionUpdated") {
      const list = (
        params as { versions?: Array<{ versionId?: unknown; registrationId?: unknown }> }
      ).versions;
      for (const v of list ?? []) {
        if (typeof v.versionId === "string" && typeof v.registrationId === "string") {
          this.#registrations.set(v.versionId, v.registrationId);
        }
      }
    }
  }
  originOf(versionId: number): string | null {
    const registration = this.#registrations.get(String(versionId));
    const scope = registration === undefined ? undefined : this.#scopes.get(registration);
    try {
      return scope === undefined ? null : new URL(scope).origin;
    } catch {
      return null;
    }
  }
}

/** The origin of a worker version's scope, from its info or, while it starts, the running list; null if unknown. */
export function workerScopeOrigin(ses: JobSession, versionId: number): string | null {
  const scopes: unknown[] = [];
  try {
    scopes.push(ses.serviceWorkers.getInfoFromVersionID(versionId)?.scope);
  } catch {
    // Not known under this id (yet).
  }
  scopes.push(
    (ses.serviceWorkers.getAllRunning()[versionId] as { scope?: unknown } | undefined)?.scope,
  );
  for (const scope of scopes) {
    if (typeof scope !== "string") continue;
    try {
      return new URL(scope).origin;
    } catch {
      // Not a URL.
    }
  }
  return null;
}
