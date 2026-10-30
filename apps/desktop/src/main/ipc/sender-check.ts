// The sender check of architecture.md section 6 (AGENTS.md security invariant 6), run before every IPC handler. Pure:
// the Electron objects are described by the few properties it reads, so the unit tests use plain objects.

/** The parts of a `WebFrameMain` the check reads. */
export interface SenderFrame {
  readonly url: string;
  readonly parent: unknown;
  readonly processId: number;
  readonly routingId: number;
}

/** The parts of an `IpcMainInvokeEvent` the check reads. */
export interface IpcEventLike {
  readonly sender: unknown;
  readonly senderFrame: SenderFrame | null;
}

/** The parts of the launcher window's `webContents` the check reads. */
export interface LauncherContents {
  readonly mainFrame: SenderFrame;
}

/** `scheme://host[:port]` of a URL without user info; null when it has none or does not parse. */
function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // WHATWG gives an opaque origin ("null") for non-special schemes such as app:, so the origin is built from the
  // scheme and host, which the parser does fill in for `app://launcher/...`.
  if (parsed.host === "" || parsed.username !== "" || parsed.password !== "") return null;
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * True only when the call comes from the launcher window's `webContents`, from its main frame (no subframe, the same
 * frame by process and routing id), and that frame is at `origin` (`app://launcher`; the dev server's origin in the
 * dev flavor).
 */
export function checkSender(
  event: IpcEventLike,
  launcher: LauncherContents,
  origin: string,
): boolean {
  if (event.sender !== launcher) return false;
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  const main = launcher.mainFrame;
  if (frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
  return originOf(frame.url) === origin;
}
