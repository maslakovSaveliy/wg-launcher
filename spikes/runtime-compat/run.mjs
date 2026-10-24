// THROWAWAY spike runner (runtime-compat). Not product code.
//
//   node run.mjs --runtime=electron [--only=<group,...>] [--skip=<group,...>] [--load=<n>]
//                [--frame-runs=3] [--fixture-port=4417] [--spike-port=4418] [--allow-locked]
//
// Starts the progress-lab fixture server and the spike server, runs one Electron launch per check
// (electron/main.mjs --mode=...), evaluates each hypothesis of HYPOTHESES.md with the rules coded
// in evaluate() below, writes results/electron-<version>-<UTC timestamp>.json (kind "run"),
// validates it and every probe payload of this run against results.schema.json, prints a summary
// and checks that no process of the Electron bundle is left behind.
// Groups: storage coi gpu sqlite playwright permissions h14 h16 package coldstart frametime memory.
// Timing groups (and permissions, whose pointer lock needs focus) are skipped while the macOS
// screen is locked, unless --allow-locked; a skipped or unfocused run is never a PASS.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { makeValidator } from "./validate.mjs";

const ROOT = import.meta.dirname;
const REPO = resolve(ROOT, "../..");
const ALL_GROUPS = [
  "storage",
  "coi",
  "gpu",
  "sqlite",
  "playwright",
  "h14",
  "h16",
  "package",
  "permissions",
  "coldstart",
  "frametime",
  "memory",
];
const NEEDS_UNLOCKED_SCREEN = new Set(["permissions", "coldstart", "frametime", "memory"]);

const { values: opts } = parseArgs({
  options: {
    runtime: { type: "string" },
    only: { type: "string" },
    skip: { type: "string" },
    load: { type: "string" },
    "frame-runs": { type: "string", default: "3" },
    "frame-modes": { type: "string", default: "capped,uncapped" },
    cooldown: { type: "string", default: "30" },
    "fixture-port": { type: "string", default: "4417" },
    "spike-port": { type: "string", default: "4418" },
    "electron-dir": { type: "string", default: "electron" },
    "allow-locked": { type: "boolean", default: false },
    "keep-temp": { type: "boolean", default: false },
  },
  strict: true,
});
if (opts.runtime !== "electron") {
  console.error("Usage: node run.mjs --runtime=electron [--only=...] (chrome and tauri are Task 6)");
  process.exit(2);
}
const FIXTURE = Number(opts["fixture-port"]);
const SPIKE = Number(opts["spike-port"]);
const ELECTRON_DIR = resolve(ROOT, opts["electron-dir"]);
const requireElectron = createRequire(join(ELECTRON_DIR, "package.json"));
const ELECTRON_BIN = requireElectron("electron");
const BUNDLE = ELECTRON_BIN.slice(0, ELECTRON_BIN.indexOf(".app/") + 4);
const groups = (opts.only ? opts.only.split(",") : ALL_GROUPS).filter(
  (g) => !(opts.skip ?? "").split(",").includes(g),
);
for (const g of groups) {
  if (!ALL_GROUPS.includes(g)) {
    console.error(`unknown group ${g}; groups: ${ALL_GROUPS.join(" ")}`);
    process.exit(2);
  }
}

const TMP = mkdtempSync(join(tmpdir(), "wgspike-run-"));
const HOME = homedir();
const USER = userInfo().username;

function sanitize(text) {
  let out = text.split(TMP).join("<tmp>").split(REPO).join("<repo>").split(HOME).join("~");
  if (USER.length >= 3) out = out.split(USER).join("<user>");
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (error) {
    return `ERROR: ${error.message.split("\n")[0]}`;
  }
};
const log = (...parts) => console.log(`[${iso().slice(11, 19)}]`, ...parts);

// ---- Machine -----------------------------------------------------------------------------------

function screenLocked() {
  const out = sh("ioreg", ["-n", "Root", "-d1"]);
  if (/CGSSessionScreenIsLocked"=Yes/.test(out)) return true;
  if (out.startsWith("ERROR")) return null;
  return false;
}

function machineInfo() {
  let gpu = "unknown";
  let display = null;
  try {
    const sp = JSON.parse(sh("system_profiler", ["SPDisplaysDataType", "-json"]));
    const card = sp.SPDisplaysDataType?.[0];
    gpu = `${card?.sppci_model ?? "?"} (${card?.sppci_cores ?? "?"} cores, ${card?.spdisplays_mtlgpufamilysupport ?? "?"})`;
    const screen = card?.spdisplays_ndrvs?.[0];
    display = screen ? { name: screen._name, resolution: screen._spdisplays_resolution ?? screen.spdisplays_resolution ?? null } : null;
  } catch {}
  return {
    osVersion: `macOS ${sh("sw_vers", ["-productVersion"])} (${sh("sw_vers", ["-buildVersion"])})`,
    arch: sh("uname", ["-m"]),
    cpu: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
    gpu,
    display,
    displayRefreshHz: null, // filled from Electron's screen.getPrimaryDisplay().displayFrequency
    power: sh("pmset", ["-g", "batt"]).split("\n")[0],
    screenLockedAtStart: screenLocked(),
    runnerNode: process.version,
  };
}

// ---- Processes -------------------------------------------------------------------------------

function processesMatching(predicate) {
  return sh("ps", ["-axo", "pid=,ppid=,command="])
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }))
    .filter((p) => predicate(p.command));
}
const bundleProcesses = () => processesMatching((c) => c.includes(BUNDLE));
const brief = (ps) => ps.map((p) => ({ pid: p.pid, ppid: p.ppid, command: sanitize(p.command).slice(0, 160) }));

async function waitNoBundleProcesses(timeoutMs = 10000) {
  const started = Date.now();
  let remaining = bundleProcesses();
  while (remaining.length > 0 && Date.now() - started < timeoutMs) {
    await sleep(250);
    remaining = bundleProcesses();
  }
  return { waitedMs: Date.now() - started, remaining: brief(remaining) };
}

// ---- Servers -----------------------------------------------------------------------------------

