// End-to-end harness for the desktop app (architecture.md section 14): Playwright `_electron.launch` on the test
// build (`electron-vite build --mode test`, unfused), a fresh temporary userData directory per launch (never a real
// profile), and the progress-lab fixture server on a free port.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import type { TestHooks } from "../src/main/test-hooks.js";

export const APP_DIR = join(import.meta.dirname, "..");
const PROGRESS_LAB_SERVER = join(APP_DIR, "../../fixtures/test-games/progress-lab/server.mjs");
/** The Electron binary (the `electron` package exports its path); used to start a second instance. */
export const ELECTRON_PATH = createRequire(import.meta.url)("electron") as string;

export interface ProgressLab {
  /** `http://localhost:<port>` */
  local: string;
  /** `http://127.0.0.1:<port>`: the same server on another site. */
  loopback: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

/** Starts `fixtures/test-games/progress-lab/server.mjs` and waits until it listens. */
export async function startProgressLab(): Promise<ProgressLab> {
  const port = await freePort();
  const child = spawn(process.execPath, [PROGRESS_LAB_SERVER, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolveReady, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes("progress-lab listening")) {
        child.stdout.off("data", onData);
        resolveReady();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`progress-lab exited (${code}): ${stderr}`)));
  });
  // Drain the request log so a full pipe never blocks the server.
  child.stdout.resume();
  return {
    local: `http://localhost:${port}`,
    loopback: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolveStop) => {
        if (child.exitCode !== null) return resolveStop();
        child.once("exit", () => resolveStop());
        child.kill();
      }),
  };
}

/** The environment for an app process: the parent's, minus anything that would change how Electron runs. */
export function appEnv(userData: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE" && key !== "ELECTRON_RENDERER_URL") {
      env[key] = value;
    }
  }
  env.WG_USER_DATA = userData;
  return env;
}

/**
 * Electron's default `appData` directory on this OS (where the real app keeps its userData), computed without
 * starting Electron.
 */
function defaultAppData(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32")
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/** The userData directories of the real app (prod) and of the dev flavor. Tests must never create or change them. */
export const REAL_PROFILE_DIRS = ["WGLauncher", "WGLauncher Dev"].map((name) =>
  join(defaultAppData(), name),
);

async function listing(dir: string): Promise<string[] | null> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return null;
  }
}

/**
 * Records the real profile directories before a launch; `verify()` throws if a run created one or changed the
 * names in it. (Electron creates the userData directory as soon as anything reads `app.getPath("userData")`.)
 */
export async function guardRealProfiles(): Promise<{ verify(): Promise<void> }> {
  const before = await Promise.all(REAL_PROFILE_DIRS.map(listing));
  return {
    async verify() {
      const after = await Promise.all(REAL_PROFILE_DIRS.map(listing));
      REAL_PROFILE_DIRS.forEach((dir, i) => {
        if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) {
          throw new Error(
            `A test run touched the real profile directory ${dir}: before ${JSON.stringify(before[i])}, after ${JSON.stringify(after[i])}.`,
          );
        }
      });
    },
  };
}

export interface Launched {
  app: ElectronApplication;
  /** The launcher window. */
  launcher: Page;
  userData: string;
  progressLab: ProgressLab;
  /** Reads the test hooks of the running app (a JSON copy). */
  hooks(): Promise<Omit<TestHooks, "queueDialogAnswer" | "openTestWindow">>;
  close(): Promise<void>;
}

export async function launchApp(options: { userData?: string } = {}): Promise<Launched> {
  const userData = options.userData ?? (await mkdtemp(join(tmpdir(), "wg-e2e-")));
  const profiles = await guardRealProfiles();
  const progressLab = await startProgressLab();
  let app: ElectronApplication;
  try {
    app = await _electron.launch({
      // No executablePath: only then does Playwright add its loader (`-r loader.js`), which also appends
      // `--disable-features=...,ThirdPartyStoragePartitioning,...`; the app must undo that (architecture.md section
      // 5), and the partitioning test checks that it does. Playwright resolves the `electron` package itself.
      args: [APP_DIR],
      // Playwright adds --no-sandbox on Linux unless this is set; the app's windows rely on the sandbox.
      chromiumSandbox: true,
      cwd: APP_DIR,
      env: appEnv(userData),
      timeout: 30_000,
    });
  } catch (error) {
    await progressLab.stop();
    throw error;
  }
  const close = async () => {
    await app.close().catch(() => undefined);
    await progressLab.stop();
    if (options.userData === undefined) await rm(userData, { recursive: true, force: true });
    // Also covers second instances started during the test, which use the same environment.
    await profiles.verify();
  };
  try {
    // The launcher window is created after the test hooks are installed.
    const launcher = await app.firstWindow();
    const flavor = await app.evaluate(() => globalThis.__wgTest?.flavor ?? null);
    if (flavor !== "test") {
      throw new Error(
        "The app under test is not the test build: run `electron-vite build --mode test`.",
      );
    }
    const hooks = () => app.evaluate(() => JSON.parse(JSON.stringify(globalThis.__wgTest ?? null)));
    return { app, launcher, userData, progressLab, hooks, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Starts the app once more on the same userData without Playwright and resolves with its exit code. */
export function runSecondInstance(userData: string, timeoutMs = 20_000): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(ELECTRON_PATH, [APP_DIR], {
      cwd: APP_DIR,
      env: appEnv(userData),
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The second instance did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}
