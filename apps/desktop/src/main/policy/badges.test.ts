import { describe, expect, it } from "vitest";
import { type BadgeRecord, badgesFor } from "./badges.js";

// AC-14 (architecture.md section 11, PRD section 7): each badge is shown if and only if its
// condition holds, in each recorded state.

const base: BadgeRecord = {
  supportMode: "by-link",
  lastCheck: null,
  verifiedExporterVersions: [],
  runningExporterVersion: "1.0.0",
};

const ids = (r: BadgeRecord) => badgesFor(r).map((b) => b.id);

describe("badgesFor", () => {
  it("shows only the always-on badges for a fresh entry", () => {
    expect(badgesFor(base)).toEqual([
      { id: "by-link" },
      { id: "needs-internet" },
      { id: "compat-not-verified" },
    ]);
  });

  describe("By link and Needs internet", () => {
    it("are shown for the by-link support mode", () => {
      expect(ids(base)).toContain("by-link");
      expect(ids(base)).toContain("needs-internet");
    });

    it("are both absent for any other support mode", () => {
      const other = { ...base, supportMode: "package" } as unknown as BadgeRecord;
      expect(ids(other)).not.toContain("by-link");
      expect(ids(other)).not.toContain("needs-internet");
    });
  });

  describe("Local data", () => {
    it("is absent when no storage check exists (never guessed)", () => {
      expect(ids({ ...base, lastCheck: null })).not.toContain("local-data");
    });

    it("is absent when the latest check found no data", () => {
      const r = { ...base, lastCheck: { hasData: false, checkedAt: 1_700_000_000_000 } };
      expect(ids(r)).not.toContain("local-data");
    });

    it("is shown with the check time when the latest check found data", () => {
      const r = { ...base, lastCheck: { hasData: true, checkedAt: 1_700_000_000_000 } };
      expect(badgesFor(r)).toContainEqual({ id: "local-data", checkedAt: 1_700_000_000_000 });
    });
  });

  describe("Export verified", () => {
    it("is absent without any verified snapshot", () => {
      expect(ids({ ...base, verifiedExporterVersions: [] })).not.toContain("export-verified");
    });

    it("is absent when the verified version differs from the running exporter", () => {
      const r = { ...base, verifiedExporterVersions: ["0.9.0", "1.0.1"] };
      expect(ids(r)).not.toContain("export-verified");
    });

    it("is shown when a verified snapshot has the running exporter version", () => {
      const r = { ...base, verifiedExporterVersions: ["0.9.0", "1.0.0"] };
      expect(ids(r)).toContain("export-verified");
    });

    it("compares versions exactly, not by prefix or case", () => {
      expect(ids({ ...base, verifiedExporterVersions: ["1.0"] })).not.toContain("export-verified");
      expect(ids({ ...base, verifiedExporterVersions: ["1.0.0-rc.1"] })).not.toContain(
        "export-verified",
      );
      expect(
        ids({
          ...base,
          runningExporterVersion: "1.0.0-RC.1",
          verifiedExporterVersions: ["1.0.0-rc.1"],
        }),
      ).not.toContain("export-verified");
    });

    it("is never shown for an empty running version, even if an empty one is recorded", () => {
      const r = { ...base, runningExporterVersion: "", verifiedExporterVersions: [""] };
      expect(ids(r)).not.toContain("export-verified");
    });
  });

  describe("Compatibility not verified", () => {
    it("is always shown in the MVP, whatever else is recorded", () => {
      const states: BadgeRecord[] = [
        base,
        { ...base, lastCheck: { hasData: true, checkedAt: 1 } },
        { ...base, lastCheck: { hasData: false, checkedAt: 1 } },
        { ...base, verifiedExporterVersions: ["1.0.0"] },
        {
          ...base,
          lastCheck: { hasData: true, checkedAt: 1 },
          verifiedExporterVersions: ["1.0.0"],
        },
        { ...base, supportMode: "package" } as unknown as BadgeRecord,
      ];
      for (const s of states) expect(ids(s)).toContain("compat-not-verified");
    });
  });

  it("returns every badge in a stable order", () => {
    const r: BadgeRecord = {
      ...base,
      lastCheck: { hasData: true, checkedAt: 42 },
      verifiedExporterVersions: ["1.0.0"],
    };
    expect(badgesFor(r)).toEqual([
      { id: "by-link" },
      { id: "needs-internet" },
      { id: "local-data", checkedAt: 42 },
      { id: "export-verified" },
      { id: "compat-not-verified" },
    ]);
  });

  it("does not mutate its input", () => {
    const r: BadgeRecord = Object.freeze({
      ...base,
      lastCheck: Object.freeze({ hasData: true, checkedAt: 1 }),
      verifiedExporterVersions: Object.freeze(["1.0.0"]) as unknown as string[],
    });
    expect(() => badgesFor(r)).not.toThrow();
  });
});
