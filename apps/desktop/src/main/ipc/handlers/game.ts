// `game:launch` and `game:focus` (architecture.md sections 4 and 6): thin over the game runtime, which owns the
// state machine and the one-window rule. `shortcut:create` (section 8) finds the game and leaves the rest to
// `shortcuts.ts`, whose save dialog runs in main.

import type { Handlers } from "../register.js";
import { type HandlerContext, READ_ONLY } from "./context.js";

export function gameHandlers(
  context: HandlerContext,
): Pick<Handlers, "game:launch" | "game:focus" | "shortcut:create"> {
  return {
    async "game:launch"({ gameId }) {
      const runtime = context.library?.runtime;
      if (!runtime) return READ_ONLY;
      const result = await runtime.launch(gameId);
      if (!result.ok) return result;
      return { ok: true, data: { window: result.data.window, state: runtime.state(gameId) } };
    },
    async "game:focus"({ gameId }) {
      const runtime = context.library?.runtime;
      if (!runtime) return READ_ONLY;
      return runtime.focus(gameId)
        ? { ok: true, data: {} }
        : { ok: false, code: "NOT_FOUND", message: "The game has no open window." };
    },
    async "shortcut:create"({ gameId }) {
      const library = context.library;
      if (!library) return READ_ONLY;
      const game = library.repos.games.get(gameId);
      if (!game)
        return { ok: false, code: "NOT_FOUND", message: "The game is not in the library." };
      return context.shortcuts.create({ id: game.id, title: game.title });
    },
  };
}
