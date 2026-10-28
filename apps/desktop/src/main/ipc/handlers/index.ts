// The IPC handlers of architecture.md section 6, built over one context. `registerIpc` validates every request before
// a handler sees it, so handlers receive parsed (strict, trimmed) requests and return `Result`s with short messages.

import type { Handlers } from "../register.js";
import type { HandlerContext } from "./context.js";
import { gameHandlers } from "./game.js";
import { libraryHandlers } from "./library.js";
import { settingsHandlers } from "./settings.js";

export type { HandlerContext, Library } from "./context.js";

export function createHandlers(context: HandlerContext): Handlers {
  return {
    ...libraryHandlers(context),
    ...gameHandlers(context),
    ...settingsHandlers(context),
  };
}
