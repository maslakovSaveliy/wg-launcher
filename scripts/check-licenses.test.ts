import { describe, expect, it } from "vitest";
import { evaluateLicenses } from "./check-licenses.mjs";

// Fixtures mirror the shape of `pnpm licenses list --json`: packages grouped by license string.
type Entry = { name: string; versions: string[]; license?: string };

function grouped(...entries: Entry[]): Record<string, Entry[]> {
  const report: Record<string, Entry[]> = {};
  for (const entry of entries) {
    const key = entry.license ?? "Unknown";
    const bucket = report[key] ?? [];
    bucket.push(entry);
    report[key] = bucket;
  }
  return report;
}

const pkg = (name: string, license?: string, version = "1.0.0"): Entry =>
  license === undefined ? { name, versions: [version] } : { name, versions: [version], license };

describe("evaluateLicenses", () => {
  it("rejects GPL-3.0 prod package", () => {
    const result = evaluateLicenses({ prod: grouped(pkg("gpl-lib", "GPL-3.0", "2.0.0")), dev: {} });

    expect(result.violations).toEqual([{ name: "gpl-lib", version: "2.0.0", license: "GPL-3.0" }]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects LGPL-2.1 prod package", () => {
    const result = evaluateLicenses({ prod: grouped(pkg("lgpl-lib", "LGPL-2.1")), dev: {} });

    expect(result.violations).toEqual([
      { name: "lgpl-lib", version: "1.0.0", license: "LGPL-2.1" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("reports but allows GPL dev-only package", () => {
    const result = evaluateLicenses({ prod: {}, dev: grouped(pkg("gpl-tool", "GPL-3.0")) });

    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([{ name: "gpl-tool", version: "1.0.0", license: "GPL-3.0" }]);
  });

  it("accepts MIT/Apache-2.0/BlueOak-1.0.0", () => {
    const result = evaluateLicenses({
      prod: grouped(pkg("a", "MIT"), pkg("b", "Apache-2.0"), pkg("c", "BlueOak-1.0.0")),
      dev: {},
    });

    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("accepts an OR expression when one alternative is allowed", () => {
    const result = evaluateLicenses({
      prod: grouped(
        pkg("a", "(MIT OR GPL-3.0)"),
        pkg("b", "GPL-3.0 OR Apache-2.0"),
        pkg("c", "(MIT OR CC0-1.0)"),
        pkg("d", "Apache-2.0 WITH LLVM-exception"),
      ),
      dev: {},
    });

    expect(result.violations).toEqual([]);
  });

  it("rejects an OR expression when no alternative is allowed", () => {
    const result = evaluateLicenses({ prod: grouped(pkg("a", "GPL-3.0 OR LGPL-2.1")), dev: {} });

    expect(result.violations).toHaveLength(1);
  });

  it("requires every operand of an AND expression to be allowed", () => {
    const result = evaluateLicenses({
      prod: grouped(pkg("ok", "MIT AND ISC"), pkg("bad", "MIT AND GPL-3.0")),
      dev: {},
    });

    expect(result.violations.map((finding) => finding.name)).toEqual(["bad"]);
  });

  it("binds AND tighter than OR", () => {
    const result = evaluateLicenses({
      prod: grouped(
        pkg("ok", "MIT OR GPL-3.0 AND LGPL-2.1"),
        pkg("bad", "GPL-3.0 OR LGPL-2.1 AND MIT"),
      ),
      dev: {},
    });

    expect(result.violations.map((finding) => finding.name)).toEqual(["bad"]);
  });

  it.each(["Unknown", "SEE LICENSE IN LICENSE.md", "Custom", "(MIT", "MIT OR", "", "UNLICENSED"])(
    "rejects prod package with unrecognised license %j",
    (license) => {
      const result = evaluateLicenses({ prod: grouped(pkg("odd", license)), dev: {} });

      expect(result.violations).toHaveLength(1);
    },
  );

  it("rejects prod package with a missing license field", () => {
    const result = evaluateLicenses({ prod: grouped(pkg("nolicense")), dev: {} });

    expect(result.violations).toEqual([
      { name: "nolicense", version: "1.0.0", license: "Unknown" },
    ]);
  });

  it("only warns about dev-only packages with an unknown license", () => {
    const result = evaluateLicenses({ prod: {}, dev: grouped(pkg("odd-dev")) });

    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([{ name: "odd-dev", version: "1.0.0", license: "Unknown" }]);
  });

  it("does not warn about allowed dev-only packages", () => {
    const result = evaluateLicenses({ prod: {}, dev: grouped(pkg("fine-dev", "ISC")) });

    expect(result.warnings).toEqual([]);
  });

  it("treats a package that is both prod and dev as prod", () => {
    const shared = pkg("shared-gpl", "GPL-3.0");
    const result = evaluateLicenses({ prod: grouped(shared), dev: grouped(shared) });

    expect(result.violations).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("reports one finding per installed version", () => {
    const result = evaluateLicenses({
      prod: grouped({ name: "multi", versions: ["1.0.0", "2.0.0"], license: "GPL-3.0" }),
      dev: {},
    });

    expect(result.violations.map((finding) => finding.version)).toEqual(["1.0.0", "2.0.0"]);
  });
});
