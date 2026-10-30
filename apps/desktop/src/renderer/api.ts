// The renderer's access to main: the typed bridge of the preload (`window.wg`), nothing else (security.md section 6).
// Only types come from @wg-launcher/shared here, so no schema code is bundled into the page.

import type { CardBadge, GameState } from "@wg-launcher/shared";
import type { WgBridge } from "@wg-launcher/shared/bridge";

/** The bridge; the App shows an error instead of the UI when the preload did not run. */
export function bridge(): WgBridge {
  const wg = window.wg;
  if (!wg) throw new Error("The launcher bridge is missing.");
  return wg;
}

/** Badge labels of PRD section 7. */
export function badgeLabel(badge: CardBadge): string {
  switch (badge.id) {
    case "by-link":
      return "By link";
    case "needs-internet":
      return "Needs internet";
    case "local-data":
      return `Local data (checked ${formatTime(badge.checkedAt)})`;
    case "export-verified":
      return "Export verified";
    case "compat-not-verified":
      return "Compatibility not verified";
  }
}

/** The window state as plain words; null when there is nothing to say (no window). */
export function stateLabel(state: GameState): string | null {
  switch (state) {
    case "launching":
      return "Starting";
    case "running":
      return "Running";
    case "closing":
      return "Closing";
    case "crashed":
      return "The game crashed.";
    case "idle":
    case "exited":
      return null;
  }
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Recorded playtime (architecture.md section 10) in whole minutes; under one minute is said so. */
export function formatPlaytime(ms: number): string {
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
