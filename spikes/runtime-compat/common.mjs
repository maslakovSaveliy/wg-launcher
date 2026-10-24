// THROWAWAY spike (runtime-compat). Not product code.
// Helpers shared by the Task 6 runners (run-compare.mjs, run-timing.mjs, matrix.mjs). run.mjs
// (Electron, Task 5) keeps its own copies and is not changed by Task 6.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { makeValidator } from "./validate.mjs";

export const ROOT = import.meta.dirname;
export const REPO = resolve(ROOT, "../..");
export const RESULTS = join(ROOT, "results");
export const CHROME_BINARY = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const requireElectronDir = createRequire(join(ROOT, "electron/package.json"));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const iso = () => new Date().toISOString();
export const log = (...parts) => console.log(`[${iso().slice(11, 19)}]`, ...parts);

export function median(values) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function sh(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options }).trim();
  } catch (error) {
    return `ERROR: ${error.message.split("\n")[0]}`;
  }
}

export function screenLocked() {
  const out = sh("ioreg", ["-n", "Root", "-d1"]);
  if (/CGSSessionScreenIsLocked"=Yes/.test(out)) return true;
  if (out.startsWith("ERROR")) return null;
  return false;
}

/** Machine facts recorded with every aggregate. displayRefreshHz is filled in by the caller. */
export function machineInfo() {
  let gpu = "unknown";
  let display = null;
  let displayLine = null;
  try {
    const sp = JSON.parse(sh("system_profiler", ["SPDisplaysDataType", "-json"]));
    const card = sp.SPDisplaysDataType?.[0];
    gpu = `${card?.sppci_model ?? "?"} (${card?.sppci_cores ?? "?"} cores, ${card?.spdisplays_mtlgpufamilysupport ?? "?"})`;
    const screen = card?.spdisplays_ndrvs?.[0];
    display = screen ? { name: screen._name, resolution: screen._spdisplays_resolution ?? screen.spdisplays_resolution ?? null } : null;
    displayLine = display?.resolution ?? null;
  } catch {}
  return {
    osVersion: `macOS ${sh("sw_vers", ["-productVersion"])} (${sh("sw_vers", ["-buildVersion"])})`,
    arch: sh("uname", ["-m"]),
    cpu: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
    gpu,
    display,
    displayLine,
    displayRefreshHz: null,
    power: sh("pmset", ["-g", "batt"]).split("\n")[0],
    screenLockedAtStart: screenLocked(),
    runnerNode: process.version,
  };
}

/** Seconds since the last keyboard, trackpad or mouse input (IOHIDSystem), or null if unreadable. */
export function hidIdleSeconds() {
  const out = sh("ioreg", ["-c", "IOHIDSystem"]);
  const m = /"HIDIdleTime" = (\d+)/.exec(out);
  return m ? Number(m[1]) / 1e9 : null;
}

export function onBattery() {
  return /Battery Power/.test(sh("pmset", ["-g", "batt"]));
}

/** SIGTERM (then SIGKILL) every process whose command line mentions `dir`: leftovers of this run only. */
export async function killProcessesWithin(dir) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const found = processList().filter((p) => p.command.includes(dir) && p.pid !== process.pid);
    if (found.length === 0) return 0;
    for (const p of found) {
      try {
        process.kill(p.pid, signal);
      } catch {}
    }
    await sleep(1500);
  }
  return processList().filter((p) => p.command.includes(dir) && p.pid !== process.pid).length;
}

export function processList() {
  return sh("ps", ["-axo", "pid=,ppid=,command="])
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
}

export const processesMatching = (predicate) => processList().filter((p) => predicate(p.command));

/** pid and all descendants (from a fresh `ps`). */
export function processTree(rootPid, list = processList()) {
  const out = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = list.find((p) => p.pid === pid);
    if (self) out.push(self);
    for (const child of list) if (child.ppid === pid) queue.push(child.pid);
  }
  return out;
}

export const processSummary = (ps, sanitize) =>
  ps.map((p) => ({ pid: p.pid, ppid: p.ppid, command: sanitize(p.command).slice(0, 200) }));

/**
 * One run context: a per-run token, a temp directory, the sanitizer for everything that is written
 * to results/, and the progress-lab fixture server plus the spike server.
 */
