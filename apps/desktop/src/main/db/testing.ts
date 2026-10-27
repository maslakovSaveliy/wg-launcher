// Helpers for the database tests only (never imported by product code): a temporary directory per test and a
// fake clock, so nothing touches a real profile and every timestamp is deterministic.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** A fresh temporary directory, removed after the current test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wg-db-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A clock that starts at `start` and moves only when told to. */
export function fakeClock(start = 1_800_000_000_000): {
  now: () => number;
  advance(ms: number): void;
} {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}
