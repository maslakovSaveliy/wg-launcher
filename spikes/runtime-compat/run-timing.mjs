// THROWAWAY spike runner (runtime-compat, Task 6): the hands-off measurements.
//
//   node run-timing.mjs [--only=calibrate,h7,h8,h9,demos,h7b] [--load=<n>] [--runs=3] [--cooldown=30]   (default: all but h7b)
//                       [--min-idle=30] [--allow-battery] [--smoke]
//
// Needs the machine idle: window visible, unobscured and in the foreground, nobody touching keyboard or
// trackpad, display awake (this runner holds `caffeinate -d -i -w <its pid>`), power connected, Do Not Disturb
// on (a reminder is printed; the runner cannot set it). Before the first run and before every group it waits
// for at least --min-idle seconds without keyboard or trackpad input (it aborts after 5 minutes of waiting).
// Every timing run records visibility/focus, HID idle time, power and `pmset -g therm`, and is INVALID
// (retried at most twice) when the page was hidden or unfocused, the renderer was software, the viewport was not
// 1280x720 CSS px at DPR 2, input arrived during the run, the machine ran on battery or reported a thermal limit.
// A launch that throws or times out is recorded as a failed attempt (it never drops the earlier valid runs), a
// partial aggregate is rewritten after every slot, and SIGINT, SIGTERM, SIGHUP and uncaught errors clean up.
// --smoke shortens every duration and writes into a scratch directory (wiring check only; numbers mean nothing).
//
// Groups, in this order. The calibration sweep is itself uncapped (the H7b conditions), so it runs first and
// is followed by a cooldown; after it all capped measurement runs (h7, h8, h9, demos) come before the uncapped
// h7b runs, because uncapped runs leave seconds of queued GPU work and heat behind:
//   calibrate  H7 calibration: Chrome with vsync and frame limit off, 2 s warm-up + 20 s measured (H7b
//              conditions); load whose p50 is 60-120% of the vsync interval. Only a load found here counts as
//              calibrated; without one, H7, H20-6 and H7b are N/A (or INVALID with a load given by --load).
//   h7         Electron (E), Chrome via Playwright (C), Chrome --app (A); runs alternate E, C, A, E, C, A, ...
//   h8         spawn to first frame, 3 cold + 3 warm launches each of Electron and Chrome (default load 512)
//   h9         memory after 60 s of the scene, one run each for Electron and Chrome (owner-approved), same external definition
//   demos      the six public demos (H21), one 20 s run per demo per runtime in Electron and Chrome, indicative only
//   h7b        optional, not planned: uncapped runs of the same scene in Electron and Chrome (reported); post-checks the
//              calibration (without it the calibration run itself, made under the H7b conditions, is the only check)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDemoChrome, runDemoElectron } from "./groups/demo-lib.mjs";
import { demoConfig } from "./groups/demos.mjs";
import {
  aggregatePath,
  cdpConnect,
  chromeVersion,
  createRun,
  devToolsPort,
  electronEnvironment,
  hidIdleSeconds,
  iso,
  jsonFetch,
  killProcessesWithin,
  killProcessesWithinSync,
  launchElectron,
  launchPlaywrightBrowser,
  log,
  machineInfo,
  median,
  memoryOfTree,
  onBattery,
  portListeners,
  processList,
  processesMatching,
  screenLocked,
  sizeWindowByCdp,
  sleep,
  spawnChrome,
  thermalStatus,
  topCpu,
  writeAggregate,
} from "./common.mjs";
import { LOAD_LADDER, applyPostCheck, calibrationStep, environmentReasons as realEnvironmentReasons, h7Verdict, postCheck, ratioToVsync, runSlot, summary, validity } from "./timing-logic.mjs";

const ALL = ["calibrate", "h7", "h8", "h9", "demos", "h7b"];
// h7b (uncapped runs) is optional and not planned (owner decision): it runs only when asked for with --only=...,h7b.
const DEFAULT_GROUPS = ["calibrate", "h7", "h8", "h9", "demos"];
const { values: opts } = parseArgs({
  options: {
    only: { type: "string" },
    skip: { type: "string" },
    load: { type: "string" },
    runs: { type: "string", default: "3" },
    cooldown: { type: "string", default: "30" },
    "min-idle": { type: "string", default: "30" },
    "fixture-port": { type: "string", default: "4417" },
    "spike-port": { type: "string", default: "4418" },
    "allow-battery": { type: "boolean", default: false },
    smoke: { type: "boolean", default: false },
    "smoke-ignore-environment": { type: "boolean", default: false },
    "keep-temp": { type: "boolean", default: false },
  },
  strict: true,
});
const groups = ALL.filter((g) => (opts.only ? opts.only.split(",").includes(g) : DEFAULT_GROUPS.includes(g)) && !(opts.skip ?? "").split(",").includes(g));
for (const g of [...(opts.only ? opts.only.split(",") : []), ...(opts.skip ? opts.skip.split(",") : [])]) {
  if (!ALL.includes(g)) {
    console.error(`unknown group ${g}; groups: ${ALL.join(" ")}`);
    process.exit(2);
  }
}
const SMOKE = opts.smoke;
// Wiring checks only: lets a smoke run take the valid-run paths while someone uses the machine or it is on battery.
const IGNORE_ENV = SMOKE && opts["smoke-ignore-environment"];
if (opts["smoke-ignore-environment"] && !SMOKE) {
  console.error("--smoke-ignore-environment only works together with --smoke");
  process.exit(2);
}
const WIDTH = 1280;
const HEIGHT = 720;
const DURATION = SMOKE ? 2000 : 20000;
const WARMUP = SMOKE ? 500 : 2000;
const COOLDOWN_MS = SMOKE ? 1000 : Number(opts.cooldown) * 1000;
const MEMORY_SECONDS = SMOKE ? 3 : 60;
const RUNS = Number(opts.runs);
const MIN_IDLE_S = SMOKE ? 0 : Number(opts["min-idle"]);
const IDLE_WAIT_LIMIT_S = 300;
const CHROME_UI_HEIGHT = 87; // outerHeight - innerHeight of a normal Chrome window, measured in the Playwright baseline
const FIXTURE_PORT = Number(opts["fixture-port"]);
const SPIKE_PORT = Number(opts["spike-port"]);

