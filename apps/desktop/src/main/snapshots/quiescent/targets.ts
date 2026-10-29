// The job window's debugger and its child targets (save-transfer.md section 5, steps 6 and 8): every target is
// watched for the canary (`Runtime` and `Debugger` enabled) and auto-attached paused; a cross-site iframe's own
// target gets the same commands, the bypass included unless a test control says otherwise, before it may run; a
// worker target stays paused (the canary stops the job). Detached targets are forgotten. Step 8 reads each frame's
// Chromium storage key through the target that owns the frame and compares it with the key the job expects there.
import type { ErrorCode, Result } from "@wg-launcher/shared";
import type { Canary } from "./canary.js";
import type { FrameSlot } from "./layout.js";
import { fail, JobStop } from "./stop.js";

type Listener = (...args: never[]) => void;

export interface JobDebugger {
  attach(protocolVersion: string): void;
  detach(): void;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(event: "message" | "detach", listener: Listener): unknown;
  removeListener(event: "message" | "detach", listener: Listener): unknown;
}

/** Sends one CDP command, bounded by the job's guard; `sessionId` undefined is the page itself. */
export type Send = (method: string, params?: object, sessionId?: string) => Promise<unknown>;

const OK = { ok: true, data: undefined } as const;

/**
 * `<origin>/` or `<origin>/^0<site>`: the two forms of `Storage.getStorageKey` observed (save-transfer.md section
 * 2).
 */
export function parseStorageKey(
  text: string,
): { origin: string; topLevelSite: string | null } | null {
  const canonical = (value: string, port: boolean) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === value &&
        (port || url.port === "")
      );
    } catch {
      return false;
    }
  };
  const split = text.indexOf("/^0");
  if (split === -1) {
    const origin = text.endsWith("/") ? text.slice(0, -1) : "";
    return !text.includes("^") && canonical(origin, true) ? { origin, topLevelSite: null } : null;
  }
  const origin = text.slice(0, split);
  const site = text.slice(split + 3);
  return !site.includes("^") && canonical(origin, true) && canonical(site, false)
    ? { origin, topLevelSite: site }
    : null;
}

/** Collects `{frameId, url}` of a `Page.getFrameTree` result. */
function framesOf(tree: unknown, out: Array<{ id: string; url: string }> = []) {
  const node = tree as { frame?: { id?: unknown; url?: unknown }; childFrames?: unknown[] } | null;
  const { id, url } = node?.frame ?? {};
  if (typeof id === "string" && typeof url === "string") out.push({ id, url });
  for (const child of node?.childFrames ?? []) framesOf(child, out);
  return out;
}

export interface TargetWatch {
  /** Watches the page itself (step 6), with the bypass when `withBypass`. */
  watchPage(withBypass: boolean): Promise<void>;
  /**
   * Step 8 for the frames of one navigation. `found`, when given, receives each slot URL's Chromium storage key (used
   * at run time only, for R5's `Storage.clearDataForStorageKey`; never stored or logged).
   */
  resolveKeys(
    slots: readonly FrameSlot[],
    found?: Map<string, string>,
  ): Promise<Result<void, ErrorCode>>;
  /** The child targets attached now (their session ids). */
  children(): string[];
  /** Removes the listeners and detaches the debugger. */
  dispose(): void;
}

/** Installs the listeners on an attached debugger. */
export function watchTargets(options: {
  debugger: JobDebugger;
  canary: Canary;
  send: Send;
  /** Whether child targets get the bypass (`all`; a test control may turn it off). */
  bypassChildren: boolean;
  /** A child target could not be watched: the job must stop. */
  onLost(): void;
  /** Every debugger event, after the canary saw it (the job reads the `ServiceWorker` domain's). */
  onEvent?(method: string, params: unknown): void;
}): TargetWatch {
  const { debugger: dbg, canary, send } = options;
  const children = new Set<string>();
  let disposed = false;
  const watch = async (sessionId: string | undefined, withBypass: boolean) => {
    await send("Network.enable", {}, sessionId);
    if (withBypass) await send("Network.setBypassServiceWorker", { bypass: true }, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Debugger.enable", {}, sessionId);
    await send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
  };
  const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
    canary.onDebuggerMessage(method, params, sessionId);
    options.onEvent?.(method, params);
    if (method === "Target.detachedFromTarget") {
      children.delete((params as { sessionId?: string }).sessionId ?? "");
      return;
    }
    if (method !== "Target.attachedToTarget") return;
    const { sessionId: child, targetInfo } = params as {
      sessionId: string;
      targetInfo: { type: string };
    };
    // A worker target stays paused: the canary has stopped the job already.
    if (targetInfo.type !== "iframe") return;
    children.add(child);
    watch(child, options.bypassChildren)
      .then(() => dbg.sendCommand("Runtime.runIfWaitingForDebugger", {}, child))
      .catch(() => {
        if (!disposed) options.onLost();
      });
  };
  const onDetach = () => {
    if (!disposed) canary.onDebuggerDetached();
  };
  dbg.on("message", onMessage as Listener);
  dbg.on("detach", onDetach);

  return {
    watchPage: (withBypass) => watch(undefined, withBypass),
    children: () => [...children],
    async resolveKeys(slots, found) {
      const where = new Map<string, { frameId: string; sessionId?: string }>();
      const tree = (await send("Page.getFrameTree")) as { frameTree?: unknown };
      for (const frame of framesOf(tree.frameTree)) where.set(frame.url, { frameId: frame.id });
      // A cross-site iframe is a target of its own; its frame is asked through its session.
      for (const sessionId of children) {
        let childTree: unknown;
        try {
          childTree = ((await send("Page.getFrameTree", {}, sessionId)) as { frameTree?: unknown })
            .frameTree;
        } catch (error) {
          if (error instanceof JobStop) throw error;
          continue; // a target going away right now
        }
        for (const frame of framesOf(childTree))
          where.set(frame.url, { frameId: frame.id, sessionId });
      }
      for (const slot of slots) {
        const location = where.get(slot.url);
        if (location === undefined) {
          return fail("EXP_TIMEOUT", "A frame of the job window is missing.");
        }
        const { storageKey } = (await send(
          "Storage.getStorageKey",
          { frameId: location.frameId },
          location.sessionId,
        )) as { storageKey?: unknown };
        const parsed = typeof storageKey === "string" ? parseStorageKey(storageKey) : null;
        if (parsed === null) {
          return fail(
            "EXP_UNSUPPORTED_STORAGE_KEY",
            "A frame has a storage key of an unknown form.",
          );
        }
        if (parsed.origin !== slot.key.origin || parsed.topLevelSite !== slot.key.topLevelSite) {
          return fail(
            "EXP_STORAGE_KEY_MISMATCH",
            "A frame's storage key differs from the expected one.",
          );
        }
        found?.set(slot.url, storageKey as string);
      }
      return OK;
    },
    dispose() {
      disposed = true;
      dbg.removeListener("message", onMessage as Listener);
      dbg.removeListener("detach", onDetach);
      try {
        dbg.detach();
      } catch {
        // Destroying the window detached it already.
      }
    },
  };
}