export function createRun({ fixturePort = 4417, spikePort = 4418, allowOrigins = [], resultsDir = null } = {}) {
  const token = randomBytes(16).toString("hex");
  const tmp = mkdtempSync(join(tmpdir(), "wgspike-run-"));
  const home = homedir();
  const user = userInfo().username;
  const sanitize = (text) => {
    let out = String(text).split(token).join("<token>").split(tmp).join("<tmp>").split(REPO).join("<repo>").split(home).join("~");
    if (user.length >= 3) out = out.split(user).join("<user>");
    return out;
  };
  const servers = {};

  function startServer(name, script, port, extra = []) {
    const child = spawn(process.execPath, [script, "--port", String(port), ...extra], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = [];
    let ready;
    const listening = new Promise((r) => {
      ready = r;
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      lines.push({ at: Date.now(), line });
      if (line.includes("listening")) ready();
    });
    child.stderr.on("data", (d) => lines.push({ at: Date.now(), line: `STDERR ${d}` }));
    servers[name] = {
      child,
      lines,
      listening: Promise.race([listening, sleep(10000).then(() => Promise.reject(new Error(`${name} server did not start`)))]),
    };
  }

  const run = {
    resultsDir: resultsDir ?? RESULTS,
    token,
    tmp,
    fixturePort,
    spikePort,
    sanitize,
    servers,
    async startServers() {
      startServer("fixture", join(REPO, "fixtures/test-games/progress-lab/server.mjs"), fixturePort);
      const extra = ["--token", token];
      if (resultsDir) extra.push("--results-dir", resultsDir);
      for (const origin of allowOrigins) extra.push("--allow-origin", origin);
      startServer("spike", join(ROOT, "server.mjs"), spikePort, extra);
      await Promise.all([servers.fixture.listening, servers.spike.listening]);
    },
    stopServers() {
      for (const s of Object.values(servers)) s.child.kill("SIGTERM");
    },
    /** URL on the spike server with the run token. */
    spikeUrl(path, params = {}, { host = "localhost", token: withToken = true } = {}) {
      const query = new URLSearchParams(params);
      if (withToken) query.set("token", token);
      return `http://${host}:${spikePort}${path}?${query}`;
    },
    fixtureUrl: (path = "/", host = "localhost") => `http://${host}:${fixturePort}${path}`,
    /** Index to pass to waitResult before starting something that will POST a result. */
    mark: () => servers.spike.lines.length,
    /** Waits for the next "RESULT <file> <kind>" line after `after`; returns { file, kind, data }. */
    async waitResult(after, { timeoutMs = 90000 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        for (const { line } of servers.spike.lines.slice(after)) {
          const m = /^RESULT (\S+) (\S+)/.exec(line);
          if (m) return { file: m[1], kind: m[2], data: JSON.parse(readFileSync(join(ROOT, m[1]), "utf8")) };
        }
        await sleep(200);
      }
      throw new Error(`no RESULT line within ${timeoutMs} ms`);
    },
    resultFilesSince(after) {
      return servers.spike.lines.slice(after).map((l) => /^RESULT (\S+)/.exec(l.line)?.[1]).filter(Boolean);
    },
    fixtureLinesBetween(fromMs, toMs) {
      return servers.fixture.lines.filter((l) => l.at >= fromMs && l.at <= toMs).map((l) => l.line);
    },
    cleanupTmp() {
      execFileSync("rm", ["-rf", tmp]);
    },
  };
  return run;
}

// ---- Result files ----------------------------------------------------------------------------

export function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, ".$1Z");
}

/** Writes an aggregate (kind "run") into results/ after sanitizing and validates it with the schema. */
export function writeAggregate(run, { runtime, label, machine, startedAt, groups, hypotheses, checks, probeFiles, leftoverProcesses, extra = {} }) {
  const aggregate = {
    schemaVersion: 1,
    kind: "run",
    createdAt: iso(),
    runtime,
    label,
    machine,
    startedAt,
    finishedAt: iso(),
    groups,
    hypotheses,
    ...extra,
    checks,
    probeFiles,
    leftoverProcesses,
  };
  mkdirSync(run.resultsDir, { recursive: true });
  const safeVersion = String(runtime.version).replace(/[^A-Za-z0-9._-]/g, "_");
  const file = join(run.resultsDir, `${runtime.name}-${safeVersion}-${stamp()}.json`);
  const text = run.sanitize(JSON.stringify(aggregate, null, 2));
  writeFileSync(file, `${text}\n`);
  const error = makeValidator()(JSON.parse(text));
  return { file, rel: relative(ROOT, file), schemaError: error };
}

