// THROWAWAY spike (runtime-compat, Task 6). The decision logic of run-timing.mjs as pure functions
// (no I/O, no clock), so it can be exercised with mocked inputs. HYPOTHESES.md H7 is the source of the
// rules; every interpretation is named in a comment where it is made.

import { median } from "./common.mjs";

export const BAND = { low: 0.6, high: 1.2 }; // H7 calibration band, share of the vsync interval (Assumed in HYPOTHESES)
export const NOISE_LIMIT = 0.15; // H7 noise rule: Chrome p95 spread of 15% or more is INCONCLUSIVE (Assumed in HYPOTHESES)
export const P95_FACTOR = 1.15; // H7 PASS: Electron p95 <= Chrome p95 x 1.15
export const LOAD_LADDER = [64, 128, 256, 384, 512, 768, 1024, 2048];

/** Reasons a frame-time payload does not count (H6, visibility, viewport, calibrated load). */
export function validity(payload, { load, width = 1280, height = 720, buffer = [2560, 1440] }) {
  const d = payload?.data;
  const v = payload?.page?.visibility;
  if (!d || !v) return ["no payload"];
  const reasons = [];
  if (v.everHidden) reasons.push("page was hidden");
  if (v.everUnfocused) reasons.push("page lost focus");
  if (d.scene.softwareRenderer !== false) reasons.push(`renderer not hardware: ${d.scene.renderer}`);
  if (d.viewport.innerWidth !== width || d.viewport.innerHeight !== height) reasons.push(`viewport ${d.viewport.innerWidth}x${d.viewport.innerHeight}`);
  if (d.scene.drawingBufferWidth !== buffer[0] || d.scene.drawingBufferHeight !== buffer[1]) reasons.push(`drawing buffer ${d.scene.drawingBufferWidth}x${d.scene.drawingBufferHeight}`);
  if (load !== undefined && d.settings.load !== load) reasons.push(`load ${d.settings.load}`);
  return reasons;
}

/** Reasons that apply to every measured launch: input during it, battery power, thermal limit. */
export function environmentReasons({ hid, power, therm }) {
  const reasons = [];
  if (hid?.inputDuringRun) reasons.push("keyboard or trackpad input during the run");
  if (power === "battery") reasons.push("on battery power");
  if (therm && ((typeof therm.cpuSpeedLimit === "number" && therm.cpuSpeedLimit < 100) || therm.warningRecorded)) reasons.push(`thermal limit or warning (${therm.raw})`);
  return reasons;
}

export function summary(rows) {
  const valid = rows.filter((r) => r.valid && r.stats);
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
}

/** One calibration decision: where to go next on the load ladder given p50 as a share of the vsync interval. */
export function calibrationStep({ ratio, index, direction }) {
  if (ratio === null || ratio === undefined) return { action: "stop", reason: "no valid measurement" };
  if (ratio >= BAND.low && ratio <= BAND.high) return { action: "accept" };
  const next = ratio < BAND.low ? 1 : -1; // too light: raise the load; saturated: lower it (R17)
  if (direction !== 0 && next !== direction) return { action: "stop", reason: "crossed the band without landing in it" };
  const nextIndex = index + next;
  if (nextIndex < 0 || nextIndex >= LOAD_LADDER.length) return { action: "stop", reason: "end of the load ladder" };
  return { action: "move", index: nextIndex, direction: next };
}

export function ratioToVsync(p50Ms, hz) {
  return typeof p50Ms === "number" && hz ? p50Ms / (1000 / hz) : null;
}

/** H7b post-check: does Chrome's uncapped median p50 land in the calibration band? */
export function postCheck(chromeUncappedMedianP50Ms, hz) {
  const ratio = ratioToVsync(chromeUncappedMedianP50Ms, hz);
  return ratio === null ? { ran: false, ratio: null, inBand: null } : { ran: true, ratio, inBand: ratio >= BAND.low && ratio <= BAND.high };
}

