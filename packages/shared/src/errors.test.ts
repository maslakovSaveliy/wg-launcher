import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, EXP_CODES, IMP_CODES, IPC_CODES, SNAP_CODES } from "./errors.js";
import type { ErrorCode, Result } from "./index.js";

const specsDir = new URL("../../../docs/specs/", import.meta.url);
const specs = readdirSync(specsDir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => readFileSync(new URL(name, specsDir), "utf8"))
  .join("\n");

const sorted = (values: readonly string[]) => [...values].sort();

describe("error codes", () => {
  it.each([
    ["SNAP", SNAP_CODES],
    ["EXP", EXP_CODES],
    ["IMP", IMP_CODES],
  ])("%s_* codes are exactly the ones the specs name", (prefix, codes) => {
    const named = new Set(specs.match(new RegExp(`\\b${prefix}_[A-Z0-9_]+`, "g")));

    expect(sorted(codes)).toEqual(sorted([...named]));
  });

  it("IPC codes are the ones architecture.md section 6 lists", () => {
    for (const code of IPC_CODES) {
      expect(specs).toContain(`\`${code}\``);
    }
  });

  it("has no duplicates and a stable prefix per family", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(SNAP_CODES.every((code) => code.startsWith("SNAP_"))).toBe(true);
    expect(EXP_CODES.every((code) => code.startsWith("EXP_"))).toBe(true);
    expect(IMP_CODES.every((code) => code.startsWith("IMP_"))).toBe(true);
  });

  it("does not take log event names as result codes", () => {
    expect(ERROR_CODES).not.toContain("SW_STOP_FAILED");
    expect(ERROR_CODES).not.toContain("IPC_FORBIDDEN_SENDER");
  });
});

describe("Result", () => {
  it("is a discriminated union over ok, with ErrorCode as the default code type", () => {
    const success: Result<{ n: number }> = { ok: true, data: { n: 1 } };
    const failure: Result<never> = { ok: false, code: "SNAP_TRUNCATED", message: "short" };
    const custom: Result<never, "ONLY_THIS"> = { ok: false, code: "ONLY_THIS", message: "x" };
    // @ts-expect-error: a code that is not an ErrorCode is refused by the default
    const bad: Result<never> = { ok: false, code: "NOT_A_CODE", message: "x" };
    const code: ErrorCode = failure.ok ? "INTERNAL" : failure.code;

    expect([success.ok, failure.ok, custom.ok, bad.ok, code]).toEqual([
      true,
      false,
      false,
      false,
      "SNAP_TRUNCATED",
    ]);
  });
});