function startServer(name, script, extra = []) {
  const child = spawn(process.execPath, [script, "--port", String(name === "fixture" ? FIXTURE : SPIKE), ...extra], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  const rl = createInterface({ input: child.stdout });
  let ready;
  const listening = new Promise((r) => {
    ready = r;
  });
  rl.on("line", (line) => {
    lines.push({ at: Date.now(), line });
    if (line.includes("listening")) ready();
  });
  child.stderr.on("data", (d) => lines.push({ at: Date.now(), line: `STDERR ${d}` }));
  return {
    child,
    lines,
    listening: Promise.race([listening, sleep(10000).then(() => Promise.reject(new Error(`${name} server did not start`)))]),
    stop: () => child.kill("SIGTERM"),
  };
}

/** Fixture request-log lines whose own timestamp lies in [from, to] (ISO strings), with margin. */
function fixtureRequestsBetween(server, from, to, marginMs = 5) {
  const a = Date.parse(from) - marginMs;
  const b = Date.parse(to) + marginMs;
  return server.lines
    .map((l) => l.line)
    .filter((line) => {
      const t = Date.parse(line.split(" ", 1)[0]);
      return Number.isFinite(t) && t >= a && t <= b;
    });
}

// ---- Electron launches -------------------------------------------------------------------------

let launchSeq = 0;
const launches = [];

async function runElectron(mode, extra = [], { userData, timeoutMs = 240000, onEvent, spawnArg = false } = {}) {
  const seq = ++launchSeq;
  const out = join(TMP, `${String(seq).padStart(2, "0")}-${mode}.json`);
  const ud = userData ?? mkdtempSync(join(TMP, `ud-${mode}-`));
  const args = [
    ELECTRON_DIR,
    `--mode=${mode}`,
    `--out=${out}`,
    `--wg-user-data=${ud}`,
    `--fixture-port=${FIXTURE}`,
    `--spike-port=${SPIKE}`,
    ...extra,
  ];
  const before = bundleProcesses().length;
  const spawnMs = Date.now();
  if (spawnArg) args.push(`--spawn-ms=${spawnMs}`);
  const child = spawn(ELECTRON_BIN, args, { cwd: ELECTRON_DIR, stdio: ["ignore", "pipe", "pipe"] });
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
  const durationMs = Date.now() - spawnMs;
  let output = null;
  if (existsSync(out)) output = JSON.parse(readFileSync(out, "utf8"));
  if (output?.environment && mode !== "env") {
    // The full environment is recorded once (checks.env); keep what can differ per launch.
    const e = output.environment;
    output.environment = { versions: e.versions, switches: e.switches, displayFrequency: e.display?.displayFrequency ?? null, gpuFeatureStatus: { webgl: e.gpuFeatureStatus?.webgl, webgpu: e.gpuFeatureStatus?.webgpu, gpu_compositing: e.gpuFeatureStatus?.gpu_compositing } };
  }
  const record = {
    mode,
    extra,
    spawnMs,
    durationMs,
    exit,
    bundleProcessesBefore: before,
    events: events.filter((e) => e.type !== "trace"),
    stderrTail: stderr ? sanitize(stderr).split("\n").slice(-8).join("\n") : null,
    output,
  };
  launches.push({ seq, mode, extra, exit, durationMs, error: output?.error ?? null });
  log(`  ${mode} ${extra.join(" ")} -> exit ${exit.code ?? exit.signal} in ${durationMs} ms${output?.error ? ` ERROR ${output.error.split("\n")[0]}` : ""}`);
  return record;
}

const probeData = (record) => record.output?.result?.probe?.result?.data ?? null;
const probeChecks = (record) => probeData(record)?.checks ?? null;

// ---- Groups ------------------------------------------------------------------------------------

const checks = {};
let fixture;

async function groupStorage() {
  const ud = mkdtempSync(join(TMP, "ud-h1-"));
  const state = join(TMP, "h1-state.json");
  const h1 = await runElectron("h1-write", [`--state=${state}`], { userData: ud });
  const afterQuit = await waitNoBundleProcesses(10000);
  const h2 = await runElectron("h2-read", [`--state=${state}`], { userData: ud });
  const udk = mkdtempSync(join(TMP, "ud-h2b-"));
  const statek = join(TMP, "h2b-state.json");
  let writtenAt = null;
  let killedAt = null;
  const h2bWrite = await runElectron("h2b-write", [`--state=${statek}`], {
    userData: udk,
    onEvent: (event, child) => {
      if (event.type !== "written") return;
      writtenAt = Date.now();
      setTimeout(() => {
        killedAt = Date.now();
        child.kill("SIGKILL");
      }, 5000);
    },
  });
  const afterKill = await waitNoBundleProcesses(10000);
  if (afterKill.remaining.length) {
    for (const p of afterKill.remaining) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    }
  }
  const h2bRead = await runElectron("h2b-read", [`--state=${statek}`], { userData: udk });
  checks.storage = {
    h1,
    afterGracefulQuit: afterQuit,
    h2,
    h2b: { write: h2bWrite, killDelayMs: killedAt && writtenAt ? killedAt - writtenAt : null, afterKill, read: h2bRead },
  };
}

async function groupCoi() {
  checks.coi = {
    h3: await runElectron("page-probe", ["--path=/coi/", "--checks=coi", "--label=h3-server-headers"]),
    h3Control: await runElectron("page-probe", ["--path=/", "--checks=coi", "--label=h3-control"]),
    h4: await runElectron("page-probe", ["--path=/", "--checks=coi", "--inject-coi", "--label=h4-injected-headers"]),
    h4Control: await runElectron("page-probe", ["--path=/", "--checks=coi", "--label=h4-control"]),
  };
}

async function groupGpu() {
  const runs = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const run = await runElectron("page-probe", ["--path=/coi/", `--label=probe-full-${attempt}`]);
    runs.push(run);
    if (probeChecks(run)?.webgl2?.softwareRenderer !== true) break; // retry only a software renderer (H6)
  }
  const last = runs.at(-1);
  let unsafe = null;
  if (probeChecks(last)?.webgpu?.adapter == null) {
    unsafe = await runElectron("page-probe", ["--path=/coi/", "--checks=webgpu", "--unsafe-webgpu", "--label=probe-unsafe-webgpu"]);
  }
  checks.gpu = { runs, unsafeWebgpuRetry: unsafe };
}

async function groupSqlite() {
  checks.sqlite = await runElectron("sqlite");
}

