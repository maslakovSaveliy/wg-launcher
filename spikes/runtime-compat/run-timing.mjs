// THROWAWAY spike runner (runtime-compat, Task 6): the hands-off measurements.
//
//   node run-timing.mjs [--only=calibrate,h7,h8,h9,demos,h7b] [--load=<n>] [--runs=3] [--cooldown=30]
//                       [--allow-battery] [--smoke]
//
// Needs the machine idle: window visible, unobscured and in the foreground, nobody touching keyboard or
// trackpad, display awake (this runner holds `caffeinate -d -i`), power connected. Every timing run
// records visibility/focus, HID idle time and power, and is INVALID (retried at most twice) when the page
// was hidden or unfocused, the renderer was software, the viewport was not 1280x720 CSS px at DPR 2, or
// input arrived during the run. --smoke shortens every duration and writes into a scratch directory
// (wiring check only; its numbers mean nothing).
//
// Groups (run in this order; capped runs always come before uncapped ones, with cooldowns between):
//   calibrate  H7 calibration: Chrome with vsync and frame limit off; load whose p50 is 60-120% of vsync
//   h7         Electron (E), Chrome via Playwright (C), Chrome --app (A); runs alternate E, C, A, E, C, A, ...
//   h8         spawn to first frame, 3 cold + 3 warm launches each of Electron and Chrome
//   h9         memory after 60 s of the scene, Electron and Chrome, same external definition for both
//   demos      the six public demos (H21) in Electron and Chrome, rAF sampler, indicative only
//   h7b        uncapped runs of the same scene in Electron and Chrome (reported)

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { demoConfig } from "./groups/demos.mjs";
import { runDemoChrome, runDemoElectron } from "./groups/demo-lib.mjs";
import {
  ROOT,
  cdpConnect,
  chromeVersion,
  createRun,
  devToolsPort,
  electronEnvironment,
  hidIdleSeconds,
  iso,
  jsonFetch,
  killProcessesWithin,
  launchElectron,
  launchPlaywrightBrowser,
  log,
  machineInfo,
  median,
  memoryOfTree,
  onBattery,
  processList,
  processesMatching,
  screenLocked,
  sizeWindowByCdp,
  sleep,
  spawnChrome,
  validateFiles,
  writeAggregate,
} from "./common.mjs";

const ALL = ["calibrate", "h7", "h8", "h9", "demos", "h7b"];
const { values: opts } = parseArgs({
  options: {
    only: { type: "string" },
    skip: { type: "string" },
    load: { type: "string" },
    runs: { type: "string", default: "3" },
    cooldown: { type: "string", default: "30" },
    "fixture-port": { type: "string", default: "4417" },
    "spike-port": { type: "string", default: "4418" },
    "allow-battery": { type: "boolean", default: false },
    smoke: { type: "boolean", default: false },
    "keep-temp": { type: "boolean", default: false },
  },
  strict: true,
});
const groups = (opts.only ? opts.only.split(",") : ALL).filter((g) => !(opts.skip ?? "").split(",").includes(g));
for (const g of groups) {
  if (!ALL.includes(g)) {
    console.error(`unknown group ${g}; groups: ${ALL.join(" ")}`);
    process.exit(2);
  }
}
const SMOKE = opts.smoke;
const WIDTH = 1280;
const HEIGHT = 720;
const DURATION = SMOKE ? 2000 : 20000;
const WARMUP = SMOKE ? 500 : 2000;
const COOLDOWN_MS = SMOKE ? 1000 : Number(opts.cooldown) * 1000;
const MEMORY_SECONDS = SMOKE ? 3 : 60;
const RUNS = Number(opts.runs);

if (!SMOKE && screenLocked()) {
  console.error("The macOS screen is locked: no window can be visible and focused. Unlock it and rerun.");
  process.exit(2);
}
if (!SMOKE && onBattery() && !opts["allow-battery"]) {
  console.error("The machine is on battery power. Connect the charger (the hands-off rule) or pass --allow-battery.");
  process.exit(2);
}

const scratch = SMOKE ? mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "wgspike-smoke-")) : null;
const run = createRun({ fixturePort: Number(opts["fixture-port"]), spikePort: Number(opts["spike-port"]), resultsDir: scratch ? join(scratch, "results") : null });
const startedAt = iso();
const machine = machineInfo();
const CHROME_VERSION = chromeVersion();
let caffeinate = null;
const children = new Set();

function cleanupAndExit(code) {
  caffeinate?.kill("SIGTERM");
  run.stopServers();
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => cleanupAndExit(130));

