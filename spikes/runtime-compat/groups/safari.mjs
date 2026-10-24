// THROWAWAY spike (runtime-compat, Task 6). Safari as a cheap WebKit proxy for WKWebView (owner-approved scope change: the
// Tauri build was dropped). This is Safari, NOT WKWebView and NOT Tauri: capability results only,
// no frame time. The probe page is served by the spike server itself, so its POST is same-origin.

import { execFileSync } from "node:child_process";
import { sh, sleep } from "../common.mjs";

function safariPids() {
  return sh("pgrep", ["-x", "Safari"]).split("\n").filter((l) => /^\d+$/.test(l));
}

/** Closes only tabs whose URL starts with the spike server origin; reports the outcome. */
function closeOurTabs(origin) {
  // Walk each window's tabs from the last to the first so that closing one does not shift the next.
  const script = `
tell application "Safari"
  set closed to 0
  repeat with w in (windows as list)
    try
      repeat with i from (count of tabs of w) to 1 by -1
        if (URL of tab i of w) starts with "${origin}/" then
          close tab i of w
          set closed to closed + 1
        end if
      end repeat
    end try
  end repeat
  return closed
end tell`;
  try {
    const out = execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 20000 }).trim();
    return { ok: true, closedTabs: Number(out) };
  } catch (error) {
    return { ok: false, error: String(error.message).split("\n").slice(0, 2).join(" ").slice(0, 300) };
  }
}

export async function group(context) {
  const { run, log } = context;
  const safariWasRunning = safariPids().length > 0;
  const version = sh("defaults", ["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"]);
  const origin = `http://localhost:${run.spikePort}`;
  const probeFiles = [];
  const label = `Safari ${version} (WebKit proxy for WKWebView; not WKWebView itself)`;

  async function probe(path, params, fileLabel) {
    const mark = run.mark();
    const url = run.spikeUrl(path, { mode: "probe", runtime: "safari", version, label: fileLabel, ...params });
    sh("open", ["-a", "Safari", url]);
    try {
      const posted = await run.waitResult(mark, { timeoutMs: 90000 });
      probeFiles.push(posted.file);
      return posted;
    } catch (error) {
      return { error: error.message };
    }
  }

  const full = await probe("/coi/", {}, "safari-probe-full");
  log(`  safari full probe: ${full.error ?? full.file}`);
  const control = await probe("/", { checks: "coi" }, "safari-h3-control");
  log(`  safari control: ${control.error ?? control.file}`);
  await sleep(500);
  const closing = closeOurTabs(origin);
  log(`  safari tab close: ${JSON.stringify(closing)}`);
  const checks = full.data?.data?.checks ?? {};
  const coi = checks.coi;
  const controlCoi = control.data?.data?.checks?.coi;
  const gl = checks.webgl2;
  const gpu = checks.webgpu;
  const hypotheses = {
    H3: coi && controlCoi
      ? { status: "REPORTED", reason: `/coi/: crossOriginIsolated ${coi.crossOriginIsolated}, SharedArrayBuffer defined ${coi.sharedArrayBufferDefined}, round trip ${coi.roundTrip}; control crossOriginIsolated ${controlCoi.crossOriginIsolated}`, metrics: { coi, control: controlCoi } }
      : { status: "INVALID", reason: `probe result missing: ${full.error ?? control.error ?? "no coi data"}` },
    H5: gpu
      ? {
          status: "REPORTED",
          reason: gpu.adapter ? `adapter ${gpu.adapter.vendor ?? "?"}/${gpu.adapter.architecture ?? "?"}, ${gpu.featureCount} features, device ${gpu.device ?? false}, compute readback ${gpu.computeReadbackCorrect ?? null}` : `navigator.gpu present: ${gpu.available}; adapter ${gpu.adapter === null ? "null" : "none"}${gpu.error ? ` (${gpu.error})` : ""}${gpu.reason ? ` (${gpu.reason})` : ""}`,
          metrics: { webgpu: gpu },
        }
      : { status: "INVALID", reason: "no WebGPU result" },
    H6: gl
      ? { status: "REPORTED", reason: gl.available ? `WebGL2 renderer string ${gl.renderer ?? "not exposed (no WEBGL_debug_renderer_info)"}; software renderer flag ${gl.softwareRenderer}` : "WebGL2 not available", metrics: { renderer: gl.renderer ?? null, softwareRenderer: gl.softwareRenderer ?? null } }
      : { status: "INVALID", reason: "no WebGL2 result" },
  };
  return {
    runtime: { name: "safari", version, chromium: null },
    label,
    hypotheses,
    checks: {
      safariWasRunningBefore: safariWasRunning,
      userAgent: full.data?.runtime?.userAgent ?? null,
      fullProbeFile: full.file ?? null,
      controlFile: control.file ?? null,
      probe: { wasm: checks.wasm ?? null, storage: checks.storage ?? null, opfs: checks.opfs ?? null, idb: checks.idb ?? null, audio: checks.audio ?? null },
      tabClose: closing,
      scope: "capabilities only; Safari is a proxy for WKWebView and no frame time was taken",
    },
    probeFiles,
    leftoverProcesses: { safariProcessesNow: safariPids().length, safariWasRunningBefore: safariWasRunning },
  };
}
