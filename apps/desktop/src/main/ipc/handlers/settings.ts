// `settings:get` and `settings:set` (architecture.md section 6). No setting is allowlisted yet (Phase 1 Task 9): the
// schema in packages/shared is an empty strict object, so every key is refused before this runs and nothing is
// stored. A setting is added here, to `settingsSchema` and to the `settings` table's allowlist together.

import type { Handlers } from "../register.js";
import { type HandlerContext, READ_ONLY } from "./context.js";

export function settingsHandlers(
  context: HandlerContext,
): Pick<Handlers, "settings:get" | "settings:set"> {
  return {
    async "settings:get"() {
      return { ok: true, data: {} };
    },
    async "settings:set"() {
      if (!context.library) return READ_ONLY;
      return { ok: true, data: {} };
    },
  };
}
