import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wg-logs-"));
  dirs.push(dir);
  return dir;
}
const lines = async (file: string) =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("createLogger", () => {
  it("writes one JSON record per line to logs/main.log, every record through redact", async () => {
    const dir = await tempDir();
    const logger = createLogger(dir, { now: () => new Date("2026-10-28T00:00:00.000Z") });
    logger.info("game.launch", { url: "https://g.example/play?token=1", headers: { cookie: "x" } });
    logger.warn("nav.refused https://evil.example/path");
    await logger.flush();

    expect(await lines(join(dir, "main.log"))).toEqual([
      {
        time: "2026-10-28T00:00:00.000Z",
        level: "info",
        event: "game.launch",
        url: "https://g.example",
        headers: {},
      },
      {
        time: "2026-10-28T00:00:00.000Z",
        level: "warn",
        event: "nav.refused https://evil.example",
      },
    ]);
  });

  it("rotates at the size limit and keeps at most the configured number of files", async () => {
    const dir = await tempDir();
    const logger = createLogger(dir, { maxBytes: 300, maxFiles: 3 });
    for (let i = 0; i < 40; i++) logger.info("step", { i });
    await logger.flush();

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["main.log", "main.log.1", "main.log.2"]);
    for (const file of files) {
      expect((await readFile(join(dir, file))).length).toBeLessThanOrEqual(300);
    }
    // The newest record is in main.log, older ones in .1 and .2, the oldest are gone.
    const newest = await lines(join(dir, "main.log"));
    expect(newest.at(-1)?.i).toBe(39);
    const oldest = await lines(join(dir, "main.log.2"));
    expect(Number(oldest[0]?.i)).toBeGreaterThan(0);
    expect(Number(oldest.at(-1)?.i)).toBeLessThan(Number(newest[0]?.i));
  });

  it("uses 5 files of 5 MiB by default", () => {
    expect(createLogger.defaults).toEqual({ maxBytes: 5 * 1024 * 1024, maxFiles: 5 });
  });
});