async function playwrightRun(restorePartitioning) {
  const { _electron, chromium } = requireElectron("playwright-core");
  const ud = mkdtempSync(join(TMP, "ud-h11-"));
  const extra = ["--mode=h11", `--wg-user-data=${ud}`, `--fixture-port=${FIXTURE}`, `--spike-port=${SPIKE}`];
  if (restorePartitioning) extra.push("--restore-partitioning");
  const started = Date.now();
  const out = { method: "_electron.launch", restorePartitioning };
  try {
    const app = await _electron.launch({ args: [ELECTRON_DIR, ...extra], cwd: ELECTRON_DIR, timeout: 60000 });
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('#progress-hash[data-ready="true"]', { timeout: 30000 });
      const before = await page.textContent("#progress-hash");
      await page.click("#play-step");
      await page.waitForFunction(
        (h) => {
          const e = document.querySelector("#progress-hash");
          return e.dataset.ready === "true" && e.textContent !== h;
        },
        before,
        { timeout: 30000 },
      );
      out.hashBefore = before;
      out.hashAfterClick = await page.textContent("#progress-hash");
      out.clickChangedHash = out.hashBefore !== out.hashAfterClick;
      out.mainEvaluate = await app.evaluate(({ app: a }) => ({
        name: a.getName(),
        electron: process.versions.electron,
        disableFeatures: a.commandLine.getSwitchValue("disable-features") || null,
      }));
      out.partitioning = await app.evaluate(() => globalThis.__wgSpike.partitionCheck());
    } finally {
      await app.close();
    }
    out.ok = out.clickChangedHash === true;
  } catch (error) {
    out.ok = false;
    out.error = sanitize(String(error?.stack ?? error)).slice(0, 2000);
  }
  out.durationMs = Date.now() - started;
  out.afterClose = await waitNoBundleProcesses(10000);
  if (!out.ok && !restorePartitioning) {
    // Fallback per H11: connectOverCDP against --remote-debugging-port.
    const port = 9339;
    const child = spawn(ELECTRON_BIN, [ELECTRON_DIR, ...extra, `--remote-debugging-port=${port}`], { cwd: ELECTRON_DIR, stdio: "ignore" });
    const fallback = { method: "chromium.connectOverCDP" };
    try {
      await sleep(3000);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser.contexts()[0]?.pages()[0];
      await page.click("#play-step");
      fallback.ok = true;
      await browser.close();
    } catch (error) {
      fallback.ok = false;
      fallback.error = String(error).slice(0, 500);
    }
    child.kill("SIGTERM");
    out.fallback = fallback;
    await waitNoBundleProcesses(10000);
  }
  return out;
}

async function groupPlaywright() {
  log("  playwright _electron.launch (default switches)");
  const plain = await playwrightRun(false);
  log(`    ok=${plain.ok} partitioned=${plain.partitioning?.partitioned}`);
  log("  playwright _electron.launch (--restore-partitioning)");
  const restored = await playwrightRun(true);
  log(`    ok=${restored.ok} partitioned=${restored.partitioning?.partitioned}`);
  const normal = await runElectron("partition-check");
  checks.playwright = { h11: plain, h11RestorePartitioning: restored, normalLaunchPartitionCheck: normal };
}

async function groupH14() {
  const windows = [];
  const record = await runElectron("h14", [], {
    timeoutMs: 600000,
    onEvent: (event) => {
      if (event.type === "export-window" && event.phase === "closed") windows.push(event);
    },
  });
  const variants = record.output?.result?.variants ?? {};
  const fixtureDuringWindows = {};
  for (const [v, data] of Object.entries(variants)) {
    if (!data?.export) continue;
    fixtureDuringWindows[v] = {
      export: fixtureRequestsBetween(fixture, data.export.t0, data.export.t1),
      bypassControl: data.bypassControl ? fixtureRequestsBetween(fixture, data.bypassControl.t0, data.bypassControl.t1) : null,
    };
  }
  checks.h14 = { record, exportWindows: windows, fixtureRequestsDuringExportWindows: fixtureDuringWindows };
}

async function groupH16() {
  const snapshots = { beforeLaunch: brief(bundleProcesses()) };
  const record = await runElectron("h16", [], {
    timeoutMs: 240000,
    onEvent: (event) => {
      if (event.type === "game-open") snapshots.gameOpen = brief(bundleProcesses());
      if (event.type === "game-closed-5s") snapshots.gameClosed5s = brief(bundleProcesses());
    },
  });
  await sleep(5000);
  snapshots.appQuit5s = brief(bundleProcesses());
  checks.h16 = { record, snapshots };
}

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