const environmentReasons = (outcome) => (IGNORE_ENV ? [] : realEnvironmentReasons(outcome));

// ---- Preflight ---------------------------------------------------------------------------------

if (!SMOKE && screenLocked()) {
  console.error("The macOS screen is locked: no window can be visible and focused. Unlock it and rerun.");
  process.exit(2);
}
if (!SMOKE && onBattery() && !opts["allow-battery"]) {
  console.error("The machine is on battery power. Connect the charger (the hands-off rule) or pass --allow-battery.");
  process.exit(2);
}
for (const port of [FIXTURE_PORT, SPIKE_PORT]) {
  const busy = portListeners(port);
  if (busy.length) {
    console.error(`Port ${port} is already in use by ${busy.map((b) => `${b.command} (pid ${b.pid})`).join(", ")}. A previous runner may have been killed hard; stop that process (for example \`kill ${busy[0].pid}\`) and rerun.`);
    process.exit(2);
  }
}

const scratch = SMOKE ? mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "wgspike-smoke-")) : null;
const run = createRun({ fixturePort: FIXTURE_PORT, spikePort: SPIKE_PORT, resultsDir: scratch ? join(scratch, "results") : null });
const startedAt = iso();
const machine = machineInfo();
const CHROME_VERSION = chromeVersion();
const children = new Set();
let caffeinate = null;

// ---- Run state, checkpoints and cleanup ------------------------------------------------------------

const state = {
  checks: {},
  hypotheses: {},
  environment: null,
  completedGroups: [],
  load: opts.load ? Number(opts.load) : null,
  calibrated: false,
  calibrationNote: opts.load ? `load ${opts.load} was given on the command line without calibrating in this invocation` : "the calibrate group was not run in this invocation",
  loadSource: opts.load ? "command line" : null,
  fatal: null,
};
let timingFile = null;

/** (Re)writes the aggregate; the same path is reused so a long run leaves one file, `partial` until the end. */
function checkpoint(note, final = false) {
  const runtime = { name: "timing", version: `electron-${state.environment?.electron?.electron ?? "unknown"}_chrome-${CHROME_VERSION}`, chromium: null };
  timingFile ??= aggregatePath(run, runtime);
  const written = writeAggregate(run, {
    runtime,
    label: `${SMOKE ? "SMOKE (wiring check, no meaning) " : ""}hands-off timing: ${groups.join(", ")}`,
    machine,
    startedAt,
    groups,
    hypotheses: state.hypotheses,
    checks: state.checks,
    probeFiles: [],
    leftoverProcesses: { processesWithTempDirInCommand: final ? processesMatching((c) => c.includes(run.tmp)).length : null },
    extra: { fatal: state.fatal, environment: state.environment, partial: !final, completedGroups: state.completedGroups, checkpointNote: note },
    fixedFile: timingFile,
  });
  return written;
}

let cleaning = false;
function emergencyExit(code, why) {
  if (cleaning) return;
  cleaning = true;
  console.error(`\nABORT (${why}): writing a partial result and cleaning up`);
  state.fatal = `aborted: ${why}`;
  try {
    checkpoint(`aborted: ${why}`);
  } catch (error) {
    console.error(`could not write the partial result: ${error.message}`);
  }
  caffeinate?.kill("SIGTERM");
  run.stopServers();
  for (const child of children) child.kill("SIGKILL");
  killProcessesWithinSync(run.tmp);
  if (!opts["keep-temp"]) rmSync(run.tmp, { recursive: true, force: true });
  process.exit(code);
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => emergencyExit(code, signal));
process.on("uncaughtException", (error) => {
  console.error(error);
  emergencyExit(1, `uncaughtException: ${error.message}`);
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  emergencyExit(1, `unhandledRejection: ${error?.message ?? error}`);
});

// ---- Owner-time safeguards ------------------------------------------------------------------------