/**
 * Verdict for one runtime against the Chrome baseline of the same pass (HYPOTHESES H7).
 * kind "electron": PASS or FAIL by p95 x 1.15. kind "chrome-app": the same comparison is only REPORTED
 * (interpretation: H20 asks for one PASS or FAIL per check and has no combined threshold, so the H7
 * threshold is applied for information, not as a verdict).
 */
export function h7Verdict({ name, kind, s, chrome, runsWanted, rerun, calibrated, calibrationNote }) {
  const metrics = { runtime: s, chrome, runsWanted, rerun };
  if (!calibrated) {
    // H7: a run on an uncalibrated scene is INVALID, never PASS.
    return { status: calibrationNote?.startsWith("no load") ? "N/A" : "INVALID", reason: `no calibrated load in this invocation: ${calibrationNote}`, metrics };
  }
  if (s.validRuns < runsWanted || chrome.validRuns < runsWanted) {
    return { status: "INVALID", reason: `${name} ${s.validRuns} valid run(s), Chrome ${chrome.validRuns}, ${runsWanted} wanted after retries: persistent INVALID, the owner decides (R17: treated as INCONCLUSIVE)`, metrics };
  }
  if (chrome.p95Spread !== null && chrome.p95Spread >= NOISE_LIMIT) {
    return rerun
      ? { status: "INCONCLUSIVE", reason: `Chrome p95 spread ${(chrome.p95Spread * 100).toFixed(1)}% >= 15% also with 5 fresh runs each: no verdict, Electron cannot be accepted on H7 alone and the owner decides (decision rule 5)`, metrics }
      : { status: "INCONCLUSIVE", reason: `Chrome p95 spread ${(chrome.p95Spread * 100).toFixed(1)}% >= 15% with ${runsWanted} runs: rerun both runtimes with 5 runs each before any verdict`, metrics, needsRerun: true };
  }
  const limit = chrome.medianP95Ms * P95_FACTOR;
  const ratio = s.medianP95Ms / chrome.medianP95Ms;
  const text = `${name} p95 ${s.medianP95Ms.toFixed(2)} ms ${s.medianP95Ms <= limit ? "<=" : ">"} Chrome p95 ${chrome.medianP95Ms.toFixed(2)} ms x 1.15 = ${limit.toFixed(2)} ms (ratio ${ratio.toFixed(3)})`;
  if (kind === "chrome-app") return { status: "REPORTED", reason: `${text}; reported, not a verdict (H20 has no combined threshold)`, metrics: { ...metrics, ratio, wouldPass: s.medianP95Ms <= limit } };
  return { status: s.medianP95Ms <= limit ? "PASS" : "FAIL", reason: text, metrics: { ...metrics, ratio } };
}

/**
 * Applies the H7b post-check to a verdict: a calibrated H7 whose uncapped Chrome median p50 is outside the band
 * becomes INVALID (an uncalibrated scene is never a PASS).
 */
export function applyPostCheck(verdict, check) {
  if (!check.ran || check.inBand) return { ...verdict, metrics: { ...verdict.metrics, postCheck: check } };
  return {
    status: "INVALID",
    reason: `H7b post-check: Chrome uncapped p50 is ${(check.ratio * 100).toFixed(0)}% of the vsync interval, outside the 60-120% band, so the load was not calibrated (verdict before the check: ${verdict.status})`,
    metrics: { ...verdict.metrics, postCheck: check, verdictBeforePostCheck: verdict.status },
  };
}

/**
 * Runs one measurement slot: up to `maxAttempts` attempts; an exception counts as a recorded attempt, an invalid
 * attempt is retried after `cooldown()`. Returns { final, attempts } and never throws because of a runner.
 */
export async function runSlot({ attemptFn, maxAttempts = 3, cooldown = async () => {}, log = () => {} }) {
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let row;
    try {
      row = await attemptFn(attempt);
    } catch (error) {
      row = { valid: false, invalidReasons: [`attempt threw: ${String(error?.message ?? error).slice(0, 300)}`], stats: null, attempt };
    }
    row.attempt = attempt;
    attempts.push(row);
    log(row, attempt);
    if (row.valid) break;
    if (attempt < maxAttempts) await cooldown();
  }
  return { final: attempts.find((a) => a.valid) ?? null, attempts };
}
