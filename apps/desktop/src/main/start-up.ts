// Steps the main process takes before `ready`.

/** The Chromium feature whose absence turns third-party storage partitioning off. */
export const PARTITIONING_FEATURE = "ThirdPartyStoragePartitioning";

/** The part of Electron's `app.commandLine` this module uses. */
export interface SwitchLine {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value?: string): void;
}

/**
 * Keeps storage partitioning on (architecture.md section 5). Playwright's Electron loader appends
 * `--disable-features=...,ThirdPartyStoragePartitioning,...` through `app.commandLine.appendSwitch` (not argv), so the
 * switch is read from the command line object; a user can pass the same switch in argv, which Chromium reads into
 * the same object. When the list contains the feature, the list without it is appended again: the last value of a
 * switch wins (Verified 2026-10-24, RESULTS.md H11). Runs in every build, before `ready`.
 * @returns the old and new switch values, or null when nothing had to change
 */
export function fixPartitioningSwitch(
  commandLine: SwitchLine,
): { before: string; after: string } | null {
  const before = commandLine.getSwitchValue("disable-features");
  const features = before
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
  if (!features.includes(PARTITIONING_FEATURE)) return null;
  const after = features.filter((feature) => feature !== PARTITIONING_FEATURE).join(",");
  commandLine.appendSwitch("disable-features", after);
  return { before, after };
}