// ---- Run bookkeeping ---------------------------------------------------------------------------

/** Wraps one measured launch with HID-idle and power bookkeeping. */
async function measured(fn) {
  const idleStart = hidIdleSeconds();
  const t0 = Date.now();
  const value = await fn();
  const seconds = (Date.now() - t0) / 1000;
  const idleEnd = hidIdleSeconds();
  // The HID idle time counts up from the last input; if it is below the run's length, input arrived during it.
  const inputDuringRun = idleEnd !== null && idleEnd < seconds - 0.5;
  return { value, seconds, hid: { idleSecondsAtStart: idleStart === null ? null : Math.round(idleStart), idleSecondsAtEnd: idleEnd === null ? null : Math.round(idleEnd), inputDuringRun }, power: onBattery() ? "battery" : "ac" };
}

function validity(payload, { load, expectedBuffer = [2560, 1440] }) {
  const reasons = [];
  const d = payload?.data;
  const v = payload?.page?.visibility;
  if (!d || !v) return ["no payload"];
  if (v.everHidden) reasons.push("page was hidden");
  if (v.everUnfocused) reasons.push("page lost focus");
  if (d.scene.softwareRenderer !== false) reasons.push(`renderer not hardware: ${d.scene.renderer}`);
  if (d.viewport.innerWidth !== WIDTH || d.viewport.innerHeight !== HEIGHT) reasons.push(`viewport ${d.viewport.innerWidth}x${d.viewport.innerHeight}`);
  if (d.scene.drawingBufferWidth !== expectedBuffer[0] || d.scene.drawingBufferHeight !== expectedBuffer[1]) reasons.push(`drawing buffer ${d.scene.drawingBufferWidth}x${d.scene.drawingBufferHeight}`);
  if (load !== undefined && d.settings.load !== load) reasons.push(`load ${d.settings.load}`);
  return reasons;
}

const statsOf = (row) => row.payload?.data?.stats ?? null;

function rowOf(runtime, label, outcome, extra = {}) {
  const payload = outcome.value.payload ?? null;
  const reasons = [...validity(payload, { load: extra.load }), ...(outcome.hid.inputDuringRun ? ["keyboard or trackpad input during the run"] : []), ...(outcome.power === "battery" ? ["on battery power"] : [])];
  return {
    runtime,
    label,
    file: outcome.value.file ?? null,
    seconds: Math.round(outcome.seconds * 10) / 10,
    hid: outcome.hid,
    power: outcome.power,
    valid: reasons.length === 0 && !!payload,
    invalidReasons: reasons,
    stats: payload?.data?.stats ?? null,
    viewport: payload?.data?.viewport ?? null,
    scene: payload ? { renderer: payload.data.scene.renderer, softwareRenderer: payload.data.scene.softwareRenderer, load: payload.data.settings.load, drawingBuffer: [payload.data.scene.drawingBufferWidth, payload.data.scene.drawingBufferHeight], dpr: payload.data.scene.devicePixelRatio } : null,
    visibility: payload ? { everHidden: payload.page.visibility.everHidden, everUnfocused: payload.page.visibility.everUnfocused } : null,
    vsyncHz: payload?.data?.vsync?.hostReportedHz ?? null,
    ...extra,
    payload: undefined,
  };
}

// ---- One frame-time launch per runtime -------------------------------------------------------

const hz = () => machine.displayRefreshHz;

async function electronFrame({ load, uncapped = false, duration = DURATION, warmup = WARMUP, label }) {
  const extra = [`--load=${load}`, `--duration=${duration}`, `--warmup=${warmup}`, `--label=${label}`];
  if (uncapped) extra.push("--uncapped");
  const launch = await launchElectron(run, "frametime", extra, { timeoutMs: (duration + warmup) * 4 + 240000 });
  const probe = launch.output?.result?.probe;
  return { payload: probe?.result ?? null, file: probe?.file ?? null, error: launch.output?.error ?? null };
}

async function waitPage(page, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await page.evaluate("window.wgProbe ? { state: wgProbe.state, error: wgProbe.error } : null").catch(() => null);
    if (s && (s.state === "posted" || s.state === "error")) return s;
    await sleep(250);
  }
  return { state: "timeout" };
}

