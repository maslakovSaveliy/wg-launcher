// Honest badges (PRD section 7, architecture.md section 11) as one pure function. Badges come
// from recorded state only; a later task maps database rows to `BadgeRecord`. UI strings are
// not decided here.

export type SupportMode = "by-link";

export interface BadgeRecord {
  supportMode: SupportMode;
  /** The latest storage check of the game, or null if none ever ran. */
  lastCheck: { hasData: boolean; checkedAt: number } | null;
  /** `verified_exporter_version` of every snapshot of the game whose `verified_at` is set. */
  verifiedExporterVersions: readonly string[];
  runningExporterVersion: string;
}

export type Badge =
  | { id: "by-link" }
  | { id: "needs-internet" }
  | { id: "local-data"; checkedAt: number }
  | { id: "export-verified" }
  | { id: "compat-not-verified" };

export type BadgeId = Badge["id"];

/** Badges in a fixed order: by link, needs internet, local data, export verified, compatibility. */
export function badgesFor(r: BadgeRecord): Badge[] {
  const badges: Badge[] = [];
  if (r.supportMode === "by-link") {
    badges.push({ id: "by-link" });
    // In the MVP "Needs internet" has the same condition as "By link".
    badges.push({ id: "needs-internet" });
  }
  if (r.lastCheck?.hasData) {
    badges.push({ id: "local-data", checkedAt: r.lastCheck.checkedAt });
  }
  if (
    r.runningExporterVersion !== "" &&
    r.verifiedExporterVersions.includes(r.runningExporterVersion)
  ) {
    badges.push({ id: "export-verified" });
  }
  // No verification records exist in the MVP (AC-21), so the default is never removed.
  badges.push({ id: "compat-not-verified" });
  return badges;
}