export function validateFiles(files) {
  const check = makeValidator();
  const bad = [];
  for (const file of files) {
    const error = check(JSON.parse(readFileSync(join(ROOT, file), "utf8")));
    if (error) bad.push({ file, error });
  }
  return bad;
}

// ---- Electron ----------------------------------------------------------------------------------

export function electronBinary(electronDir = "electron") {
  return createRequire(join(ROOT, electronDir, "package.json"))("electron");
}

export const electronBundle = (bin) => bin.slice(0, bin.indexOf(".app/") + 4);

/** One Electron launch of electron/main.mjs in `mode`; returns { exit, output, events, durationMs }. */
export async function launchElectron(run, mode, extra = [], { userData, timeoutMs = 240000, spawnArg = false, electronDir = "electron", onEvent } = {}) {
  const bin = electronBinary(electronDir);
  const out = join(run.tmp, `electron-${mode}-${Date.now()}.json`);
  const ud = userData ?? mkdtempSync(join(run.tmp, `ud-${mode}-`));
  const args = [
    resolve(ROOT, electronDir),
    `--mode=${mode}`,
    `--out=${out}`,
    `--wg-user-data=${ud}`,
    `--fixture-port=${run.fixturePort}`,
    `--spike-port=${run.spikePort}`,
    `--token=${run.token}`,
    ...extra,
  ];
  const spawnMs = Date.now();
  if (spawnArg) args.push(`--spawn-ms=${spawnMs}`);
  const child = spawn(bin, args, { cwd: resolve(ROOT, electronDir), stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let stderr = "";
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("WGSPIKE ")) return;
    try {
      const event = JSON.parse(line.slice(8));
      events.push(event);
      onEvent?.(event, child);
    } catch {}
  });
  child.stderr.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const exit = await new Promise((r) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      r({ code: null, signal: "SIGKILL(timeout)" });
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      r({ code, signal });
    });
  });
  const output = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  return { mode, extra, spawnMs, durationMs: Date.now() - spawnMs, exit, events, output, pid: child.pid, stderrTail: stderr ? run.sanitize(stderr).split("\n").slice(-6).join("\n") : null };
}

/** Electron facts needed by every runtime: versions and the display refresh rate (one short launch). */
export async function electronEnvironment(run) {
  const launch = await launchElectron(run, "env", [], { timeoutMs: 60000 });
  return launch.output?.environment ?? null;
}

// ---- Chrome via Playwright (H19) -----------------------------------------------------------

export function playwrightCore() {
  return requireElectronDir("playwright-core");
}

export function chromeVersion() {
  return /Google Chrome (\S+)/.exec(sh(CHROME_BINARY, ["--version"]))?.[1] ?? "unknown";
}

/**
 * Resizes the window so that the page's innerWidth x innerHeight are exactly width x height CSS px
 * (window size minus browser UI differs between Chrome, Chrome --app and Chromium).
 */
export async function sizeWindowByCdp(send, evaluate, width, height) {
  const { windowId } = await send("Browser.getWindowForTarget");
  let w = width;
  let h = height + 120;
  for (let i = 0; i < 6; i++) {
    await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal", width: w, height: h } });
    await sleep(300);
    const inner = await evaluate("({ w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight })");
    if (inner.w === width && inner.h === height) return { ok: true, windowWidth: w, windowHeight: h, ...inner };
    w += width - inner.w;
    h += height - inner.h;
  }
  const inner = await evaluate("({ w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight })");
  return { ok: false, windowWidth: w, windowHeight: h, ...inner };
}

/**
 * Starts Chrome (channel "chrome") or Playwright's bundled Chromium ("chromium"), headed, with a
 * fresh profile, one page sized to width x height CSS px, brought to the front.
 */
export async function launchPlaywrightBrowser({ channel = "chrome", uncapped = false, extraArgs = [], width = 1280, height = 720 } = {}) {
  const { chromium } = playwrightCore();
  const args = [...extraArgs];
  if (uncapped) args.push("--disable-gpu-vsync", "--disable-frame-rate-limit");
  const options = { headless: false, args };
  if (channel === "chrome") options.channel = "chrome";
  const started = Date.now();
  const browser = await chromium.launch(options);
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const sizing = await sizeWindowByCdp(
    (method, params) => cdp.send(method, params),
    (expression) => page.evaluate(expression),
    width,
    height,
  );
  await page.bringToFront();
  return { browser, context, page, cdp, sizing, version: browser.version(), launchedMs: Date.now() - started, close: () => browser.close() };
}