async function chromeFrame({ load, uncapped = false, duration = DURATION, warmup = WARMUP, label }) {
  const browser = await launchPlaywrightBrowser({ channel: "chrome", uncapped, width: WIDTH, height: HEIGHT });
  try {
    const mark = run.mark();
    const url = run.spikeUrl("/", { mode: "frametime", runtime: "chrome", version: browser.version, load, duration, warmup, vsyncHz: hz(), label });
    await browser.page.goto(url);
    const state = await waitPage(browser.page, (duration + warmup) * 4 + 120000);
    if (state.state !== "posted") return { payload: null, file: null, error: `probe state ${state.state} ${state.error ?? ""}` };
    const posted = await run.waitResult(mark, { timeoutMs: 10000 });
    return { payload: posted.data, file: posted.file, error: null };
  } finally {
    await browser.close();
  }
}

async function waitNoProfileProcesses(dir, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && processesMatching((c) => c.includes(dir)).length) await sleep(200);
  return processesMatching((c) => c.includes(dir)).length;
}

async function chromeAppFrame({ load, uncapped = false, duration = DURATION, warmup = WARMUP, label }) {
  const dir = mkdtempSync(join(run.tmp, "chrome-app-profile-"));
  const extraArgs = uncapped ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : [];
  const spawned = spawnChrome({ url: run.spikeUrl("/storage.html", {}, { token: false }), userDataDir: dir, app: true, cdp: true, extraArgs });
  children.add(spawned.child);
  try {
    const port = await devToolsPort(dir);
    const version = await jsonFetch(`http://127.0.0.1:${port}/json/version`);
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      target = (await jsonFetch(`http://127.0.0.1:${port}/json/list`)).find((t) => t.type === "page" && t.url.includes("/storage.html"));
      if (!target) await sleep(100);
    }
    const page = await cdpConnect(target.webSocketDebuggerUrl);
    const sizing = await sizeWindowByCdp((m, p) => page.send(m, p), (e) => page.evaluate(e), WIDTH, HEIGHT);
    await page.send("Page.bringToFront");
    await sleep(300);
    const mark = run.mark();
    const chromeVer = /Chrome\/(\S+)/.exec(version.Browser)?.[1] ?? chromeVersion();
    const url = run.spikeUrl("/", { mode: "frametime", runtime: "chrome-app", version: chromeVer, load, duration, warmup, vsyncHz: hz(), label });
    await page.send("Page.navigate", { url });
    const end = Date.now() + (duration + warmup) * 4 + 120000;
    let state = { state: "timeout" };
    while (Date.now() < end) {
      const s = await page.evaluate("window.wgProbe ? { state: wgProbe.state, error: wgProbe.error } : null").catch(() => null);
      if (s && (s.state === "posted" || s.state === "error")) {
        state = s;
        break;
      }
      await sleep(250);
    }
    const out = { payload: null, file: null, error: null, sizing };
    if (state.state === "posted") {
      const posted = await run.waitResult(mark, { timeoutMs: 10000 });
      out.payload = posted.data;
      out.file = posted.file;
    } else out.error = `probe state ${state.state} ${state.error ?? ""}`;
    const browser = await cdpConnect(version.webSocketDebuggerUrl);
    await browser.send("Browser.close").catch(() => {});
    browser.close();
    page.close();
    return out;
  } finally {
    await waitNoProfileProcesses(dir);
    children.delete(spawned.child);
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUNNERS = { electron: electronFrame, chrome: chromeFrame, "chrome-app": chromeAppFrame };

/** One slot: run, validate, retry an invalid run at most twice; every attempt is recorded. */
async function slot(runtime, label, params) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const outcome = await measured(() => RUNNERS[runtime]({ ...params, label: `${label}-try${attempt}` }));
    const row = rowOf(runtime, `${label}-try${attempt}`, outcome, { load: params.load, uncapped: !!params.uncapped, attempt });
    if (outcome.value.error) row.invalidReasons.push(`run error: ${outcome.value.error}`);
    if (outcome.value.error) row.valid = false;
    attempts.push(row);
    log(`  ${runtime} ${label} try ${attempt}: ${row.valid ? "valid" : `INVALID (${row.invalidReasons.join("; ")})`}${row.stats ? ` p50 ${row.stats.p50Ms?.toFixed(2)} p95 ${row.stats.p95Ms?.toFixed(2)} long ${row.stats.longFrames}` : ""}`);
    if (row.valid) break;
    await sleep(COOLDOWN_MS);
  }
  return { final: attempts.find((a) => a.valid) ?? null, attempts };
}

