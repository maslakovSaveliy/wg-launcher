import { describe, expect, it } from "vitest";
import { dropSqliteNotice, type WarningTarget } from "./warning-filter.js";

/** Warnings that reach `process.on("warning")` after `emit` has run. */
async function warningsAfter(emit: () => void | Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const listener = (warning: Error) => seen.push(`${warning.name}: ${warning.message}`);
  process.on("warning", listener);
  try {
    await emit();
    // Node emits warnings on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", listener);
  }
  return seen;
}

describe("the Vitest warning filter", () => {
  // scripts/vitest-setup.ts installed it on this worker's `process` before this file was imported.
  it("is active: loading node:sqlite and its notice reach no warning listener", async () => {
    const seen = await warningsAfter(async () => {
      await import("node:sqlite");
      process.emitWarning(
        "SQLite is an experimental feature and might change at any time",
        "ExperimentalWarning",
      );
    });
    expect(seen).toEqual([]);
  });

  it("passes every other warning on, including another ExperimentalWarning", () => {
    const calls: unknown[][] = [];
    const target: WarningTarget = { emitWarning: (...args) => void calls.push(args) };
    dropSqliteNotice(target);

    target.emitWarning("Some other API is an experimental feature", "ExperimentalWarning" as never);
    target.emitWarning(new Error("SQLite is an experimental feature and might change at any time"));
    target.emitWarning("old thing", "DeprecationWarning" as never);

    expect(calls).toEqual([
      ["Some other API is an experimental feature", "ExperimentalWarning"],
      ["old thing", "DeprecationWarning"],
    ]);
  });
});