// ---- Chrome launched directly (H8, H20) ----------------------------------------------------

/**
 * Spawns the installed Chrome directly with its own user-data-dir. `app` uses --app=<url>
 * (no tab strip), otherwise the URL is a plain tab. A DevTools port is opened only when `cdp` is set
 * (port 0 = Chrome picks one and writes DevToolsActivePort into the profile).
 */
export function spawnChrome({ url, userDataDir, app = true, cdp = false, windowSize = null, extraArgs = [] }) {
  const args = [`--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check"];
  if (cdp) args.push("--remote-debugging-port=0");
  if (windowSize) args.push(`--window-size=${windowSize[0]},${windowSize[1]}`);
  args.push(...extraArgs);
  args.push(app ? `--app=${url}` : url);
  const spawnMs = Date.now();
  const child = spawn(CHROME_BINARY, args, { stdio: "ignore" });
  return { child, pid: child.pid, spawnMs, args };
}

export async function devToolsPort(userDataDir, timeoutMs = 20000) {
  const file = join(userDataDir, "DevToolsActivePort");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, "utf8").split("\n");
      if (/^\d+$/.test(port)) return Number(port);
    }
    await sleep(100);
  }
  throw new Error("DevToolsActivePort not written");
}

/** Minimal CDP client over a WebSocket (Node's global WebSocket). */
export async function cdpConnect(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  await new Promise((resolveOpen, reject) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", () => reject(new Error(`websocket error for ${webSocketUrl.split("/")[2]}`)), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else ok(message.result);
    } else if (message.method) {
      for (const l of listeners) l(message);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const messageId = ++id;
      ws.send(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(messageId)) reject(new Error(`CDP ${method} timed out`));
        }, 60000);
      });
    },
    onEvent: (fn) => listeners.push(fn),
    close: () => ws.close(),
    async evaluate(expression, { awaitPromise = true } = {}) {
      const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
  };
}

export async function jsonFetch(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

// ---- Memory (external, same definition for every runtime) ---------------------------------

/** Resident size (ps rss, KiB) and phys_footprint (macOS `footprint`, bytes) summed over a process tree. */
export function memoryOfTree(rootPid) {
  const tree = processTree(rootPid);
  const pids = tree.map((p) => p.pid);
  const ps = sh("ps", ["-o", "pid=,rss=", "-p", pids.join(",")]);
  const rss = new Map(ps.split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 2));
  const dir = mkdtempSync(join(tmpdir(), "wgspike-fp-"));
  const jsonFile = join(dir, "fp.json");
  sh("footprint", [...pids.map(String), "--noCategories", "-j", jsonFile]);
  const footprint = new Map();
  try {
    for (const p of JSON.parse(readFileSync(jsonFile, "utf8")).processes ?? []) footprint.set(p.pid, p.footprint);
  } catch {}
  execFileSync("rm", ["-rf", dir]);
  const rows = tree.map((p) => ({
    pid: p.pid,
    rssKiB: rss.get(p.pid) ?? null,
    footprintKiB: footprint.has(p.pid) ? Math.round(footprint.get(p.pid) / 1024) : null,
  }));
  const sum = (field) => rows.reduce((a, r) => a + (r[field] ?? 0), 0);
  return {
    processes: rows.length,
    rssMiB: sum("rssKiB") / 1024,
    footprintMiB: sum("footprintKiB") / 1024,
    footprintProcessesCounted: rows.filter((r) => r.footprintKiB !== null).length,
    rows,
  };
}

// ---- Frame statistics (same definitions as probe/probe.js) ------------------------------------

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Frame statistics of rAF deltas; a long frame is a delta above 2 x the vsync interval. */
export function frameStats(deltas, vsyncMs) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const longThreshold = vsyncMs ? vsyncMs * 2 : null;
  const longFrames = longThreshold === null ? null : deltas.filter((d) => d > longThreshold).length;
  const sum = deltas.reduce((a, b) => a + b, 0);
  return {
    count: deltas.length,
    meanMs: deltas.length ? sum / deltas.length : null,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
    longFrameThresholdMs: longThreshold,
    longFrames,
    longFrameShare: longFrames === null || deltas.length === 0 ? null : longFrames / deltas.length,
  };
}
