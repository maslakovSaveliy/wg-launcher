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

/** At most this many requests wait to be handled; more are dropped and logged (Assumed: a person clicks fewer). */
export const MAX_QUEUED_LAUNCH_REQUESTS = 16;

/**
 * Holds requests until `start`, then hands each to the handler, one at a time in arrival order. A handler that
 * throws does not stop the next request. At most `MAX_QUEUED_LAUNCH_REQUESTS` wait (before `start`, or behind a
 * request being handled); a request beyond that is dropped and reported to `onDrop` (those dropped before `start`,
 * when no log exists yet, are reported at `start`).
 */
export function createLaunchQueue() {
  const pending: LaunchRequest[] = [];
  const droppedEarly: LaunchSource[] = [];
  let handler: ((request: LaunchRequest) => Promise<void>) | null = null;
  let onDrop: ((source: LaunchSource) => void) | null = null;
  let waiting = 0;
  let chain = Promise.resolve();
  const run = (handle: (request: LaunchRequest) => Promise<void>, request: LaunchRequest) => {
    chain = chain
      .then(() => handle(request))
      .catch(() => undefined)
      .finally(() => {
        waiting -= 1;
      });
  };
  return {
    push(request: LaunchRequest): void {
      if (waiting >= MAX_QUEUED_LAUNCH_REQUESTS) {
        if (onDrop) onDrop(request.source);
        else droppedEarly.push(request.source);
        return;
      }
      waiting += 1;
      if (handler) run(handler, request);
      else pending.push(request);
    },
    start(
      next: (request: LaunchRequest) => Promise<void>,
      dropped: (source: LaunchSource) => void = () => undefined,
    ): void {
      handler = next;
      onDrop = dropped;
      for (const source of droppedEarly.splice(0)) dropped(source);
      for (const request of pending.splice(0)) run(next, request);
    },
    /** Resolves when every request pushed so far was handled (tests). */
    idle: (): Promise<void> => chain,
  };
}

/** At most this many notices wait for the user's OK; more are dropped and logged (Assumed). */
export const MAX_PENDING_NOTICES = 4;

/**
 * Shows notices one at a time, in the order they were asked for, without making the caller wait for the user's OK:
 * the launch queue goes on while a notice is open. A failing notice is logged and does not stop the next.
 */
export function createNoticeChain(notify: Dialogs["notify"], log: Pick<Logger, "warn" | "error">) {
  let pending = 0;
  let chain = Promise.resolve();
  return {
    notify(spec: { title: string; message: string }): Promise<void> {
      if (pending >= MAX_PENDING_NOTICES) {
        log.warn("launch.notice-dropped", { title: spec.title });
        return Promise.resolve();
      }
      pending += 1;
      chain = chain
        .then(() => notify(spec))
        .catch((error: unknown) => log.error("launch.notice-failed", { error }))
        .finally(() => {
          pending -= 1;
        });
      return Promise.resolve();
    },
    /** Resolves when every notice asked for so far was answered (tests). */
    idle: (): Promise<void> => chain,
  };
}

export interface LaunchHandlerDeps {
  log: Pick<Logger, "info" | "warn" | "error">;
  /** Shows the library: the launcher window shown, restored and focused (opened again if it was closed). */
  focusLauncher(): void;
  /** Shows a notice; never awaited here, so a notice the user has not answered blocks no later request. */
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
    deps
      .notify({ title, message })
      .catch((error: unknown) => log.error("launch.notice-failed", { error }));
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