const summary = (rows) => {
  const valid = rows.filter((r) => r.valid);
  const p95 = valid.map((r) => r.stats.p95Ms);
  const m95 = median(p95);
  return {
    validRuns: valid.length,
    medianP50Ms: median(valid.map((r) => r.stats.p50Ms)),
    medianP95Ms: m95,
    medianLongFrames: median(valid.map((r) => r.stats.longFrames)),
    medianLongFrameShare: median(valid.map((r) => r.stats.longFrameShare)),
    p95Ms: p95,
    p95Spread: valid.length > 1 && m95 ? (Math.max(...p95) - Math.min(...p95)) / m95 : null,
  };
};

// ---- Groups ------------------------------------------------------------------------------------

const results = { checks: {}, hypotheses: {} };
let load = opts.load ? Number(opts.load) : null;

async function groupCalibrate() {
  // R17: Chrome with frame limit and vsync off; p50 must be 60-120% of the vsync interval. Start at the
  // load Task 5 chose in Electron (512) and move one step up or down the ladder until inside the band.
  const ladder = [64, 128, 256, 384, 512, 768, 1024, 2048];
  const vsyncMs = 1000 / hz();
  let index = ladder.indexOf(512);
  const sweep = [];
  let direction = 0;
  for (let step = 0; step < 6; step++) {
    const candidate = ladder[index];
    const outcome = await measured(() => chromeFrame({ load: candidate, uncapped: true, duration: SMOKE ? 1500 : 4000, warmup: SMOKE ? 300 : 1000, label: `calibration-${candidate}` }));
    const stats = outcome.value.payload?.data?.stats;
    const ratio = stats?.p50Ms ? stats.p50Ms / vsyncMs : null;
    sweep.push({ load: candidate, p50Ms: stats?.p50Ms ?? null, p95Ms: stats?.p95Ms ?? null, ratioToVsync: ratio, file: outcome.value.file, renderer: outcome.value.payload?.data?.scene?.renderer ?? null, hid: outcome.hid });
    log(`  calibration load ${candidate}: p50 ${stats?.p50Ms?.toFixed(2)} ms = ${ratio ? (ratio * 100).toFixed(0) : "?"}% of vsync`);
    await sleep(COOLDOWN_MS * 2); // uncapped runs leave GPU backlog and heat behind
    if (ratio === null) break;
    if (ratio >= 0.6 && ratio <= 1.2) {
      load = candidate;
      break;
    }
    const next = ratio < 0.6 ? 1 : -1;
    if (direction !== 0 && next !== direction) break; // crossed the band without landing in it
    direction = next;
    index += next;
    if (index < 0 || index >= ladder.length) break;
  }
  results.checks.calibration = { vsyncMs, sweep, chosenLoad: load, band: "60% to 120% of the vsync interval, Chrome uncapped (H7b conditions)", startedFrom: 512 };
  results.hypotheses.H7calibration = load
    ? { status: "REPORTED", reason: `load ${load}: Chrome uncapped p50 ${sweep.find((s) => s.load === load)?.p50Ms?.toFixed(2)} ms = ${(sweep.find((s) => s.load === load).ratioToVsync * 100).toFixed(0)}% of vsync (${vsyncMs.toFixed(2)} ms), inside the 60-120% band` }
    : { status: "N/A", reason: "no load in the 60-120% band was found in Chrome; H7 stays undecided and the owner decides (INCONCLUSIVE rule)" };
}

