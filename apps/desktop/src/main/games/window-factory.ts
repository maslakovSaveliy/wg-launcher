// Game windows (architecture.md section 5, security.md section 5, AGENTS.md security invariants 1, 4 and 5).
//
// A game is untrusted: its window is sandboxed and context-isolated, has no preload and no IPC, lives in its own
// persistent partition and may navigate its main frame only within the entry's site. Every URL decision comes from
// the pure functions of `policy/url-rules.ts`, called with the compile-time build flavor.

import { isUuidV7 } from "@wg-launcher/shared";
import { BrowserWindow, type WebPreferences } from "electron";
import type { Dialogs } from "../dialogs.js";
import type { Flavor } from "../flavor.js";
import type { Logger } from "../log/logger.js";
import {
  decideFrameNavigation,
  decideTopNavigation,
  isExternalUrlAllowed,
} from "../policy/url-rules.js";
import type { Bounds } from "../policy/window-guard.js";

/** The one partition of a game: `persist:game:<gameId>` (AGENTS.md security invariant 2). */
export function gamePartition(gameId: string): string {
  if (!isUuidV7(gameId)) throw new TypeError("gamePartition: not a lowercase UUIDv7");
  return `persist:game:${gameId}`;
}

/** The game window's `webPreferences`, every key of architecture.md section 5 and nothing else (S-1). */
export function gameWebPreferences(gameId: string): WebPreferences {
  return {
    partition: gamePartition(gameId),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,
    safeDialogs: true,
    navigateOnDragDrop: false,
  };
}

export interface ExternalOpenerDeps {
  gameId: string;
  dialogs: Pick<Dialogs, "confirm">;
  /** `shell.openExternal` in production; the test flavor records instead. */
  openExternal(url: string): Promise<void>;
  log: Logger;
  /** Milliseconds; injected for the cooldown test. */
  now?: () => number;
}

/** After a Cancel, a window's further requests are dropped for this long, so a game cannot re-ask forever (Assumed). */
export const EXTERNAL_COOLDOWN_MS = 10_000;

/**
 * "Open in browser?" for one game window (security.md section 5, `shell.openExternal`): only a URL that passes
 * `isExternalUrlAllowed` is offered; the confirmation names the punycode host; one confirmation at a time, others are
 * dropped and logged; after a Cancel, requests are dropped and logged for `EXTERNAL_COOLDOWN_MS`; only the parsed
 * `href` is opened, and only after a yes. Electron 45's window-open details carry no user-activation flag, so
 * `window.open` is not gated on a gesture here (the cooldown is the limit).
 */
export function createExternalOpener(deps: ExternalOpenerDeps): (url: string) => Promise<void> {
  const now = deps.now ?? Date.now;
  let pending = false;
  let quietUntil = Number.NEGATIVE_INFINITY;
  return async (url) => {
    if (!isExternalUrlAllowed(url)) {
      deps.log.warn("game.external-refused", { gameId: deps.gameId, length: String(url).length });
      return;
    }
    const target = new URL(url);
    if (pending) {
      deps.log.warn("game.external-dropped", { gameId: deps.gameId, origin: target.origin });
      return;
    }
    if (now() < quietUntil) {
      deps.log.warn("game.external-cooldown", { gameId: deps.gameId, origin: target.origin });
      return;
    }
    pending = true;
    try {
      const yes = await deps.dialogs.confirm({
        title: "Open in browser?",
        message: `The game wants to open ${target.host} in your browser.`,
        detail: `Address: ${target.protocol}//${target.host}${target.pathname}`,
        confirmLabel: "Open in browser",
        cancelLabel: "Cancel",
      });
      if (!yes) {
        quietUntil = now() + EXTERNAL_COOLDOWN_MS;
        return;
      }
      deps.log.info("game.external-opened", { gameId: deps.gameId, origin: target.origin });
      await deps.openExternal(target.href);
    } catch (error) {
      deps.log.error("game.external-failed", { gameId: deps.gameId, error });
    } finally {
      pending = false;
    }
  };
}

export interface GameWindowOptions {
  gameId: string;
  title: string;
  /** The library entry's URL: navigation stays within its site. */
  entryUrl: URL;
  flavor: Flavor;
  log: Logger;
  /** Called for an http or https target on another site (the caller asks "Open in browser?"). */
  askExternal(url: string): void;
  /** Where the window opens (`window-state.ts`: the saved bounds through the off-screen guard). */
  bounds: Bounds;
}

/**
 * Creates a game window, hidden until it is ready, with the navigation and window rules of security.md section 5.
 * The caller must have set up the game's session with `gameSession(gameId)` first, so its handlers exist before the
 * page asks for anything.
 */
export function createGameWindow(options: GameWindowOptions): BrowserWindow {
  const { gameId, entryUrl, flavor, log, askExternal } = options;
  const window = new BrowserWindow({
    ...options.bounds,
    show: false,
    title: options.title,
    backgroundColor: "#000000",
    webPreferences: gameWebPreferences(gameId),
  });
  const contents = window.webContents;

  const topNavigation = (event: { preventDefault(): void; url: string }, kind: string) => {
    const decision = decideTopNavigation(entryUrl, event.url, flavor);
    if (decision === "allow") return;
    event.preventDefault();
    log.warn("game.navigation-refused", { gameId, kind, decision, target: describeUrl(event.url) });
    if (decision === "ask-external") askExternal(event.url);
  };
  const frameNavigation = (event: { preventDefault(): void; url: string }, kind: string) => {
    if (decideFrameNavigation(event.url) === "allow") return;
    event.preventDefault();
    log.warn("game.frame-navigation-refused", { gameId, kind, target: describeUrl(event.url) });
  };

  // Renderer-initiated navigations of the main frame; our own loadURL does not reach this event.
  contents.on("will-navigate", (event) => topNavigation(event, "navigate"));
  // will-frame-navigate also fires for the main frame, which will-navigate already decided.
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) frameNavigation(event, "frame-navigate");
  });
  // Server redirects, also of our own loadURL of the entry (Review Focus 1).
  contents.on("will-redirect", (event) => {
    if (event.isMainFrame) topNavigation(event, "redirect");
    else frameNavigation(event, "frame-redirect");
  });
  contents.setWindowOpenHandler(({ url }) => {
    log.warn("game.window-open-refused", { gameId, target: describeUrl(url) });
    askExternal(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    log.warn("game.webview-refused", { gameId });
  });
  contents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
    log.warn("game.device-refused", { gameId, device: "bluetooth" });
  });
  return window;
}

/**
 * What a log may say about a URL a game chose: the origin of an http or https URL, otherwise only its scheme
 * (`redact` shortens http URLs, but a `javascript:` or `data:` URL would be logged whole).
 */
export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    return parsed.protocol;
  } catch {
    return "[not a URL]";
  }
}