/** Waits until the keyboard and trackpad have been idle for MIN_IDLE_S; aborts after IDLE_WAIT_LIMIT_S. */
async function waitForIdle(what) {
  if (MIN_IDLE_S <= 0) return;
  const started = Date.now();
  let announced = false;
  for (;;) {
    const idle = hidIdleSeconds();
    if (idle === null || idle >= MIN_IDLE_S) return;
    if (!announced) log(`  waiting for ${MIN_IDLE_S} s without keyboard or trackpad input before ${what} (idle ${Math.round(idle)} s now)`);
    announced = true;
    if ((Date.now() - started) / 1000 > IDLE_WAIT_LIMIT_S) {
      throw new Error(`the machine was not idle for ${MIN_IDLE_S} s within ${IDLE_WAIT_LIMIT_S} s before ${what}: someone is using it; aborting so no run is taken on a busy machine`);
    }
    await sleep(2000);
  }
}

/** Wraps one measured launch with HID idle, power and thermal bookkeeping; an exception becomes `{ error }`. */
async function measured(fn) {
  const idleStart = hidIdleSeconds();
  const t0 = Date.now();
  let value;
  try {
    value = await fn();
  } catch (error) {
    value = { payload: null, file: null, error: `threw: ${String(error?.message ?? error).slice(0, 300)}` };
  }
  const seconds = (Date.now() - t0) / 1000;
  const idleEnd = hidIdleSeconds();
  // HID idle counts up from the last input; below the run's length means input arrived during it.
  const inputDuringRun = idleEnd !== null && idleEnd < seconds - 0.5;
  return {
    value,
    seconds,
    hid: { idleSecondsAtStart: idleStart === null ? null : Math.round(idleStart), idleSecondsAtEnd: idleEnd === null ? null : Math.round(idleEnd), inputDuringRun },
    power: onBattery() ? "battery" : "ac",
    therm: thermalStatus(),
  };
}

const hz = () => machine.displayRefreshHz;

function rowOf(runtime, label, outcome, extra = {}) {
  const payload = outcome.value.payload ?? null;
  const reasons = [...validity(payload, { load: extra.load, width: WIDTH, height: HEIGHT }), ...environmentReasons(outcome)];
  if (outcome.value.error) reasons.push(`run error: ${outcome.value.error}`);
  return {
    runtime,
    label,
    file: outcome.value.file ?? null,
    seconds: Math.round(outcome.seconds * 10) / 10,
    hid: outcome.hid,
    power: outcome.power,
    therm: { cpuSpeedLimit: outcome.therm.cpuSpeedLimit, warningRecorded: outcome.therm.warningRecorded },
    valid: reasons.length === 0 && !!payload,
    invalidReasons: reasons,
    stats: payload?.data?.stats ?? null,
    viewport: payload?.data?.viewport ?? null,
    scene: payload ? { renderer: payload.data.scene.renderer, softwareRenderer: payload.data.scene.softwareRenderer, load: payload.data.settings.load, drawingBuffer: [payload.data.scene.drawingBufferWidth, payload.data.scene.drawingBufferHeight], dpr: payload.data.scene.devicePixelRatio } : null,
    visibility: payload ? { everHidden: payload.page.visibility.everHidden, everUnfocused: payload.page.visibility.everUnfocused } : null,
    vsyncHz: payload?.data?.vsync?.hostReportedHz ?? null,
    ...extra,
  };
}

// ---- One frame-time launch per runtime -------------------------------------------------------

