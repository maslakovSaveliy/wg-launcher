// Fixtures of the exporter browser tests: progress-lab on a free port per worker, the exporter bundled once per worker
// with Vite (an existing devDependency of the repo), and an isolated world of a stub page in which the bundle runs.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test as base, type CDPSession, expect, type Page } from "@playwright/test";
import { computeContentHash } from "@wg-launcher/snapshot/container";
import { build, type Rolldown } from "vite";
import type { WireEntry } from "./entry.js";

export type { Page, WireEntry };
export { expect };

const SERVER = fileURLToPath(
  new URL("../../../fixtures/test-games/progress-lab/server.mjs", import.meta.url),
);
const ENTRY = fileURLToPath(new URL("./entry.ts", import.meta.url));
export const STUB_PATH = "/__wg_quiescent__";

export interface Lab {
  /** `http://localhost:<port>`: progress-lab and the stub page share this origin. */
  origin: string;
}

/** The exporter's isolated world in the stub frame: `call` runs one function of browser/entry.ts there. */
export interface World {
  call<T>(name: string, ...args: unknown[]): Promise<T>;
  /** Evaluates an expression in the isolated world (test set-up only). */
  evaluate<T>(expression: string): Promise<T>;
  /** The page's CDP session (test set-up only, e.g. a lowered quota). */
  cdp: CDPSession;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no free port");
  return address.port;
}

async function startLab(): Promise<{ child: ChildProcess; origin: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, "--port", String(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.once("exit", (code) => reject(new Error(`progress-lab exited with ${code}`)));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("listening")) resolve();
    });
  });
  return { child, origin: `http://localhost:${port}` };
}

async function bundleExporter(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "es2024",
      lib: { entry: ENTRY, formats: ["iife"], name: "wgExporters", fileName: "exporters" },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunk = outputs.flatMap((o) => o.output).find((o) => o.type === "chunk");
  if (chunk === undefined || chunk.type !== "chunk") throw new Error("no bundle chunk");
  return chunk.code;
}

export const test = base.extend<
  { lab: Lab; openStub: (page: Page) => Promise<World> },
  { labServer: Lab; bundle: string }
>({
  labServer: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
    async ({}, use) => {
      const { child, origin } = await startLab();
      try {
        await use({ origin });
      } finally {
        child.kill();
      }
    },
    { scope: "worker" },
  ],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
  bundle: [async ({}, use) => use(await bundleExporter()), { scope: "worker" }],
  lab: async ({ labServer }, use) => use(labServer),
  // Every test fails on uncaught page errors, so a broken stub or game cannot pass.
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
  openStub: async ({ lab, bundle }, use) => {
    await use(async (page) => {
      // The stub stands in for the quiescent window's inert page: same origin as the game, no game code.
      await page.route(`${lab.origin}${STUB_PATH}`, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>stub</title>" }),
      );
      await page.goto(`${lab.origin}${STUB_PATH}`);
      const cdp = await page.context().newCDPSession(page);
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "wg-exporters-test",
      });
      const evaluate = async <T>(expression: string): Promise<T> => {
        const reply = await cdp.send("Runtime.evaluate", {
          expression,
          contextId: executionContextId,
          awaitPromise: true,
          returnByValue: true,
        });
        if (reply.exceptionDetails) {
          throw new Error(
            reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text,
          );
        }
        return reply.result.value as T;
      };
      await evaluate(bundle);
      // The bundle lives in the isolated world only; the page's main world never sees it.
      expect(await page.evaluate(() => "wgExporters" in globalThis)).toBe(false);
      expect(await evaluate<boolean>('typeof wgExporters.exportFrame === "function"')).toBe(true);
      return {
        cdp,
        evaluate,
        call: <T>(name: string, ...args: unknown[]) =>
          evaluate<T>(`wgExporters.${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`),
      };
    });
  },
});

/** Plays progress-lab from a clean state for `steps` steps and returns its own progress hash. */
export async function play(page: Page, lab: Lab, steps: number): Promise<string> {
  await page.goto(`${lab.origin}/?ephemeral=1`);
  return playMore(page, steps);
}

export async function playMore(page: Page, steps: number): Promise<string> {
  const hash = page.locator("#progress-hash");
  await expect(hash).toHaveAttribute("data-ready", "true");
  for (let i = 0; i < steps; i++) {
    await page.locator("#play-step").click();
  }
  await expect(hash).toHaveAttribute("data-ready", "true");
  return (await hash.textContent()) ?? "";
}

/** progress-lab's own hash of what is stored, after a fresh load that never writes. */
export async function progressHash(page: Page, lab: Lab): Promise<string> {
  await page.goto(`${lab.origin}/`);
  const hash = page.locator("#progress-hash");
  await expect(hash).toHaveAttribute("data-ready", "true");
  return (await hash.textContent()) ?? "";
}

export const topKey = (lab: Lab) => ({ origin: lab.origin, topLevelSite: null });

/** A new browser context with the suite's options and an empty storage, closed after `run`. */
export async function inFreshContext<T>(page: Page, run: (fresh: Page) => Promise<T>): Promise<T> {
  const browser = page.context().browser();
  if (browser === null) throw new Error("no browser");
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const fresh = await context.newPage();
    const errors: string[] = [];
    fresh.on("pageerror", (error) => errors.push(error.message));
    const result = await run(fresh);
    expect(errors).toEqual([]);
    return result;
  } finally {
    await context.close();
  }
}

export function entryBytes(entries: readonly WireEntry[], path: string): Uint8Array {
  const entry = entries.find((e) => e.path === path);
  if (entry === undefined) throw new Error(`no entry ${path}`);
  return new Uint8Array(Buffer.from(entry.base64, "base64"));
}

/** The `contentHash` the snapshot worker would compute for these entries under one `top` key. */
export function contentHashOf(entries: readonly WireEntry[], lab: Lab): string {
  const hashed = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => {
      const bytes = Buffer.from(e.base64, "base64");
      return {
        path: e.path,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
  return computeContentHash({ entries: hashed, storageKeys: [{ ...topKey(lab), role: "top" }] });
}
