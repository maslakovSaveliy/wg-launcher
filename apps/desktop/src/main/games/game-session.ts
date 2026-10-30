// Game sessions (architecture.md section 5, security.md section 5, AGENTS.md security invariants 2 and 3).
//
// `gameSession(gameId)` is the only way the app obtains a game's session. On first use it installs the permission
// request and check handlers (`decidePermission`: exactly fullscreen, pointerLock and keyboardLock; `media` and
// `display-capture` are denied before Chromium asks the OS), refuses every device and chooser, cancels downloads and
// turns the spell checker off. No display-media handler is installed. Denials are logged at most once a minute per
// game and permission. `installBaselineHandlers` denies everything on every other session as a baseline.

import { type App, type Session, session } from "electron";
import type { Logger } from "../log/logger.js";
import { decidePermission } from "../policy/permissions.js";
import { gamePartition } from "./window-factory.js";

export const DENIAL_LOG_INTERVAL_MS = 60_000;

export interface SessionDeps {
  log: Logger;
  /** Milliseconds; injected for the rate-limit test. */
  now?: () => number;
}

function originOf(url: unknown): string {
  if (typeof url !== "string" || url === "") return "[none]";
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    return "[not a URL]";
  }
}

/** A denial logger: the first denial of each permission, then at most one a minute with the suppressed count. */
export function createDenialLog(options: {
  log: Logger;
  gameId: string;
  now?: () => number;
  intervalMs?: number;
}): (permission: string, requestingUrl: string, via: "request" | "check") => void {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? DENIAL_LOG_INTERVAL_MS;
  const last = new Map<string, { at: number; suppressed: number }>();
  return (permission, requestingUrl, via) => {
    const at = now();
    const seen = last.get(permission);
    if (seen && at - seen.at < interval) {
      seen.suppressed += 1;
      return;
    }
    last.set(permission, { at, suppressed: 0 });
    options.log.warn("game.permission-denied", {
      gameId: options.gameId,
      permission,
      origin: originOf(requestingUrl),
      via,
      suppressed: seen?.suppressed ?? 0,
    });
  };
}

const installed = new WeakSet<Session>();

/** Installs the game policy on `ses`. Exported for the unit test; the app calls `gameSession`. */
export function setUpGameSession(ses: Session, gameId: string, deps: SessionDeps): void {
  const { log } = deps;
  const deny = createDenialLog({ log, gameId, ...(deps.now ? { now: deps.now } : {}) });

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allowed = decidePermission(permission) === "allow";
    if (!allowed) deny(permission, details?.requestingUrl ?? "", "request");
    callback(allowed);
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const allowed = decidePermission(permission) === "allow";
    if (!allowed) deny(permission, requestingOrigin, "check");
    return allowed;
  });
  ses.setDevicePermissionHandler(() => false);
  ses.on("select-hid-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
    log.warn("game.device-refused", { gameId, device: "hid" });
  });
  ses.on("select-serial-port", (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback("");
    log.warn("game.device-refused", { gameId, device: "serial" });
  });
  ses.on("select-usb-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
    log.warn("game.device-refused", { gameId, device: "usb" });
  });
  // Windows and Linux only (electron.d.ts); macOS pairs by itself and has no such method to call.
  if (typeof ses.setBluetoothPairingHandler === "function") {
    ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
  }
  ses.on("will-download", (event, item) => {
    event.preventDefault();
    log.warn("game.download-refused", { gameId, origin: originOf(item?.getURL?.()) });
  });
  ses.setSpellCheckerEnabled(false);
}

/** The session of a game, with its policy installed exactly once. */
export function gameSession(gameId: string, deps: SessionDeps): Session {
  const ses = session.fromPartition(gamePartition(gameId));
  if (!installed.has(ses)) {
    setUpGameSession(ses, gameId, deps);
    installed.add(ses);
  }
  return ses;
}

/**
 * Baseline for every session and every `webContents` the app ever creates (architecture.md section 5): deny all
 * permissions and devices, cancel downloads, refuse `<webview>` and new windows. The launcher and game windows then
 * install their own, narrower handlers. Also refuses client certificates (Electron would pick the first one).
 * Certificate errors keep Electron's default (rejected) and `login` keeps its default (cancelled).
 */
export function installBaselineHandlers(app: App, log: Pick<Logger, "warn">): void {
  app.on("session-created", (ses) => {
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on("will-download", (event) => event.preventDefault());
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
  app.on("select-client-certificate", (event, _contents, url, _list, callback) => {
    event.preventDefault();
    callback();
    log.warn("app.client-certificate-refused", { origin: originOf(url) });
  });
}