async function groupPackage() {
  const appPath = join(ELECTRON_DIR, "dist/mac-arm64/wgspike.app");
  const exe = join(appPath, "Contents/MacOS/wgspike");
  const logDir = join(HOME, "Library/Application Support/wgspike");
  const logFile = join(logDir, "deeplink-log.jsonl");
  const result = { appPath: sanitize(appPath) };
  const lsCount = () => Number(sh("sh", ["-c", `${LSREGISTER} -dump | grep -c "dev.wglauncher.spike.throwaway" || true`]));
  result.build = sh(join(ELECTRON_DIR, "node_modules/.bin/electron-builder"), ["--mac", "dir", "--arm64", "--config", join(ELECTRON_DIR, "electron-builder.json"), "--projectDir", ELECTRON_DIR])
    .split("\n")
    .filter((l) => /packaging|signing|ERROR/.test(l))
    .map(sanitize);
  result.codesign = sh("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  result.codesignInfo = sh("sh", ["-c", `codesign -dv "${appPath}" 2>&1 | grep -E "Identifier|flags|Signature|Sealed"`]).split("\n");
  result.codesignVerify = sh("sh", ["-c", `codesign --verify --deep --strict "${appPath}" 2>&1 && echo valid`]);
  result.urlTypes = sh("sh", ["-c", `plutil -extract CFBundleURLTypes json -o - "${appPath}/Contents/Info.plist"`]);
  result.launchServicesEntriesBefore = lsCount();
  rmSync(logDir, { recursive: true, force: true });
  const mains = () => processesMatching((c) => c === exe || c.startsWith(`${exe} `));
  const waitMains = async (n, ms) => {
    const end = Date.now() + ms;
    while (mains().length !== n && Date.now() < end) await sleep(200);
    return mains().length;
  };
  const quit = async () => {
    for (const p of mains()) process.kill(p.pid, "SIGTERM");
    return waitMains(0, 10000);
  };
  // Run once so macOS registers the scheme.
  sh("open", [appPath]);
  result.registerRun = { mains: await waitMains(1, 15000) };
  await sleep(2000);
  result.registerRun.afterQuit = await quit();
  result.launchServicesEntriesAfterFirstRun = lsCount();
  // (1) App not running.
  sh("open", ["wgspike://launch?id=x"]);
  await waitMains(1, 15000);
  await sleep(3000);
  result.case1NotRunning = { mains: mains().length };
  // (2a) App running with a window: the same URL again.
  sh("open", ["wgspike://launch?id=x"]);
  await sleep(3000);
  result.case2aRunningUrl = { mains: mains().length };
  // (2b) Second launch of the executable with --launch-game=x.
  let maxMains = mains().length;
  const second = spawn(exe, ["--launch-game=x"], { stdio: "ignore" });
  const secondExit = new Promise((r) => second.on("exit", (code, signal) => r({ code, signal })));
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    maxMains = Math.max(maxMains, mains().length);
    await sleep(100);
  }
  result.case2bSecondExecutable = {
    secondExit: await Promise.race([secondExit, sleep(5000).then(() => "still running")]),
    maxMainsObserved: maxMains,
    mainsAfter: mains().length,
  };
  result.afterQuit = await quit();
  result.events = existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
  // Cleanup: unregister the scheme from LaunchServices, delete the built app and its user data.
  result.cleanup = {
    lsregisterUnregister: sh(LSREGISTER, ["-u", appPath]) || "ok",
  };
  rmSync(join(ELECTRON_DIR, "dist"), { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  result.cleanup.launchServicesEntriesAfterCleanup = lsCount();
  result.cleanup.processesLeft = brief(processesMatching((c) => c.includes("wgspike.app")));
  checks.package = result;
}

function focusGuard(group) {
  const locked = screenLocked();
  if (locked && !opts["allow-locked"]) {
    checks[group] = { skipped: true, reason: "macOS screen locked: no window can be visible and focused" };
    log(`  skipped ${group}: screen locked`);
    return false;
  }
  return true;
}

async function groupPermissions() {
  if (!focusGuard("permissions")) return;
  checks.permissions = await runElectron("permissions", [], { timeoutMs: 300000 });
}

async function groupColdStart() {
  if (!focusGuard("coldstart")) return;
  const runs = [];
  for (let i = 1; i <= 3; i++) {
    const ud = mkdtempSync(join(TMP, `ud-cold-${i}-`));
    runs.push({ kind: "cold", ...(await runElectron("coldstart", [`--label=cold-${i}`], { userData: ud, spawnArg: true })) });
    await waitNoBundleProcesses(10000);
    runs.push({ kind: "warm", ...(await runElectron("coldstart", [`--label=warm-${i}`], { userData: ud, spawnArg: true })) });
    await waitNoBundleProcesses(10000);
  }
  checks.coldstart = { runs };
}

const frameStats = (record) => probeData(record)?.stats ?? null;

async function groupFrameTime() {
  if (!focusGuard("frametime")) return;
  let load = opts.load ? Number(opts.load) : null;
  const sweep = [];
  if (load === null) {
    // Provisional Electron-only calibration (uncapped): the H7 calibration proper is in Chrome (Task 6).
    for (const candidate of [64, 128, 256, 512, 1024, 2048]) {
      const run = await runElectron("frametime", ["--uncapped", `--load=${candidate}`, "--duration=4000", "--warmup=1000", `--label=calibration-${candidate}`]);
      const stats = frameStats(run);
      const hz = run.output?.result?.displayFrequency ?? 60;
      const ratio = stats?.p50Ms ? stats.p50Ms / (1000 / hz) : null;
      sweep.push({ load: candidate, p50Ms: stats?.p50Ms ?? null, ratioToVsync: ratio, record: run });
      if (ratio !== null && ratio >= 0.6) break;
    }
    const inBand = sweep.find((s) => s.ratioToVsync >= 0.6 && s.ratioToVsync <= 1.2);
    load = (inBand ?? sweep.at(-1)).load;
  }
  const runs = Number(opts["frame-runs"]);
  const modes = opts["frame-modes"].split(",");
  const cooldownMs = Number(opts.cooldown) * 1000;
  // Capped runs first, uncapped (H7b) after, each after a cooldown: uncapped runs leave seconds of
  // queued GPU work and heat behind, which degraded interleaved capped runs in an earlier run.
  const capped = [];
  const uncapped = [];
  if (modes.includes("capped")) {
    for (let i = 1; i <= runs; i++) {
      await sleep(cooldownMs);
      capped.push(await runElectron("frametime", [`--load=${load}`, `--label=h7-capped-${i}`]));
    }
  }
  if (modes.includes("uncapped")) {
    for (let i = 1; i <= runs; i++) {
      await sleep(cooldownMs);
      uncapped.push(await runElectron("frametime", ["--uncapped", `--load=${load}`, `--label=h7b-uncapped-${i}`]));
    }
  }
  checks.frametime = { load, calibrationSweep: sweep, capped, uncapped, modes, cooldownSeconds: Number(opts.cooldown) };
}

async function groupMemory() {
  if (!focusGuard("memory")) return;
  const load = checks.frametime?.load ?? (opts.load ? Number(opts.load) : 64);
  checks.memory = await runElectron("memory", ["--seconds=60", `--load=${load}`], { timeoutMs: 180000 });
}

const GROUP_FUNCTIONS = {
  storage: groupStorage,
  coi: groupCoi,
  gpu: groupGpu,
  sqlite: groupSqlite,
  playwright: groupPlaywright,
  h14: groupH14,
  h16: groupH16,
  package: groupPackage,
  permissions: groupPermissions,
  coldstart: groupColdStart,
  frametime: groupFrameTime,
  memory: groupMemory,
};

// ---- Evaluation (the coded form of HYPOTHESES.md verdict rules) --------------------------------

const res = (record) => record?.output?.result ?? null;

function evaluate() {
  const H = {};
  const notRun = (reason) => ({ status: "NOT_RUN", reason });

  // H1, H2, H2b
  if (checks.storage) {
    const h1 = res(checks.storage.h1);
    if (!h1 || checks.storage.h1.output?.error) {
      H.H1 = { status: "INVALID", reason: `h1-write failed: ${checks.storage.h1.output?.error ?? "no output"}` };
    } else {
      const leaks = h1.leaks.AtoB.length + h1.leaks.AtoBAfterBWrote.length + h1.leaks.BtoA.length;
      const metrics = {
        leakedKindsAtoB: h1.leaks.AtoB,
        leakedKindsAtoBAfterBWrote: h1.leaks.AtoBAfterBWrote,
        leakedKindsBtoA: h1.leaks.BtoA,
        ownA: h1.own.A.length,
        ownB: h1.own.B.length,
        controlSamePartition: h1.control.samePartitionSeesA.length,
      };
      if (metrics.controlSamePartition < 5) H.H1 = { status: "INVALID", reason: "control below 5 of 5", metrics };
      else if (leaks > 0) H.H1 = { status: "FAIL", reason: `${leaks} leaked kind(s)`, metrics };
      else if (metrics.ownA === 5 && metrics.ownB === 5)
        H.H1 = { status: "PASS", reason: "0 leaked kinds in both directions, each window sees its own 5, control 5 of 5", metrics };
      else H.H1 = { status: "INVALID", reason: "a window does not see its own 5 markers (probe broken)", metrics };
    }
    const h2 = res(checks.storage.h2);
    const remained = checks.storage.afterGracefulQuit.remaining.length;
    if (remained > 0) H.H2 = { status: "INVALID", reason: `${remained} process(es) remained after app.quit()` };
    else if (!h2) H.H2 = { status: "INVALID", reason: `h2-read failed: ${checks.storage.h2.output?.error}` };
    else {
      const metrics = { ownA: h2.own.A, ownB: h2.own.B, largeA: h2.large.A, largeB: h2.large.B, leaksAfterRestart: h2.leaksAfterRestart };
      const ok = h2.own.A.length === 5 && h2.own.B.length === 5 && h2.large.A && h2.large.B;
      H.H2 = ok
        ? { status: "PASS", reason: "all 5 kinds and both 1 MiB values (SHA-256 equal) present after graceful quit and relaunch; no process remained", metrics }
        : { status: "FAIL", reason: "something lost or altered after restart", metrics };
    }
    const b = res(checks.storage.h2b.read);
    H.H2b = b
      ? {
          status: "REPORTED",
          reason: `after SIGKILL ${checks.storage.h2b.killDelayMs} ms after the writes: survived ${b.survived.join(", ") || "nothing"}; 1 MiB blob ${b.largeSurvived.blob}, 1 MiB Uint8Array ${b.largeSurvived.u8}`,
          metrics: { survived: b.survived, largeSurvived: b.largeSurvived, leftoverAfterKill: checks.storage.h2b.afterKill.remaining.length },
        }
      : { status: "INVALID", reason: "h2b-read failed" };
  }

  // H3, H4
  if (checks.coi) {
    const coi = (r) => probeChecks(r)?.coi ?? null;
    const judge = (main, control, extra = {}) => {
      const m = coi(main);
      const c = coi(control);
      const metrics = { crossOriginIsolated: m?.crossOriginIsolated ?? null, roundTrip: m?.roundTrip ?? null, controlCrossOriginIsolated: c?.crossOriginIsolated ?? null, ...extra };
      if (!m || !c) return { status: "INVALID", reason: "probe result missing", metrics };
      if (c.crossOriginIsolated) return { status: "INVALID", reason: "control reported crossOriginIsolated true", metrics };
      if (m.crossOriginIsolated && m.roundTrip) return { status: "PASS", reason: "crossOriginIsolated true, SharedArrayBuffer Atomics round trip with a Worker works, control false", metrics };
      return { status: "FAIL", reason: "crossOriginIsolated false or no round trip on 45.0.0 (retry on 44.9.x required)", metrics };
    };
    H.H3 = judge(checks.coi.h3, checks.coi.h3Control);
    H.H4 = judge(checks.coi.h4, checks.coi.h4Control, {
      injectedResponses: res(checks.coi.h4)?.injected?.map((i) => `${i.resourceType} ${new URL(i.url).pathname}`) ?? [],
    });
  }

  // H5, H6
  if (checks.gpu) {
    const last = checks.gpu.runs.at(-1);
    const c = probeChecks(last);
    const w = c?.webgpu;
    const g = c?.webgl2;
    const gpuMetrics = { adapter: w?.adapter ?? null, featureCount: w?.featureCount ?? null, device: w?.device ?? null, computeReadbackCorrect: w?.computeReadbackCorrect ?? null };
    if (w?.adapter && w.device && w.computeReadbackCorrect)
      H.H5 = { status: "PASS", reason: "adapter, device and correct compute readback without any switch (feature count vs Chrome: H19, Task 6)", metrics: gpuMetrics };
    else {
      const u = probeChecks(checks.gpu.unsafeWebgpuRetry)?.webgpu;
      if (u?.adapter && u.device && u.computeReadbackCorrect)
        H.H5 = { status: "CONDITIONAL", reason: "works only with enable-unsafe-webgpu", metrics: { ...gpuMetrics, unsafe: u } };
      else H.H5 = { status: "NOT_RUN", reason: "no working adapter even with the switch; FAIL vs N/A needs Chrome H19 (Task 6)", metrics: { ...gpuMetrics, unsafe: u ?? null } };
    }
    const renderers = checks.gpu.runs.map((r) => probeChecks(r)?.webgl2?.renderer ?? null);
    H.H6 =
      g?.softwareRenderer === false
        ? { status: "PASS", reason: `hardware renderer: ${g.renderer}`, metrics: { renderers } }
        : { status: "INVALID", reason: `software or missing renderer after ${checks.gpu.runs.length} attempt(s)`, metrics: { renderers } };
  }

  // H7, H7b
  if (checks.frametime?.skipped) {
    H.H7 = { status: "INVALID", reason: `not measured: ${checks.frametime.reason}` };
  } else if (checks.frametime) {
    const summarize = (records) => {
      const rows = records.map((r) => {
        const d = probeData(r);
        const vis = r.output?.result?.probe?.result?.page?.visibility;
        return {
          file: r.output?.result?.probe?.file ?? null,
          p50Ms: d?.stats?.p50Ms ?? null,
          p95Ms: d?.stats?.p95Ms ?? null,
          longFrames: d?.stats?.longFrames ?? null,
          longFrameShare: d?.stats?.longFrameShare ?? null,
          count: d?.stats?.count ?? null,
          viewport: d?.viewport ?? null,
          renderer: d?.scene?.renderer ?? null,
          valid: !!d && vis?.everHidden === false && vis?.everUnfocused === false && d.scene?.softwareRenderer === false,
        };
      });
      const valid = rows.filter((x) => x.valid);
      return {
        runs: rows,
        validRuns: valid.length,
        medianP50Ms: median(valid.map((x) => x.p50Ms)),
        medianP95Ms: median(valid.map((x) => x.p95Ms)),
        medianLongFrames: median(valid.map((x) => x.longFrames)),
        medianLongFrameShare: median(valid.map((x) => x.longFrameShare)),
      };
    };
    const capped = summarize(checks.frametime.capped);
    const uncapped = summarize(checks.frametime.uncapped);
    const metrics = {
      load: checks.frametime.load,
      vsyncHz: res(checks.frametime.capped[0])?.displayFrequency ?? null,
      calibrationSweep: checks.frametime.calibrationSweep.map((s) => ({ load: s.load, p50Ms: s.p50Ms, ratioToVsync: s.ratioToVsync })),
      electronCapped: capped,
    };
    H.H7 =
      capped.validRuns < 3
        ? { status: "INVALID", reason: `only ${capped.validRuns} valid capped run(s) (hidden, unfocused or software)`, metrics }
        : { status: "NOT_RUN", reason: "Electron runs recorded; the verdict needs the calibrated Chrome baseline (H19) and alternating E,C runs (Task 6)", metrics };
    if (checks.frametime.uncapped.length)
      H.H7b = { status: "REPORTED", reason: "same scene with --disable-frame-rate-limit --disable-gpu-vsync", metrics: { electronUncapped: uncapped } };
  }

  // H8
  if (checks.coldstart?.skipped) H.H8 = { status: "INVALID", reason: `not measured: ${checks.coldstart.reason}` };
  else if (checks.coldstart) {
    const rows = checks.coldstart.runs.map((r) => {
      const d = probeData(r);
      const vis = r.output?.result?.probe?.result?.page?.visibility;
      const firstFrame = vis?.log?.find((e) => e.event === "first-frame");
      return {
        kind: r.kind,
        spawnToFirstFrameMs: d?.spawnToFirstFrameMs ?? null,
        focusedAtFirstFrame: firstFrame?.hasFocus ?? null,
        visibleAtFirstFrame: firstFrame ? firstFrame.visibilityState === "visible" : null,
      };
    });
    const valid = (kind) => rows.filter((x) => x.kind === kind && x.focusedAtFirstFrame && x.visibleAtFirstFrame);
    H.H8 = {
      status: "REPORTED",
      reason: "no threshold; runs not visible and focused at the first frame are excluded from the medians",
      metrics: {
        coldMedianMs: median(valid("cold").map((x) => x.spawnToFirstFrameMs)),
        warmMedianMs: median(valid("warm").map((x) => x.spawnToFirstFrameMs)),
        runs: rows,
      },
    };
  }

  // H9
  if (checks.memory?.skipped) H.H9 = { status: "INVALID", reason: `not measured: ${checks.memory.reason}` };
  else if (checks.memory) {
    const m = res(checks.memory);
    const valid = m && m.page.visibility.everHidden === false && m.page.visibility.everUnfocused === false;
    H.H9 = m
      ? {
          status: valid ? "REPORTED" : "INVALID",
          reason: valid
            ? "sum of workingSetSize over app.getAppMetrics() after 60 s of the scene (KiB -> MiB)"
            : "page was hidden or unfocused during the 60 s",
          metrics: { workingSetSumMiB: m.workingSetSumMiB, peakWorkingSetSumMiB: m.peakWorkingSetSumMiB, memoryFieldNames: m.memoryFieldNames, processes: m.processes, frames: m.page.frames },
        }
      : { status: "INVALID", reason: `memory run failed: ${checks.memory.output?.error}` };
  }

  // H10
  if (checks.sqlite) {
    const s = res(checks.sqlite);
    const ok = s?.main?.ok && s?.utility?.ok;
    H.H10 = {
      status: ok ? "PASS" : "FAIL",
      reason: ok
        ? `node:sqlite (SQLite ${s.main.versions.sqlite}) WAL, table, insert, select, user_version, reopen and zstd 1 MiB round trip work in main and utilityProcess; warnings: main ${s.main.warnings.length}, utility ${s.utility.warnings.length}`
        : "a step failed in main or utility process",
      metrics: { main: s?.main, utility: s?.utility },
    };
  }

  // H11
  if (checks.playwright) {
    const p = checks.playwright.h11;
    const metrics = {
      launch: p.ok,
      mainEvaluate: p.mainEvaluate ?? null,
      partitioningUnderPlaywright: p.partitioning?.partitioned ?? null,
      partitioningUnderPlaywrightWithRestore: checks.playwright.h11RestorePartitioning.partitioning?.partitioned ?? null,
      partitioningNormalLaunch: res(checks.playwright.normalLaunchPartitionCheck)?.partitioned ?? null,
      fallback: p.fallback ?? null,
    };
    if (p.ok) H.H11 = { status: "PASS", reason: "_electron.launch, firstWindow, click #play-step, evaluate in main and close work", metrics };
    else if (p.fallback?.ok) H.H11 = { status: "FALLBACK", reason: "only connectOverCDP works", metrics };
    else H.H11 = { status: "FAIL", reason: `neither works: ${p.error ?? ""}`.slice(0, 300), metrics };
  }

  // H12, H13
  if (checks.permissions?.skipped) {
    H.H12 = { status: "INVALID", reason: `not run: ${checks.permissions.reason}` };
    H.H13 = { status: "INVALID", reason: `not run: ${checks.permissions.reason}` };
  } else if (checks.permissions) {
    const p = res(checks.permissions);
    if (!p) {
      H.H12 = { status: "INVALID", reason: `permissions run failed: ${checks.permissions.output?.error}` };
      H.H13 = H.H12;
    } else {
      const logged = (perm, media) =>
        p.handlerLog.some((l) => l.handler === "request" && l.permission === perm && l.allowed === false && (!media || (l.mediaTypes ?? []).includes(media)));
      const deniedOk = {
        camera: !p.denied.camera.ok && /NotAllowedError/.test(p.denied.camera.error) && logged("media", "video"),
        microphone: !p.denied.microphone.ok && /NotAllowedError/.test(p.denied.microphone.error) && logged("media", "audio"),
        geolocation: !p.denied.geolocation.ok && /\(1\)/.test(p.denied.geolocation.error) && logged("geolocation"),
        notifications: p.denied.notifications.ok && p.denied.notifications.value === "denied" && logged("notifications"),
        displayCapture: !p.denied.displayCapture.ok && /NotAllowedError/.test(p.denied.displayCapture.error) && logged("display-capture"),
      };
      const allowedLogged = (perm) => p.handlerLog.some((l) => l.handler === "request" && l.permission === perm && l.allowed === true);
      const m = p.trusted.mouse;
      const allowedOk = {
        fullscreen: m.fullscreenOnly?.fullscreen?.ok === true && allowedLogged("fullscreen"),
        pointerLock: m.pointerLockOnly?.pointerLock?.ok === true && allowedLogged("pointerLock"),
        keyboardLock: m.keyboardLockOnly?.keyboardLock?.ok === true && allowedLogged("keyboardLock"),
      };
      const controlGranted = p.control?.result === "granted";
      const metrics12 = { focusAtStart: p.focusAtStart, deniedOk, allowedOk, controlGranted, outcomes: p.denied };
      if (!p.focusAtStart) H.H12 = { status: "INVALID", reason: "window never had focus (pointer lock cannot be tested)", metrics: metrics12 };
      else if (!controlGranted) H.H12 = { status: "INVALID", reason: "control did not resolve granted", metrics: metrics12 };
      else if (Object.values(deniedOk).every(Boolean) && Object.values(allowedOk).every(Boolean))
        H.H12 = { status: "PASS", reason: "five denied and logged, three allowed, control granted", metrics: metrics12 };
      else {
        const bad = [...Object.entries(deniedOk), ...Object.entries(allowedOk)].filter(([, ok]) => !ok).map(([k]) => k);
        H.H12 = { status: "FAIL", reason: `unexpected outcome for: ${bad.join(", ")}`, metrics: metrics12 };
      }
      const asSpec = m.asSpecified;
      const control = p.noGesture.asSpecified;
      const calls = ["fullscreen", "pointerLock", "keyboardLock"];
      const matrix = {};
      for (const [label, r] of Object.entries(p.noGesture)) matrix[`noGesture.${label}`] = Object.fromEntries((r.order ?? []).map((c) => [c, r[c].ok ? "ok" : r[c].error]));
      for (const [label, r] of Object.entries(m)) matrix[`mouse.${label}`] = Object.fromEntries((r.order ?? []).map((c) => [c, r[c].ok ? "ok" : r[c].error]));
      for (const [label, r] of Object.entries(p.trusted.key)) matrix[`key.${label}`] = Object.fromEntries((r.order ?? []).map((c) => [c, r[c]?.ok ? "ok" : r[c]?.error]));
      const metrics13 = { focusAtStart: p.focusAtStart, matrix, manualRealClick: "not performed (needs the owner at the machine)" };
      const controlAccepted = calls.filter((c) => control[c]?.ok);
      if (!p.focusAtStart) H.H13 = { status: "INVALID", reason: "window never had focus", metrics: metrics13 };
      else if (controlAccepted.length)
        H.H13 = { status: "INVALID", reason: `control not rejected without a gesture: ${controlAccepted.join(", ")} succeeded`, metrics: metrics13 };
      else if (calls.every((c) => asSpec[c]?.ok)) H.H13 = { status: "PASS", reason: "all three succeed after injected input and are rejected without it", metrics: metrics13 };
      else H.H13 = { status: "FAIL", reason: `after injected input: ${calls.filter((c) => !asSpec[c]?.ok).join(", ")} failed`, metrics: metrics13 };
    }
  }

  // H14
  if (checks.h14) {
    const r = res(checks.h14.record);
    if (!r) H.H14 = { status: "INVALID", reason: `h14 run failed: ${checks.h14.record.output?.error}` };
    else {
      const per = {};
      for (const [v, d] of Object.entries(r.variants)) {
        if (d.error) {
          per[v] = { status: "INVALID", reason: d.error.split("\n")[0] };
          continue;
        }
        const fixtureLines = checks.h14.fixtureRequestsDuringExportWindows[v]?.export ?? [];
        const gameRequests = fixtureLines.filter((l) => /\/(game|sw)\.js/.test(l));
        const problems = [];
        if (!d.export.quiescence.clean) problems.push(`export: ${d.export.quiescence.problems.join("; ")}`);
        if (!d.restore.quiescence.clean) problems.push(`restore: ${d.restore.quiescence.problems.join("; ")}`);
        if (!d.negativeImport.quiescence.clean) problems.push(`negative restore: ${d.negativeImport.quiescence.problems.join("; ")}`);
        if (gameRequests.length) problems.push(`fixture saw ${gameRequests.join(", ")}`);
        if (v === "c" && !r.partitioning.partitioned) problems.push("storage partitioning is off (variant c tests nothing)");
        const metrics = {
          Hs: d.Hs,
          Hd: d.Hd,
          Hneg: d.Hneg,
          HsMatchesReference7: d.HsMatchesReference,
          fixtureRequestsDuringExport: fixtureLines.length,
          storageKeys: d.export.storageKeys,
          exporterVia: d.export.exporterVia,
        };
        if (!d.negativeDiffers) per[v] = { status: "INVALID", reason: "negative control did not differ", metrics };
        else if (v === "b" && d.bypassControl?.quiescence?.clean !== false)
          per[v] = { status: "INVALID", reason: "canary insensitive: no-bypass control looked clean", metrics };
        else if (problems.length) per[v] = { status: "FAIL", reason: problems.join(" | "), metrics };
        else if (!d.equal) per[v] = { status: "FAIL", reason: "Hd differs from Hs", metrics };
        else if (v === "c" && !d.topLevelDiffers) per[v] = { status: "FAIL", reason: "top-level 127.0.0.1 shows the iframe data", metrics };
        else per[v] = { status: "PASS", reason: "Hd equals Hs, negative control differs, no game code ran in the quiescent windows", metrics };
      }
      const statuses = Object.values(per).map((x) => x.status);
      const missing = ["a", "b", "c", "d"].filter((v) => !per[v]);
      const status = missing.length
        ? "INVALID"
        : statuses.includes("FAIL")
          ? "FAIL"
          : statuses.includes("INVALID")
            ? "INVALID"
            : "PASS";
      H.H14 = {
        status,
        reason: missing.length ? `variants not run: ${missing.join(",")}` : `a ${per.a.status}, b ${per.b.status}, c ${per.c.status}, d ${per.d.status}`,
        metrics: {
          variants: per,
          reference: r.reference,
          partitioningNormalLaunch: r.partitioning.partitioned,
          autoIncrementAfterRestore: r.variants.a?.autoIncrement ?? null,
          wipeProbes: r.variants.c?.wipeProbes ?? null,
          bypassControl: r.variants.b?.bypassControl?.quiescence?.problems ?? null,
          fixtureDuringBypassControl: checks.h14.fixtureRequestsDuringExportWindows.b?.bypassControl ?? null,
        },
      };
    }
  }

  // H15
  if (checks.package) {
    const p = checks.package;
    const ev = p.events;
    const startPids = new Set(ev.filter((e) => e.event === "start" && e.gotLock).map((e) => e.pid));
    const openUrls = ev.filter((e) => e.event === "open-url");
    const seconds = ev.filter((e) => e.event === "second-instance");
    const metrics = {
      case1NotRunning: { mains: p.case1NotRunning.mains, openUrlIds: openUrls.map((e) => e.id) },
      case2aRunningUrl: { mains: p.case2aRunningUrl.mains },
      case2bSecondExecutable: { ...p.case2bSecondExecutable, secondInstanceIds: seconds.map((e) => e.id) },
      lockHolders: startPids.size,
      codesign: p.codesignInfo,
    };
    const ok =
      p.case1NotRunning.mains === 1 &&
      p.case2aRunningUrl.mains === 1 &&
      p.case2bSecondExecutable.mainsAfter === 1 &&
      openUrls.length >= 2 &&
      openUrls.every((e) => e.id === "x") &&
      seconds.length >= 1 &&
      seconds.every((e) => e.id === "x");
    H.H15 = ok
      ? { status: "PASS", reason: "one main process in every case; id x via open-url (cases 1, 2a) and second-instance (case 2b)", metrics }
      : { status: "FAIL", reason: "a second instance or a missing id", metrics };
  }

  // H16
  if (checks.h16) {
    const r = res(checks.h16.record);
    const s = checks.h16.snapshots;
    if (!r) H.H16 = { status: "INVALID", reason: `h16 failed: ${checks.h16.record.output?.error}` };
    else {
      const metrics = {
        rendererAliveAfterClose5s: r.rendererAliveAfterClose5s,
        rendererExitAfterCloseMs: r.rendererExitAfterCloseMs,
        serviceWorkersStoppedAfterCloseMs: r.serviceWorkersStoppedAfterCloseMs,
        workersRunningAtClose5s: r.workersRunningAtClose5s,
        windowsAfterClose: r.windowsAfterClose,
        windowsAfterExport: r.windowsAfterExport,
        processesBeforeLaunch: s.beforeLaunch.length,
        processesGameOpen: s.gameOpen?.length ?? null,
        processesGameClosed5s: s.gameClosed5s?.length ?? null,
        processesAppQuit5s: s.appQuit5s.length,
      };
      const problems = [];
      if (r.rendererAliveAfterClose5s) problems.push(`renderer of the closed window alive 5 s after close (exited after ${r.rendererExitAfterCloseMs} ms, when its service worker stopped)`);
      if (r.windowsAfterClose !== 0 || r.windowsAfterExport !== 0) problems.push("window count not back to baseline");
      if (s.appQuit5s.length) problems.push(`${s.appQuit5s.length} process(es) left 5 s after quit`);
      H.H16 = problems.length ? { status: "FAIL", reason: problems.join("; "), metrics } : { status: "PASS", reason: "renderer gone, windows at baseline, nothing left after quit", metrics };
    }
  }

  const order = ["H1", "H2", "H2b", "H3", "H4", "H5", "H6", "H7", "H7b", "H8", "H9", "H10", "H11", "H12", "H13", "H14", "H15", "H16"];
  const sorted = {};
  for (const id of order) {
    if (H[id]) sorted[id] = H[id];
    else if (!["H2b", "H7b"].includes(id)) sorted[id] = notRun("group not selected in this invocation");
  }
  return sorted;
}

// ---- Main ----------------------------------------------------------------------------------------

const startedAt = iso();
const machine = machineInfo();
log(`runtime-compat spike: electron at ${sanitize(BUNDLE)}; groups: ${groups.join(" ")}`);
log(`machine: ${machine.osVersion}, ${machine.cpu}, ${machine.gpu}, ${machine.power}, screen locked: ${machine.screenLockedAtStart}`);
fixture = startServer("fixture", join(REPO, "fixtures/test-games/progress-lab/server.mjs"));
const spikeServer = startServer("spike", join(ROOT, "server.mjs"));
let fatal = null;
try {
  await Promise.all([fixture.listening, spikeServer.listening]);
  const leftoverAtStart = bundleProcesses();
  if (leftoverAtStart.length) throw new Error(`Electron processes already running from the spike bundle: ${leftoverAtStart.length}`);
  // Versions and display data, recorded once per invocation whatever the groups.
  checks.env = await runElectron("env");
  for (const group of groups) {
    log(`group ${group}`);
    try {
      await GROUP_FUNCTIONS[group]();
    } catch (error) {
      checks[group] = { error: sanitize(String(error?.stack ?? error)) };
      log(`  group ${group} ERROR ${error.message}`);
    }
    await waitNoBundleProcesses(15000);
  }
} catch (error) {
  fatal = String(error?.stack ?? error);
  log(`FATAL ${fatal}`);
} finally {
  fixture.stop();
  spikeServer.stop();
}
await sleep(500);

const anyOutput = (() => {
  const stack = [checks];
  while (stack.length) {
    const x = stack.pop();
    if (x && typeof x === "object") {
      if (x.output?.environment) return x.output.environment;
      stack.push(...Object.values(x));
    }
  }
  return null;
})();
// Prefer the env launch for versions; GPU feature status is only meaningful after a window rendered.
const environment = checks.env?.output?.environment ?? anyOutput;
machine.displayRefreshHz = environment?.display?.displayFrequency ?? null;
const hypotheses = evaluate();
// pgrep output of other apps on the machine is not ours to publish: keep spike lines, count the rest.
const pgrepLines = (pattern) =>
  sh("sh", ["-c", `pgrep -fl ${pattern} || true`])
    .split("\n")
    .filter(Boolean);
const ours = (line) => line.includes(ROOT) || line.includes("wgspike");
const leftoverProcesses = {
  bundle: brief(bundleProcesses()),
  pgrepElectronSpike: pgrepLines("Electron").filter(ours).map(sanitize),
  pgrepElectronOtherAppsCount: pgrepLines("Electron").filter((l) => !ours(l)).length,
  pgrepWgspike: pgrepLines("wgspike").map(sanitize),
};
const probeFiles = spikeServer.lines.map((l) => /^RESULT (\S+)/.exec(l.line)?.[1]).filter(Boolean);

// Frame deltas live in the probe files; keep the aggregate small.
const strip = (value) => {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "deltasMs") continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
};

const version = environment?.versions?.electron ?? "unknown";
const aggregate = {
  schemaVersion: 1,
  kind: "run",
  createdAt: iso(),
  runtime: {
    name: "electron",
    version,
    chromium: environment?.versions?.chrome ?? null,
    node: environment?.versions?.node ?? null,
  },
  label: `node run.mjs --runtime=electron ${process.argv.slice(3).join(" ")}`.trim(),
  machine,
  startedAt,
  finishedAt: iso(),
  groups,
  fatal,
  environment,
  hypotheses,
  launches,
  checks: strip(checks),
  probeFiles,
  leftoverProcesses,
};
mkdirSync(join(ROOT, "results"), { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, ".$1Z");
const outFile = join(ROOT, "results", `electron-${version}-${stamp}.json`);
writeFileSync(outFile, `${sanitize(JSON.stringify(aggregate, null, 2))}\n`);

const validate = makeValidator();
const toValidate = [outFile, ...probeFiles.map((f) => join(ROOT, f))];
let invalid = 0;
for (const file of toValidate) {
  const error = validate(JSON.parse(readFileSync(file, "utf8")));
  if (error) {
    invalid++;
    log(`schema INVALID ${file.slice(ROOT.length + 1)}: ${error}`);
  }
}
log(`schema: ${toValidate.length - invalid} of ${toValidate.length} result files valid`);
console.log("\nHypothesis  Status        Reason");
for (const [id, h] of Object.entries(hypotheses)) {
  console.log(`${id.padEnd(11)} ${h.status.padEnd(13)} ${h.reason}`);
}
console.log(`\nresults: ${outFile.slice(ROOT.length + 1)}`);
console.log(`leftover processes from the spike bundle: ${leftoverProcesses.bundle.length}`);
if (!opts["keep-temp"]) rmSync(TMP, { recursive: true, force: true });
process.exit(invalid || fatal ? 1 : 0);