async function groupH7() {
  if (!load) {
    results.hypotheses.H7 = { status: "N/A", reason: "no calibrated load (see H7calibration)" };
    return;
  }
  const order = ["electron", "chrome", "chrome-app"];
  const slots = { electron: [], chrome: [], "chrome-app": [] };
  async function rounds(from, to) {
    for (let i = from; i <= to; i++) {
      for (const runtime of order) {
        await sleep(COOLDOWN_MS);
        slots[runtime].push(await slot(runtime, `h7-${runtime}-${i}`, { load }));
      }
    }
  }
  await rounds(1, RUNS);
  const finals = (rt) => slots[rt].map((s) => s.final).filter(Boolean);
  let chromeSummary = summary(finals("chrome"));
  let extra = false;
  if (chromeSummary.p95Spread !== null && chromeSummary.p95Spread >= 0.15 && !SMOKE) {
    log(`  Chrome p95 spread ${(chromeSummary.p95Spread * 100).toFixed(1)}% >= 15%: rerun with 5 runs each`);
    extra = true;
    await rounds(RUNS + 1, 5);
    chromeSummary = summary(finals("chrome"));
  }
  const electronSummary = summary(finals("electron"));
  const appSummary = summary(finals("chrome-app"));
  const verdictOf = (name, s) => {
    if (s.validRuns < Math.min(RUNS, 3) || chromeSummary.validRuns < Math.min(RUNS, 3)) return { status: "INVALID", reason: `${name} ${s.validRuns} valid run(s), Chrome ${chromeSummary.validRuns}: not enough valid runs (persistent INVALID: the owner decides)` };
    if (chromeSummary.p95Spread !== null && chromeSummary.p95Spread >= 0.15) return { status: "INCONCLUSIVE", reason: `Chrome p95 spread ${(chromeSummary.p95Spread * 100).toFixed(1)}% >= 15%${extra ? " also with 5 runs each" : " (rerun with 5 runs each required)"}: no verdict, the owner decides (decision rule 5)` };
    const limit = chromeSummary.medianP95Ms * 1.15;
    const ratio = s.medianP95Ms / chromeSummary.medianP95Ms;
    return s.medianP95Ms <= limit
      ? { status: "PASS", reason: `${name} p95 ${s.medianP95Ms.toFixed(2)} ms <= Chrome p95 ${chromeSummary.medianP95Ms.toFixed(2)} ms x 1.15 = ${limit.toFixed(2)} ms (ratio ${ratio.toFixed(3)})` }
      : { status: "FAIL", reason: `${name} p95 ${s.medianP95Ms.toFixed(2)} ms > Chrome p95 ${chromeSummary.medianP95Ms.toFixed(2)} ms x 1.15 = ${limit.toFixed(2)} ms (ratio ${ratio.toFixed(3)})` };
  };
  const metrics = { load, vsyncHz: hz(), electron: electronSummary, chrome: chromeSummary, chromeApp: appSummary, chromeVersion: CHROME_VERSION, versionMismatch: "Chrome major is compared with Electron 45's Chromium 156; see HYPOTHESES section 2" };
  results.hypotheses.H7 = { ...verdictOf("Electron", electronSummary), metrics };
  results.hypotheses["H20-6"] = { ...verdictOf("Chrome --app", appSummary), metrics: { chromeApp: appSummary, chrome: chromeSummary, load } };
  results.checks.h7 = { order: "E, C, A alternating (Electron, Chrome via Playwright, Chrome --app)", rounds: extra ? 5 : RUNS, slots };
}

async function groupH7b() {
  if (!load) {
    results.hypotheses.H7b = { status: "N/A", reason: "no calibrated load" };
    return;
  }
  const slots = { electron: [], chrome: [] };
  for (let i = 1; i <= RUNS; i++) {
    for (const runtime of ["electron", "chrome"]) {
      await sleep(COOLDOWN_MS * 2);
      slots[runtime].push(await slot(runtime, `h7b-${runtime}-${i}`, { load, uncapped: true }));
    }
  }
  const finals = (rt) => slots[rt].map((s) => s.final).filter(Boolean);
  results.hypotheses.H7b = { status: "REPORTED", reason: "uncapped (--disable-frame-rate-limit --disable-gpu-vsync) throughput, not presentation; no threshold", metrics: { load, electron: summary(finals("electron")), chrome: summary(finals("chrome")) } };
  results.checks.h7b = { slots };
}

// -- H8 -------------------------------------------------------------------------------------------

function coldRow(runtime, kind, payload, spawnMs, file) {
  const d = payload?.data;
  const first = payload?.page?.visibility?.log?.find((e) => e.event === "first-frame");
  const reasons = [];
  if (!d) reasons.push("no payload");
  else if (d.scene.softwareRenderer !== false) reasons.push("software renderer");
  if (first && (!first.hasFocus || first.visibilityState !== "visible")) reasons.push("not visible and focused at the first frame");
  if (!first) reasons.push("no first-frame entry");
  return { runtime, kind, file, spawnToFirstFrameMs: d?.spawnToFirstFrameMs ?? null, focusedAtFirstFrame: first?.hasFocus ?? null, visibleAtFirstFrame: first ? first.visibilityState === "visible" : null, viewport: d ? { cssWidth: d.scene.cssWidth, cssHeight: d.scene.cssHeight, dpr: d.scene.devicePixelRatio } : null, valid: reasons.length === 0, invalidReasons: reasons, spawnMs };
}