async function electronFrame({ load, uncapped = false, duration = DURATION, warmup = WARMUP, label }) {
  const extra = [`--load=${load}`, `--duration=${duration}`, `--warmup=${warmup}`, `--label=${label}`];
  if (uncapped) extra.push("--uncapped");
  const launch = await launchElectron(run, "frametime", extra, { timeoutMs: (duration + warmup) * 4 + 240000 });
  const probe = launch.output?.result?.probe;
  return { payload: probe?.result ?? null, file: probe?.file ?? null, error: launch.output?.error ?? (probe ? null : `no probe result (exit ${launch.exit.code ?? launch.exit.signal})`) };
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
    const waitState = await waitPage(browser.page, (duration + warmup) * 4 + 120000);
    if (waitState.state !== "posted") return { payload: null, file: null, error: `probe state ${waitState.state} ${waitState.error ?? ""}` };
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
  let page = null;
  let version = null;
  try {
    const port = await devToolsPort(dir);
    version = await jsonFetch(`http://127.0.0.1:${port}/json/version`);
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      target = (await jsonFetch(`http://127.0.0.1:${port}/json/list`)).find((t) => t.type === "page" && t.url.includes("/storage.html"));
      if (!target) await sleep(100);
    }
    if (!target) throw new Error("Chrome --app page target did not appear within 10 s");
    page = await cdpConnect(target.webSocketDebuggerUrl);
    const sizing = await sizeWindowByCdp((m, p) => page.send(m, p), (e) => page.evaluate(e), WIDTH, HEIGHT);
    await page.send("Page.bringToFront");
    await sleep(300);
    const mark = run.mark();
    const chromeVer = /Chrome\/(\S+)/.exec(version.Browser)?.[1] ?? CHROME_VERSION;
    const url = run.spikeUrl("/", { mode: "frametime", runtime: "chrome-app", version: chromeVer, load, duration, warmup, vsyncHz: hz(), label });
    await page.send("Page.navigate", { url });
    const end = Date.now() + (duration + warmup) * 4 + 120000;
    let probeState = { state: "timeout" };
    while (Date.now() < end) {
      const s = await page.evaluate("window.wgProbe ? { state: wgProbe.state, error: wgProbe.error } : null").catch(() => null);
      if (s && (s.state === "posted" || s.state === "error")) {
        probeState = s;
        break;
      }
      await sleep(250);
    }
    const out = { payload: null, file: null, error: null, sizing };
    if (probeState.state === "posted") {
      const posted = await run.waitResult(mark, { timeoutMs: 10000 });
      out.payload = posted.data;
      out.file = posted.file;
    } else out.error = `probe state ${probeState.state} ${probeState.error ?? ""}`;
    return out;
  } finally {
    try {
      if (version?.webSocketDebuggerUrl) {
        const browser = await cdpConnect(version.webSocketDebuggerUrl);
        await browser.send("Browser.close").catch(() => {});
        browser.close();
      }
    } catch {}
    page?.close();
    if ((await waitNoProfileProcesses(dir)) > 0) spawned.child.kill("SIGKILL");
    await waitNoProfileProcesses(dir, 5000);
    children.delete(spawned.child);
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUNNERS = { electron: electronFrame, chrome: chromeFrame, "chrome-app": chromeAppFrame };

/** One slot of frame-time runs (see runSlot): every attempt is recorded, a failed launch is a recorded attempt. */
function slot(runtime, label, params, { cooldownMs = COOLDOWN_MS } = {}) {
  return runSlot({
    attemptFn: async (attempt) => {
      const outcome = await measured(() => RUNNERS[runtime]({ ...params, label: `${label}-try${attempt}` }));
      return rowOf(runtime, `${label}-try${attempt}`, outcome, { load: params.load, uncapped: !!params.uncapped });
    },
    cooldown: () => sleep(cooldownMs),
    log: (row, attempt) =>
      log(`  ${runtime} ${label} try ${attempt}: ${row.valid ? "valid" : `INVALID (${row.invalidReasons.join("; ")})`}${row.stats ? ` p50 ${row.stats.p50Ms?.toFixed(2)} p95 ${row.stats.p95Ms?.toFixed(2)} long ${row.stats.longFrames}` : ""}`),
  });
}

// ---- Groups ------------------------------------------------------------------------------------

async function groupCalibrate() {
  // R17: Chrome with frame limit and vsync off; p50 must be 60-120% of the vsync interval. Start at the load
  // Task 5 chose in Electron (512, or --load) and move one step up or down the ladder until inside the band.
  // The windows are those of H7b (2 s warm-up, 20 s measured); each candidate gets up to 3 valid-run attempts.
  const vsyncMs = 1000 / hz();
  let index = Math.max(0, LOAD_LADDER.indexOf(state.load ?? 512));
  let direction = 0;
  const sweep = [];
  let stopReason = "step limit";
  for (let step = 0; step < 6; step++) {
    const candidate = LOAD_LADDER[index];
    const result = await slot("chrome", `calibration-${candidate}`, { load: candidate, uncapped: true }, { cooldownMs: COOLDOWN_MS * 2 });
    const row = result.final;
    const ratio = row ? ratioToVsync(row.stats.p50Ms, hz()) : null;
    sweep.push({ load: candidate, valid: !!row, p50Ms: row?.stats.p50Ms ?? null, p95Ms: row?.stats.p95Ms ?? null, ratioToVsync: ratio, attempts: result.attempts });
    state.checks.calibration = { vsyncMs, band: "60% to 120% of the vsync interval, Chrome uncapped, 2 s warm-up and 20 s measured (H7b conditions)", sweep };
    checkpoint(`calibration load ${candidate}`);
    log(`  calibration load ${candidate}: ${row ? `p50 ${row.stats.p50Ms.toFixed(2)} ms = ${(ratio * 100).toFixed(0)}% of vsync` : "no valid run"}`);
    await sleep(COOLDOWN_MS * 2); // uncapped runs leave GPU backlog and heat behind
    const decision = calibrationStep({ ratio, index, direction });
    if (decision.action === "accept") {
      state.load = candidate;
      state.calibrated = true;
      state.loadSource = "calibrated in Chrome (uncapped) in this invocation";
      state.calibrationNote = `load ${candidate} calibrated in this invocation`;
      stopReason = "in band";
      break;
    }
    if (decision.action === "stop") {
      stopReason = decision.reason;
      break;
    }
    index = decision.index;
    direction = decision.direction;
  }
  state.checks.calibration = { ...state.checks.calibration, chosenLoad: state.calibrated ? state.load : null, stopReason };
  if (!state.calibrated) {
    state.load = null;
    state.calibrationNote = `no load in the 60-120% band was found (${stopReason}); H7 is N/A and the owner decides (R17)`;
  }
  state.checks.calibrationOutcome = state.calibrated
    ? { status: "REPORTED", reason: `load ${state.load}: Chrome uncapped p50 inside the 60-120% band` }
    : { status: "N/A", reason: state.calibrationNote };
}

async function groupH7() {
  if (!state.load) {
    const na = { status: "N/A", reason: `no calibrated load: ${state.calibrationNote}. Run the calibrate group first` };
    state.hypotheses.H7 = na;
    state.hypotheses["H20-6"] = na;
    return;
  }
  const order = ["electron", "chrome", "chrome-app"];
  const passes = [];
  state.checks.h7 = { order: "E, C, A alternating (Electron, Chrome via Playwright, Chrome --app)", load: state.load, calibrated: state.calibrated, passes };
  async function pass(runsWanted, tag) {
    const slots = { electron: [], chrome: [], "chrome-app": [] };
    passes.push({ tag, runsWanted, slots });
    for (let i = 1; i <= runsWanted; i++) {
      for (const runtime of order) {
        await sleep(COOLDOWN_MS);
        slots[runtime].push(await slot(runtime, `h7-${tag}-${runtime}-${i}`, { load: state.load }));
        checkpoint(`h7 ${tag} ${runtime} ${i}`);
      }
    }
    const finals = (rt) => slots[rt].map((s) => s.final).filter(Boolean);
    return { electron: summary(finals("electron")), chrome: summary(finals("chrome")), chromeApp: summary(finals("chrome-app")) };
  }
  const verdicts = (s, runsWanted, rerun) => ({
    H7: h7Verdict({ name: "Electron", kind: "electron", s: s.electron, chrome: s.chrome, runsWanted, rerun, calibrated: state.calibrated, calibrationNote: state.calibrationNote }),
    "H20-6": h7Verdict({ name: "Chrome --app", kind: "chrome-app", s: s.chromeApp, chrome: s.chrome, runsWanted, rerun, calibrated: state.calibrated, calibrationNote: state.calibrationNote }),
  });
  let runsWanted = RUNS;
  let summaries = await pass(runsWanted, "a");
  let v = verdicts(summaries, runsWanted, false);
  if (v.H7.needsRerun && !SMOKE) {
    // Interpretation: "rerun both runtimes with 5 runs each" is read as five fresh runs per runtime; the verdict
    // comes from them and the first pass stays in the file as evidence.
    log(`  Chrome p95 spread ${(summaries.chrome.p95Spread * 100).toFixed(1)}% >= 15%: rerun with 5 fresh runs each`);
    runsWanted = 5;
    summaries = await pass(runsWanted, "rerun5");
    v = verdicts(summaries, runsWanted, true);
  }
  state.hypotheses.H7 = { status: v.H7.status, reason: v.H7.reason, metrics: { ...v.H7.metrics, load: state.load, vsyncHz: hz(), chromeVersion: CHROME_VERSION, versionMismatch: "Chrome major is compared with Electron 45's Chromium 156; see HYPOTHESES section 2", loadSource: state.loadSource, calibrationCheck: groups.includes("h7b") ? "calibration run and the H7b post-check" : "the calibration run itself (Chrome uncapped, 2 s warm-up + 20 s measured, the H7b conditions); H7b was not run" } };
  state.hypotheses["H20-6"] = { status: v["H20-6"].status, reason: v["H20-6"].reason, metrics: { ...v["H20-6"].metrics, load: state.load } };
}

/** Applies the H7b post-check to H7 and H20-6 once the uncapped Chrome runs exist. */
function applyCalibrationPostCheck(chromeUncapped) {
  const check = postCheck(chromeUncapped.medianP50Ms, hz());
  state.checks.calibrationPostCheck = check;
  if (!state.calibrated) return;
  for (const id of ["H7", "H20-6"]) {
    const h = state.hypotheses[id];
    if (h && !["N/A", "INVALID"].includes(h.status)) state.hypotheses[id] = { ...h, ...applyPostCheck({ status: h.status, reason: h.reason, metrics: h.metrics }, check) };
  }
}

async function groupH7b() {
  if (!state.load) {
    state.hypotheses.H7b = { status: "N/A", reason: `no load: ${state.calibrationNote}` };
    return;
  }
  const slots = { electron: [], chrome: [] };
  state.checks.h7b = { load: state.load, slots };
  for (let i = 1; i <= RUNS; i++) {
    for (const runtime of ["electron", "chrome"]) {
      await sleep(COOLDOWN_MS * 2);
      slots[runtime].push(await slot(runtime, `h7b-${runtime}-${i}`, { load: state.load, uncapped: true }, { cooldownMs: COOLDOWN_MS * 2 }));
      checkpoint(`h7b ${runtime} ${i}`);
    }
  }
  const finals = (rt) => slots[rt].map((s) => s.final).filter(Boolean);
  const electron = summary(finals("electron"));
  const chrome = summary(finals("chrome"));
  state.hypotheses.H7b = { status: "REPORTED", reason: "uncapped (--disable-frame-rate-limit --disable-gpu-vsync) throughput, not presentation; no threshold", metrics: { load: state.load, calibrated: state.calibrated, electron, chrome } };
  applyCalibrationPostCheck(chrome);
}

// -- H8 -------------------------------------------------------------------------------------------

function coldRow(runtime, kind, outcome, spawnMs) {
  const payload = outcome.value.payload;
  const d = payload?.data;
  const first = payload?.page?.visibility?.log?.find((e) => e.event === "first-frame");
  const reasons = [...environmentReasons(outcome)];
  if (outcome.value.error) reasons.push(`run error: ${outcome.value.error}`);
  if (!d) reasons.push("no payload");
  else {
    if (d.scene.softwareRenderer !== false) reasons.push("software renderer");
    if (d.scene.cssWidth !== WIDTH || d.scene.cssHeight !== HEIGHT) reasons.push(`viewport ${d.scene.cssWidth}x${d.scene.cssHeight}, not ${WIDTH}x${HEIGHT}`);
    if (d.scene.devicePixelRatio !== 2) reasons.push(`device pixel ratio ${d.scene.devicePixelRatio}`);
  }
  if (first && (!first.hasFocus || first.visibilityState !== "visible")) reasons.push("not visible and focused at the first frame");
  if (!first) reasons.push("no first-frame entry");
  return {
    runtime,
    kind,
    file: outcome.value.file ?? null,
    spawnToFirstFrameMs: d?.spawnToFirstFrameMs ?? null,
    focusedAtFirstFrame: first?.hasFocus ?? null,
    visibleAtFirstFrame: first ? first.visibilityState === "visible" : null,
    viewport: d ? { cssWidth: d.scene.cssWidth, cssHeight: d.scene.cssHeight, dpr: d.scene.devicePixelRatio } : null,
    hid: outcome.hid,
    power: outcome.power,
    valid: reasons.length === 0,
    invalidReasons: reasons,
    spawnMs,
  };
}

async function chromeColdLaunch(dir, label, sceneLoad) {
  const mark = run.mark();
  const spawnMs = Date.now(); // taken right before spawn(); nothing slow between the two
  const url = run.spikeUrl("/", { mode: "coldstart", runtime: "chrome", version: CHROME_VERSION, load: sceneLoad, spawn: spawnMs, label });
  const spawned = spawnChrome({ url, userDataDir: dir, app: false, cdp: false, windowSize: [WIDTH, HEIGHT + CHROME_UI_HEIGHT] });
  children.add(spawned.child);
  let posted = null;
  try {
    posted = await run.waitResult(mark, { timeoutMs: 60000 });
  } catch {}
  spawned.child.kill("SIGTERM");
  if ((await waitNoProfileProcesses(dir, 20000)) > 0) {
    spawned.child.kill("SIGKILL");
    await waitNoProfileProcesses(dir, 5000);
  }
  children.delete(spawned.child);
  return { payload: posted?.data ?? null, file: posted?.file ?? null, spawnMs, error: posted ? null : "no result within 60 s" };
}

async function groupH8() {
  const rows = [];
  const sceneLoad = state.load ?? 512;
  state.checks.h8 = { rows, load: sceneLoad, loadSource: state.loadSource ?? "default 512 (Task 5 Electron sweep; H8 has no calibration requirement)", chromeLaunch: "installed Chrome spawned directly with --user-data-dir, --no-first-run and the URL as a normal window sized for a 1280x720 viewport; Electron: electron/main.mjs --mode=coldstart" };
  for (let i = 1; i <= 3; i++) {
    for (const runtime of ["electron", "chrome"]) {
      const dir = mkdtempSync(join(run.tmp, `h8-${runtime}-${i}-`));
      for (const kind of ["cold", "warm"]) {
        const attemptsOfThis = [];
        const slotResult = await runSlot({
          attemptFn: async (attempt) => {
            const spawnHolder = { spawnMs: null };
            const outcome = await measured(async () => {
              if (runtime === "electron") {
                const launch = await launchElectron(run, "coldstart", [`--label=${kind}-${i}`, `--load=${sceneLoad}`], { userData: dir, spawnArg: true, timeoutMs: 120000 });
                const probe = launch.output?.result?.probe;
                spawnHolder.spawnMs = launch.spawnMs;
                await sleep(1500);
                return { payload: probe?.result ?? null, file: probe?.file ?? null, error: probe ? null : "no probe result" };
              }
              const r = await chromeColdLaunch(dir, `${kind}-${i}`, sceneLoad);
              spawnHolder.spawnMs = r.spawnMs;
              return r;
            });
            const row = coldRow(runtime, kind, outcome, spawnHolder.spawnMs);
            attemptsOfThis.push(row);
            return row;
          },
          cooldown: async () => {
            if (kind === "cold") rmSync(dir, { recursive: true, force: true }); // a retried cold launch needs an empty profile
            await sleep(2000);
          },
          log: (row, attempt) => log(`  ${runtime} ${kind} ${i} try ${attempt}: ${row.valid ? `${row.spawnToFirstFrameMs} ms` : `INVALID (${row.invalidReasons.join("; ")})`}`),
        });
        rows.push(slotResult.final ?? slotResult.attempts.at(-1));
        rows.at(-1).attempts = slotResult.attempts.length;
        checkpoint(`h8 ${runtime} ${kind} ${i}`);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const med = (rt, kind) => median(rows.filter((r) => r.runtime === rt && r.kind === kind && r.valid).map((r) => r.spawnToFirstFrameMs));
  const validCount = rows.filter((r) => r.valid).length;
  state.hypotheses.H8 = {
    status: "REPORTED",
    reason: `no threshold. Spawn to first presented frame, median ms of valid launches: Electron cold ${med("electron", "cold")}, warm ${med("electron", "warm")}; Chrome cold ${med("chrome", "cold")}, warm ${med("chrome", "warm")} (cold = empty profile, the OS file cache is not flushed); ${validCount} of ${rows.length} launches valid`,
    metrics: { medians: { electronCold: med("electron", "cold"), electronWarm: med("electron", "warm"), chromeCold: med("chrome", "cold"), chromeWarm: med("chrome", "warm") }, load: sceneLoad, validLaunches: validCount, launches: rows.length },
  };
}

// -- H9 -------------------------------------------------------------------------------------------

async function electronMemory(label) {
  let external = null;
  const launch = await launchElectron(run, "memory", [`--seconds=${MEMORY_SECONDS}`, `--load=${state.load ?? 512}`, "--memory-hold-ms=2500"], {
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
    await browser.page.goto(run.spikeUrl("/", { mode: "scene", runtime: "chrome", version: browser.version, load: state.load ?? 512 }));
    await browser.page.waitForFunction("window.wgProbe && wgProbe.state === 'rendering'", null, { timeout: 30000 });
    await sleep(MEMORY_SECONDS * 1000);
    const main = processList().find((p) => p.command.includes("Google Chrome") && p.command.includes("--remote-debugging-pipe") && !p.command.includes("--type="));
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
  state.checks.h9 = { rows, load: state.load ?? 512, method: "Electron also reports app.getAppMetrics() workingSetSize; Chrome's Task Manager footprint (a manual step in H9) is replaced by the macOS footprint tool over the process tree, which is the same definition applied to both runtimes" };
  for (let i = 1; i <= 1; i++) {
    for (const [runtime, fn] of [["electron", electronMemory], ["chrome", chromeMemory]]) {
      const result = await runSlot({
        attemptFn: async (attempt) => {
          const outcome = await measured(() => fn(`h9-${runtime}-${i}-try${attempt}`));
          const row = { ...outcome.value, hid: outcome.hid, power: outcome.power };
          row.invalidReasons = [...(outcome.value.invalidReasons ?? []), ...environmentReasons(outcome)];
          if (outcome.value.error) row.invalidReasons.push(outcome.value.error);
          row.valid = row.invalidReasons.length === 0;
          return row;
        },
        cooldown: () => sleep(COOLDOWN_MS),
        log: (row, attempt) => log(`  memory ${runtime} ${i} try ${attempt}: ${row.valid ? `external rss ${row.external?.rssMiB?.toFixed(0)} MiB, footprint ${row.external?.footprintMiB?.toFixed(0)} MiB` : `INVALID (${row.invalidReasons.join("; ")})`}`),
      });
      rows.push(result.final ?? result.attempts.at(-1));
      checkpoint(`h9 ${runtime} ${i}`);
      await sleep(COOLDOWN_MS);
    }
  }
  const med = (rt, field) => median(rows.filter((r) => r.runtime === rt && r.valid && r.external).map((r) => r.external[field]));
  state.hypotheses.H9 = rows.some((r) => r.valid)
    ? {
        status: "REPORTED",
        reason: `no threshold, no percentage claim (definitions differ). After ${MEMORY_SECONDS} s of the scene, process tree summed from outside with the same tools for both: resident (ps rss) / phys footprint (macOS footprint), MiB (one run each, owner-approved): Electron ${med("electron", "rssMiB")?.toFixed(0)} / ${med("electron", "footprintMiB")?.toFixed(0)}; Chrome ${med("chrome", "rssMiB")?.toFixed(0)} / ${med("chrome", "footprintMiB")?.toFixed(0)}`,
        metrics: { electronRssMiB: med("electron", "rssMiB"), electronFootprintMiB: med("electron", "footprintMiB"), chromeRssMiB: med("chrome", "rssMiB"), chromeFootprintMiB: med("chrome", "footprintMiB"), load: state.load ?? 512, validRuns: rows.filter((r) => r.valid).length, runs: rows.length },
      }
    : { status: "INVALID", reason: "no valid memory run (page hidden or unfocused, input during the run, battery or thermal limit)" };
}

// -- Demos ----------------------------------------------------------------------------------------

async function groupDemos() {
  const config = demoConfig();
  const settings = { settleMs: SMOKE ? 1500 : config.settleMs, warmupMs: WARMUP, durationMs: DURATION, vsyncHz: hz() };
  const rows = [];
  state.checks.demos = { settings: { ...settings, viewport: `${WIDTH}x${HEIGHT}` }, rows };
  for (const demo of SMOKE ? config.demos.slice(0, 1) : config.demos) {
    for (const [name, fn] of [["electron", runDemoElectron], ["chrome", runDemoChrome]]) {
      await sleep(SMOKE ? 500 : 5000);
      const outcome = await measured(() => fn(run, demo, settings));
      const row = outcome.value;
      row.hid = outcome.hid;
      row.power = outcome.power;
      row.therm = { cpuSpeedLimit: outcome.therm.cpuSpeedLimit, warningRecorded: outcome.therm.warningRecorded };
      row.invalidReasons = environmentReasons(outcome);
      if (row.visibility?.everHidden) row.invalidReasons.push("page was hidden during sampling");
      if (row.visibility?.everUnfocused) row.invalidReasons.push("page lost focus during sampling");
      if (!row.stats) row.invalidReasons.push(`no samples (${row.loadError ?? "?"})`);
      row.validForTiming = row.invalidReasons.length === 0;
      rows.push(row);
      checkpoint(`demos ${demo.id} ${name}`);
      log(`  ${demo.id} in ${name}: ${row.stats ? `p50 ${row.stats.p50Ms.toFixed(2)} p95 ${row.stats.p95Ms.toFixed(2)} long ${row.stats.longFrames}` : "no samples"} valid ${row.validForTiming}${row.validForTiming ? "" : ` (${row.invalidReasons.join("; ")})`}`);
    }
  }
  state.hypotheses.H21 = { status: "REPORTED", reason: "indicative only: external pages are not calibrated and run their own load; same sampler and window size in both runtimes", metrics: { demos: rows.map((r) => ({ id: r.id, runtime: r.runtime, loaded: r.loadOk, p50Ms: r.stats?.p50Ms ?? null, p95Ms: r.stats?.p95Ms ?? null, longFrames: r.stats?.longFrames ?? null, valid: r.validForTiming })) } };
}

const RUN_GROUP = { calibrate: groupCalibrate, h7: groupH7, h8: groupH8, h9: groupH9, demos: groupDemos, h7b: groupH7b };

// ---- Main ----------------------------------------------------------------------------------------

try {
  caffeinate = spawn("caffeinate", ["-d", "-i", "-w", String(process.pid)], { stdio: "ignore" }); // display awake while this runner lives
  await run.startServers();
  const env = await electronEnvironment(run);
  machine.displayRefreshHz = env?.display?.displayFrequency ?? null;
  state.environment = { electron: env?.versions ?? null, displayFrequency: machine.displayRefreshHz, chrome: CHROME_VERSION };
  const cpu = topCpu(8);
  state.checks.startConditions = { hidIdleSeconds: Math.round(hidIdleSeconds() ?? -1), power: onBattery() ? "battery" : "ac", topCpuPercentSum: Math.round(cpu.sumPercent), thermal: thermalStatus(), minIdleSeconds: MIN_IDLE_S };
  log(`run-timing${SMOKE ? " (SMOKE: numbers mean nothing)" : ""}: groups ${groups.join(" ")}; display ${machine.displayRefreshHz} Hz; HID idle ${state.checks.startConditions.hidIdleSeconds} s; ${state.checks.startConditions.power}`);
  log(`  busiest processes now: ${cpu.rows.map((r) => `${r.name} ${r.cpu}%`).join(", ")}`);
  log("  Reminder: turn Do Not Disturb on and quit chat, mail and sync apps; do not touch the keyboard or trackpad until the summary prints.");
  for (const name of ALL) {
    if (!groups.includes(name)) continue;
    log(`group ${name}`);
    await waitForIdle(`group ${name}`);
    try {
      await RUN_GROUP[name]();
    } catch (error) {
      log(`  group ${name} ERROR ${error.stack}`);
      state.checks[`${name}Error`] = run.sanitize(String(error.stack ?? error));
      if (/was not idle for/.test(String(error.message))) throw error; // abort the whole run, not just the group
    }
    state.completedGroups.push(name);
    checkpoint(`group ${name} done`);
    await sleep(500);
  }
} catch (error) {
  state.fatal = String(error.message ?? error);
  log(`FATAL ${error.stack ?? error}`);
}
caffeinate?.kill("SIGTERM");
run.stopServers();
for (const child of children) child.kill("SIGTERM");
const leaked = await killProcessesWithin(run.tmp);
if (leaked) log(`WARNING: ${leaked} process(es) of this run could not be stopped`);
const written = checkpoint("final", true);
console.log(`\nwritten: ${written.rel}${written.schemaError ? ` SCHEMA INVALID: ${written.schemaError}` : ""}`);
for (const [id, h] of Object.entries(state.hypotheses)) console.log(`${id.padEnd(8)} ${h.status.padEnd(13)} ${h.reason}`);
if (state.checks.calibrationOutcome) console.log(`${"H7cal".padEnd(8)} ${state.checks.calibrationOutcome.status.padEnd(13)} ${state.checks.calibrationOutcome.reason}`);
if (!opts["keep-temp"]) rmSync(run.tmp, { recursive: true, force: true });
if (scratch) console.log(`(smoke results are in the scratch directory ${scratch}; delete it when done)`);
process.exit(state.fatal ? 1 : 0);
