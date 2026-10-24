// THROWAWAY spike (runtime-compat, Task 6). Chrome baseline capability checks (H19: H3, H5, H6) in
// the installed Google Chrome driven by Playwright (channel "chrome", headed, fresh profile), and the
// same checks in Playwright's bundled Chromium as a same-engine reference (NOT the Chrome baseline).

import { launchPlaywrightBrowser, sleep } from "../common.mjs";

async function waitProbePage(page, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await page.evaluate("window.wgProbe ? { state: wgProbe.state, file: wgProbe.file, error: wgProbe.error } : null").catch(() => null);
    if (s && (s.state === "posted" || s.state === "error")) return s;
    await sleep(250);
  }
  throw new Error("probe did not finish");
}

export async function group(context, kind) {
  const { run, log, electronReference } = context;
  const channel = kind === "chrome" ? "chrome" : "chromium";
  const runtimeName = kind === "chrome" ? "chrome" : "chromium";
  const probeFiles = [];

  async function probe(path, params, label) {
    const browser = await launchPlaywrightBrowser({ channel });
    try {
      const mark = run.mark();
      const url = run.spikeUrl(path, { mode: "probe", runtime: runtimeName, version: browser.version, label, ...params });
      await browser.page.goto(url);
      const state = await waitProbePage(browser.page);
      const posted = state.state === "posted" ? await run.waitResult(mark, { timeoutMs: 5000 }) : null;
      if (posted) probeFiles.push(posted.file);
      const focus = await browser.page.evaluate("({ visibility: document.visibilityState, focus: document.hasFocus(), innerWidth, innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent })");
      return { label, path, state, file: posted?.file ?? null, data: posted?.data ?? null, version: browser.version, sizing: browser.sizing, launchedMs: browser.launchedMs, page: focus };
    } finally {
      await browser.close();
    }
  }

  const fullRuns = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await probe("/coi/", {}, `${kind}-probe-full-${attempt}`);
    fullRuns.push(r);
    log(`  ${kind} full probe ${attempt}: ${r.state.state}${r.state.error ? ` ${r.state.error}` : ""}`);
    if (r.data?.data?.checks?.webgl2?.softwareRenderer !== true) break; // retry only a software renderer (H6)
  }
  const control = await probe("/", { checks: "coi" }, `${kind}-h3-control`);
  const full = fullRuns.at(-1);
  const checks = full.data?.data?.checks ?? {};
  const version = full.version;
  const reference = electronReference();
  const gl = checks.webgl2;
  const gpu = checks.webgpu;
  const coi = checks.coi;
  const controlCoi = control.data?.data?.checks?.coi;

  const hypotheses = {};
  const hardware = gl?.available === true && gl.softwareRenderer === false;
  hypotheses.H6 = hardware
    ? { status: "PASS", reason: `hardware renderer: ${gl.renderer}`, metrics: { renderers: fullRuns.map((r) => r.data?.data?.checks?.webgl2?.renderer ?? null) } }
    : { status: "INVALID", reason: `software or missing WebGL2 renderer after ${fullRuns.length} attempt(s): ${gl?.renderer ?? gl?.error ?? "none"}` };
  const h3Valid = coi && controlCoi && controlCoi.crossOriginIsolated === false;
  hypotheses.H3 = !h3Valid
    ? { status: "INVALID", reason: "probe result missing or control reported crossOriginIsolated true" }
    : {
        status: "REPORTED",
        reason: `/coi/: crossOriginIsolated ${coi.crossOriginIsolated}, SharedArrayBuffer round trip ${coi.roundTrip}; control false (no PASS or FAIL for the baseline)`,
        metrics: { crossOriginIsolated: coi.crossOriginIsolated, roundTrip: coi.roundTrip, waitAsync: coi.waitAsync, controlCrossOriginIsolated: controlCoi.crossOriginIsolated },
      };
  const electronFeatures = reference?.webgpu?.features ?? null;
  const chromeFeatures = gpu?.features ?? null;
  hypotheses.H5 = gpu?.adapter
    ? {
        status: "REPORTED",
        reason: `adapter ${gpu.adapter.vendor}/${gpu.adapter.architecture}, ${gpu.featureCount} features, device ${gpu.device}, compute readback ${gpu.computeReadbackCorrect}${electronFeatures ? `; Electron 45 had ${reference.webgpu.featureCount} features` : ""}`,
        metrics: {
          adapter: gpu.adapter,
          featureCount: gpu.featureCount,
          device: gpu.device ?? null,
          computeReadbackCorrect: gpu.computeReadbackCorrect ?? null,
          electronReferenceFile: reference?.file ?? null,
          electronFeatureCount: reference?.webgpu?.featureCount ?? null,
          featuresOnlyInChrome: electronFeatures && chromeFeatures ? chromeFeatures.filter((f) => !electronFeatures.includes(f)) : null,
          featuresOnlyInElectron: electronFeatures && chromeFeatures ? electronFeatures.filter((f) => !chromeFeatures.includes(f)) : null,
        },
      }
    : { status: "REPORTED", reason: `no WebGPU adapter in ${kind}: ${gpu?.error ?? gpu?.reason ?? "adapter null"}`, metrics: { gpu: gpu ?? null } };
  const major = Number(/^(\d+)/.exec(version)?.[1] ?? 0);
  const mismatch = major !== 156;
  if (kind === "chrome") {
    hypotheses.H19 = {
      status: hardware && h3Valid ? "REPORTED" : "INVALID",
      reason: `${hardware ? "valid" : "INVALID"} baseline for H3, H5 and H6: Chrome ${version}${mismatch ? ` (major ${major}, not 156: version mismatch with Electron 45's Chromium 156.0.8078.48)` : ""}, Playwright channel chrome, headed, fresh profile`,
      metrics: { version, versionMismatchWithElectronChromium156: mismatch, userAgent: full.page?.ua ?? null, viewport: { innerWidth: full.page?.innerWidth, innerHeight: full.page?.innerHeight }, devicePixelRatio: full.page?.dpr },
    };
  }
  const label =
    kind === "chrome"
      ? `Google Chrome ${version} via Playwright channel chrome, headed (H19 baseline)`
      : `Playwright bundled Chromium ${version}, headed: same-engine reference, NOT the Chrome baseline`;
  return {
    runtime: { name: runtimeName, version, chromium: version },
    label,
    hypotheses,
    checks: { fullProbeAttempts: fullRuns.map((r) => ({ label: r.label, file: r.file, state: r.state, launchedMs: r.launchedMs, sizing: r.sizing, page: r.page })), control: { label: control.label, file: control.file, state: control.state }, electronReference: reference },
    probeFiles,
    leftoverProcesses: {},
  };
}
