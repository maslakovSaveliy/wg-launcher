// Launch requests from outside (architecture.md section 8, AC-19, S-11): the `--launch-game=<id>` argument of the
// first start, `second-instance` argv and macOS `open-url`. index.ts registers `second-instance` and `open-url` right
// after the single-instance lock is granted, before `ready`, and pushes what they receive into a queue that is
// started once the game runtime and the launcher window are up, so an early request is never lost. The parsing is
// `policy/deep-link.ts`; input is logged only as "valid" with the id or "invalid" with its length (security.md
// section 9). A malformed value or an unknown id shows the library with a notice and navigates nowhere.

import type { Dialogs } from "./dialogs.js";
import type { Flavor } from "./flavor.js";
import type { LaunchResult } from "./games/lifecycle.js";
import type { Logger } from "./log/logger.js";
import type { LaunchInput } from "./policy/deep-link.js";

export type LaunchSource = "argv" | "second-instance" | "open-url";

export interface LaunchRequest {
  source: LaunchSource;
  input: LaunchInput;
}

/**
 * Holds requests until `start`, then hands each to the handler, one at a time in arrival order. A handler that
 * throws does not stop the next request.
 */
export function createLaunchQueue() {
  const pending: LaunchRequest[] = [];
  let handler: ((request: LaunchRequest) => Promise<void>) | null = null;
  let chain = Promise.resolve();
  const run = (request: LaunchRequest) => {
    const handle = handler;
    if (!handle) return;
    chain = chain.then(() => handle(request)).catch(() => undefined);
  };
  return {
    push(request: LaunchRequest): void {
      if (handler) run(request);
      else pending.push(request);
    },
    start(next: (request: LaunchRequest) => Promise<void>): void {
      handler = next;
      for (const request of pending.splice(0)) run(request);
    },
    /** Resolves when every request pushed so far was handled (tests). */
    idle: (): Promise<void> => chain,
  };
}

export interface LaunchHandlerDeps {
  log: Pick<Logger, "info" | "warn">;
  /** Shows the library: the launcher window shown, restored and focused. */
  focusLauncher(): void;
  notify: Dialogs["notify"];
  /** Null while the database is read-only (nothing can be launched). */
  games: { has(gameId: string): boolean; launch(gameId: string): Promise<LaunchResult> } | null;
}

const READ_ONLY_MESSAGE =
  "The library is read-only because a newer WGLauncher wrote it, so no game can be opened.";

export async function handleLaunchRequest(
  request: LaunchRequest,
  deps: LaunchHandlerDeps,
): Promise<void> {
  const { source, input } = request;
  const { log } = deps;
  const showLibrary = async (title: string, message: string) => {
    deps.focusLauncher();
    await deps.notify({ title, message });
  };

  if (input.kind === "none") {
    log.info("launch.input", { source, result: "none" });
    // A second start without a launch argument hands over to this one: show the library.
    if (source === "second-instance") deps.focusLauncher();
    return;
  }
  if (input.kind === "invalid") {
    log.warn("launch.input", { source, result: "invalid", length: input.length });
    await showLibrary(
      "The launch link is not valid",
      "WGLauncher was asked to open a game with a link or shortcut that is not valid, so nothing was opened.",
    );
    return;
  }
  const { gameId } = input;
  log.info("launch.input", { source, result: "valid", gameId });
  if (!deps.games) {
    await showLibrary("The game cannot be opened", READ_ONLY_MESSAGE);
    return;
  }
  if (!deps.games.has(gameId)) {
    await showLibrary(
      "The game is not in the library",
      "The game of this link or shortcut is not in the library (it may have been removed), so nothing was opened.",
    );
    return;
  }
  const result = await deps.games.launch(gameId);
  if (!result.ok) {
    await showLibrary("The game cannot be opened", result.message);
    return;
  }
  if (result.data.window === "closing") {
    await showLibrary(
      "The game is closing",
      "The game is still closing. Open it again when it has closed.",
    );
  }
}

/** The deep-link scheme (architecture.md section 8). */
export const DEEP_LINK_SCHEME = "wglauncher";

/**
 * Registers the scheme in the packaged prod build only. Dev and test builds never call
 * `setAsDefaultProtocolClient`: it leaves a LaunchServices preference that outlives the app (RESULTS.md H15).
 * @returns whether it was called
 */
export function registerDeepLinkScheme(
  flavor: Flavor,
  isPackaged: boolean,
  setAsDefaultProtocolClient: (scheme: string) => boolean,
): boolean {
  if (flavor !== "prod" || !isPackaged) return false;
  setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  return true;
}