async function chromeColdLaunch(dir, label) {
  const mark = run.mark();
  const spawnMs = Date.now(); // taken right before spawn(); nothing slow between the two
  const url = run.spikeUrl("/", { mode: "coldstart", runtime: "chrome", version: CHROME_VERSION, load: load ?? 512, spawn: spawnMs, label });
  const spawned = spawnChrome({ url, userDataDir: dir, app: false, cdp: false, windowSize: [WIDTH, 807] });
  children.add(spawned.child);
  let posted = null;
  try {
    posted = await run.waitResult(mark, { timeoutMs: 60000 });
  } catch {}
  spawned.child.kill("SIGTERM");
  await waitNoProfileProcesses(dir, 20000);
  children.delete(spawned.child);
  return { payload: posted?.data ?? null, file: posted?.file ?? null, spawnMs };
}

async function groupH8() {
  const rows = [];
  const loadForScene = load ?? 512;
  for (let i = 1; i <= 3; i++) {
    for (const runtime of ["electron", "chrome"]) {
      const dir = mkdtempSync(join(run.tmp, `h8-${runtime}-${i}-`));
      for (const kind of ["cold", "warm"]) {
        let row = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          let outcome;
          if (runtime === "electron") {
            const launch = await launchElectron(run, "coldstart", [`--label=${kind}-${i}`, `--load=${loadForScene}`], { userData: dir, spawnArg: true, timeoutMs: 120000 });
            const probe = launch.output?.result?.probe;
            outcome = { payload: probe?.result ?? null, file: probe?.file ?? null, spawnMs: launch.spawnMs };
            await sleep(1500);
          } else outcome = await chromeColdLaunch(dir, `${kind}-${i}`);
          row = coldRow(runtime, kind, outcome.payload, outcome.spawnMs, outcome.file);
          row.attempt = attempt;
          log(`  ${runtime} ${kind} ${i}: ${row.valid ? `${row.spawnToFirstFrameMs} ms` : `INVALID (${row.invalidReasons.join("; ")})`}`);
          if (row.valid) break;
          if (kind === "cold") rmSync(dir, { recursive: true, force: true }); // a retried cold launch needs an empty profile
          await sleep(2000);
        }
        rows.push(row);
        // Cold launches start with an empty profile; warm is the immediate relaunch with the same one.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const med = (rt, kind) => median(rows.filter((r) => r.runtime === rt && r.kind === kind && r.valid).map((r) => r.spawnToFirstFrameMs));
  results.hypotheses.H8 = {
    status: "REPORTED",
    reason: `no threshold. Spawn to first presented frame, median ms: Electron cold ${med("electron", "cold")}, warm ${med("electron", "warm")}; Chrome cold ${med("chrome", "cold")}, warm ${med("chrome", "warm")} (cold = empty profile, the OS file cache is not flushed)`,
    metrics: { medians: { electronCold: med("electron", "cold"), electronWarm: med("electron", "warm"), chromeCold: med("chrome", "cold"), chromeWarm: med("chrome", "warm") }, load: loadForScene },
  };
  results.checks.h8 = { rows, chromeLaunch: "installed Chrome spawned directly with --user-data-dir, --no-first-run and the URL as a normal window sized 1280x807 (1280x720 viewport); Electron: electron/main.mjs --mode=coldstart" };
}

// -- H9 -------------------------------------------------------------------------------------------

async function electronMemory(label) {
  let external = null;
  const launch = await launchElectron(run, "memory", [`--seconds=${MEMORY_SECONDS}`, `--load=${load ?? 512}`, "--memory-hold-ms=2500"], {
    timeoutMs: (MEMORY_SECONDS + 60) * 1000,
    onEvent: (event) => {
      if (event.type === "memory-ready") external = memoryOfTree(event.pid);
    },
  });
  const r = launch.output?.result;
  const v = r?.page?.visibility;
  const reasons = [];
  if (!r) reasons.push(`no result: ${launch.output?.error?.split("\n")[0] ?? "?"}`);
  else {
    if (v.everHidden) reasons.push("page was hidden");
    if (v.everUnfocused) reasons.push("page lost focus");
  }
  return { runtime: "electron", label, valid: reasons.length === 0, invalidReasons: reasons, inProcess: r ? { workingSetSumMiB: r.workingSetSumMiB, peakWorkingSetSumMiB: r.peakWorkingSetSumMiB, processes: r.processes.length, frames: r.page.frames } : null, external };
}

async function chromeMemory(label) {
  const browser = await launchPlaywrightBrowser({ channel: "chrome", width: WIDTH, height: HEIGHT });
  try {
    await browser.page.goto(run.spikeUrl("/", { mode: "scene", runtime: "chrome", version: browser.version, load: load ?? 512 }));
    await browser.page.waitForFunction("window.wgProbe && wgProbe.state === 'rendering'", null, { timeout: 30000 });
    await sleep(MEMORY_SECONDS * 1000);
    const list = processList();
    const main = list.find((p) => p.command.includes("Google Chrome") && p.command.includes("--remote-debugging-pipe") && !p.command.includes("--type="));
    const external = main ? memoryOfTree(main.pid) : null;
    const page = await browser.page.evaluate("({ frames: wgProbe.frames, visibility: wgProbe.visibility, hidden: document.visibilityState, focus: document.hasFocus() })");
    const reasons = [];
    if (!main) reasons.push("Chrome main process not found");
    if (page.visibility.everHidden) reasons.push("page was hidden");
    if (page.visibility.everUnfocused) reasons.push("page lost focus");
    return { runtime: "chrome", label, valid: reasons.length === 0, invalidReasons: reasons, inProcess: { frames: page.frames }, external };
  } finally {
    await browser.close();
  }
}

async function groupH9() {
  const rows = [];
  for (let i = 1; i <= 2; i++) {
    for (const [runtime, fn] of [["electron", electronMemory], ["chrome", chromeMemory]]) {
      let row;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const outcome = await measured(() => fn(`h9-${runtime}-${i}`));
        row = { ...outcome.value, attempt, hid: outcome.hid, power: outcome.power };
        if (outcome.hid.inputDuringRun) {
          row.valid = false;
          row.invalidReasons.push("keyboard or trackpad input during the run");
        }
        log(`  memory ${runtime} ${i}: ${row.valid ? `external rss ${row.external?.rssMiB?.toFixed(0)} MiB, footprint ${row.external?.footprintMiB?.toFixed(0)} MiB` : `INVALID (${row.invalidReasons.join("; ")})`}`);
        if (row.valid) break;
        await sleep(COOLDOWN_MS);
      }
      rows.push(row);
      await sleep(COOLDOWN_MS);
    }
  }
  const med = (rt, field) => median(rows.filter((r) => r.runtime === rt && r.valid && r.external).map((r) => r.external[field]));
  results.hypotheses.H9 = rows.some((r) => r.valid)
    ? {
        status: "REPORTED",
        reason: `no threshold, no percentage claim (definitions differ). After ${MEMORY_SECONDS} s of the scene, process tree summed from outside with the same tools for both: resident (ps rss) / phys footprint (macOS footprint), median MiB: Electron ${med("electron", "rssMiB")?.toFixed(0)} / ${med("electron", "footprintMiB")?.toFixed(0)}; Chrome ${med("chrome", "rssMiB")?.toFixed(0)} / ${med("chrome", "footprintMiB")?.toFixed(0)}`,
        metrics: { electronRssMiB: med("electron", "rssMiB"), electronFootprintMiB: med("electron", "footprintMiB"), chromeRssMiB: med("chrome", "rssMiB"), chromeFootprintMiB: med("chrome", "footprintMiB"), load: load ?? 512 },
      }
    : { status: "INVALID", reason: "no valid memory run (page hidden or unfocused, or input during the run)" };
  results.checks.h9 = { rows, method: "Electron also reports app.getAppMetrics() workingSetSize; Chrome's Task Manager footprint (a manual step in H9) is replaced by the macOS footprint tool over the process tree, which is the same definition applied to both runtimes" };
}

// -- Demos ----------------------------------------------------------------------------------------

async function groupDemos() {
  const config = demoConfig();
  const settings = { settleMs: SMOKE ? 1500 : config.settleMs, warmupMs: WARMUP, durationMs: DURATION, vsyncHz: hz() };
  const rows = [];
  for (const demo of SMOKE ? config.demos.slice(0, 1) : config.demos) {
    for (const [name, fn] of [["electron", runDemoElectron], ["chrome", runDemoChrome]]) {
      await sleep(SMOKE ? 500 : 10000);
      const outcome = await measured(() => fn(run, demo, settings));
      const row = outcome.value;
      row.hid = outcome.hid;
      row.power = outcome.power;
      row.validForTiming = !!row.stats && row.visibility?.everHidden === false && row.visibility?.everUnfocused === false && !outcome.hid.inputDuringRun;
      rows.push(row);
      log(`  ${demo.id} in ${name}: ${row.stats ? `p50 ${row.stats.p50Ms.toFixed(2)} p95 ${row.stats.p95Ms.toFixed(2)} long ${row.stats.longFrames} valid ${row.validForTiming}` : `no samples (${row.loadError ?? "?"})`}`);
    }
  }
  results.hypotheses.H21 = { status: "REPORTED", reason: "indicative only: external pages are not calibrated and run their own load; same sampler and window size in both runtimes", metrics: { demos: rows.map((r) => ({ id: r.id, runtime: r.runtime, loaded: r.loadOk, p50Ms: r.stats?.p50Ms ?? null, p95Ms: r.stats?.p95Ms ?? null, longFrames: r.stats?.longFrames ?? null, valid: r.validForTiming })) } };
  results.checks.demos = { settings: { ...settings, viewport: `${WIDTH}x${HEIGHT}` }, rows };
}

const RUN_GROUP = { calibrate: groupCalibrate, h7: groupH7, h8: groupH8, h9: groupH9, demos: groupDemos, h7b: groupH7b };

// ---- Main ----------------------------------------------------------------------------------------

let fatal = null;
try {
  caffeinate = spawn("caffeinate", ["-d", "-i"], { stdio: "ignore" }); // keeps the display awake
  await run.startServers();
  const env = await electronEnvironment(run);
  machine.displayRefreshHz = env?.display?.displayFrequency ?? null;
  results.environment = { electron: env?.versions ?? null, displayFrequency: machine.displayRefreshHz, chrome: chromeVersion() };
  log(`run-timing${SMOKE ? " (SMOKE: numbers mean nothing)" : ""}: groups ${groups.join(" ")}; display ${machine.displayRefreshHz} Hz; HID idle ${Math.round(hidIdleSeconds() ?? -1)} s; ${onBattery() ? "BATTERY" : "AC"}`);
  for (const name of ["calibrate", "h7", "h8", "h9", "demos", "h7b"]) {
    if (!groups.includes(name)) continue;
    log(`group ${name}`);
    if (name !== "calibrate" && !load && ["h7", "h7b", "h8", "h9"].includes(name)) {
      load = 512;
      log("  no calibration in this invocation: using the load of the Task 5 Electron sweep (512), recorded as uncalibrated");
      results.checks.calibration ??= { chosenLoad: 512, note: "not calibrated in this invocation" };
    }
    try {
      await RUN_GROUP[name]();
    } catch (error) {
      log(`  group ${name} ERROR ${error.stack}`);
      results.checks[`${name}Error`] = run.sanitize(String(error.stack ?? error));
    }
    await sleep(500);
  }
} catch (error) {
  fatal = String(error.stack ?? error);
  log(`FATAL ${fatal}`);
} finally {
  caffeinate?.kill("SIGTERM");
  run.stopServers();
  for (const child of children) child.kill("SIGTERM");
}

// The schema's hypothesis keys are H<n>; the calibration is reported inside H7's metrics and as a check.
const calibration = results.hypotheses.H7calibration;
delete results.hypotheses.H7calibration;
if (calibration) results.checks.calibrationOutcome = calibration;
const leaked = await killProcessesWithin(run.tmp);
if (leaked) log(`WARNING: ${leaked} process(es) of this run could not be stopped`);
const processes = processesMatching((c) => c.includes(run.tmp));
const written = writeAggregate(run, {
  runtime: { name: "timing", version: `electron-${results.environment?.electron?.electron ?? "unknown"}_chrome-${chromeVersion()}`, chromium: null },
  label: `${SMOKE ? "SMOKE (wiring check, no meaning) " : ""}hands-off timing: ${groups.join(", ")}`,
  machine,
  startedAt,
  groups,
  hypotheses: results.hypotheses,
  checks: results.checks,
  probeFiles: [],
  leftoverProcesses: { processesWithTempDirInCommand: processes.length },
  extra: { fatal, environment: results.environment },
});
console.log(`\nwritten: ${written.rel}${written.schemaError ? ` SCHEMA INVALID: ${written.schemaError}` : ""}`);
for (const [id, h] of Object.entries(results.hypotheses)) console.log(`${id.padEnd(8)} ${h.status.padEnd(13)} ${h.reason}`);
if (calibration) console.log(`${"H7cal".padEnd(8)} ${calibration.status.padEnd(13)} ${calibration.reason}`);
if (!opts["keep-temp"]) rmSync(run.tmp, { recursive: true, force: true });
if (scratch && !opts["keep-temp"]) console.log(`(smoke results are in the scratch directory ${scratch}; delete it when done)`);
process.exit(fatal ? 1 : 0);
