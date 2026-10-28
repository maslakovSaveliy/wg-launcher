// `game:launch` and `game:focus` (architecture.md sections 4 and 6): thin over the game runtime, which owns the
// state machine and the one-window rule.

import type { Handlers } from "../register.js";
import { type HandlerContext, READ_ONLY } from "./context.js";

export function gameHandlers(
  context: HandlerContext,
): Pick<Handlers, "game:launch" | "game:focus"> {
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
  };
}
