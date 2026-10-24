// THROWAWAY spike (runtime-compat, Task 6). Generates docs/compat/matrix.md from results/*.json:
//
//   node spikes/runtime-compat/matrix.mjs > docs/compat/matrix.md
//
// Pure function of the committed result files: no clock, no random order, so running it twice gives
// byte-identical output. Only real runs appear; everything else is listed under "Not tested".

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RESULTS = join(import.meta.dirname, "results");
const aggregates = readdirSync(RESULTS)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file) => ({ file, data: JSON.parse(readFileSync(join(RESULTS, file), "utf8")) }))
  .filter((a) => a.data.kind === "run");

/** Latest aggregate of a runtime that carries hypothesis `id` with a status other than NOT_RUN. */
function latest(runtimeName, id) {
  let found = null;
  for (const a of aggregates) {
    const h = a.data.hypotheses?.[id];
    if (a.data.runtime.name === runtimeName && h && h.status !== "NOT_RUN") found = { ...a, h };
  }
  return found;
}

const lastOf = (runtimeName) => aggregates.filter((a) => a.data.runtime.name === runtimeName).at(-1) ?? null;
const date = (a) => (a ? a.data.createdAt.slice(0, 10) : "not tested");
const cell = (text) => String(text ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
const st = (found) => (found ? found.h.status : "not run");

const anyAggregate = aggregates.at(-1);
const machine = anyAggregate?.data.machine;
const osText = machine ? `${machine.osVersion}, ${machine.arch}, ${machine.cpu}` : "unknown";

const lines = [];
const out = (line = "") => lines.push(line);

out("# Compatibility matrix");
out();
out("<!-- Generated file. Do not edit by hand. Regenerate with: node spikes/runtime-compat/matrix.mjs > docs/compat/matrix.md -->");
out();
out("> **Generated** from `spikes/runtime-compat/results/*.json` by `node spikes/runtime-compat/matrix.mjs > docs/compat/matrix.md`.");
out("> Do not edit by hand; running the command twice gives identical output. Only real recorded runs appear here. Each row is");
out("> Verified on the date and for the OS shown, with the evidence file named in its last column (a file under");
out("> `spikes/runtime-compat/results/`). Nothing is extrapolated to other machines, operating systems or games: see");
out("> [methodology.md](methodology.md). \"Verified\" never applies to a platform or game that has no row with a run.");
out("> The timing measurements (frame time against Chrome, Chrome-side start time, memory, demo frame samples) are deferred to Phase 1");
out("> by the owner's decision of 2026-10-25 and show as deferred, not as results.");
out();
out("## Runs on the dev machine");
out();
out("| Game / build | URL or version | Date | OS | Runtime | Launch | Input | Save | Restore | Notes | Evidence |");
out("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

const electronFull = lastOf("electron");
const electronVersion = electronFull ? `Electron ${electronFull.data.runtime.version} (Chromium ${electronFull.data.runtime.chromium})` : "Electron";
const h11 = latest("electron", "H11");
const h2 = latest("electron", "H2");
const h14 = latest("electron", "H14");
const h13 = latest("electron", "H13");
if (h2 || h11 || h14) {
  const when = h2 ?? h11 ?? h14;
  out(
    `| progress-lab (controlled test fixture, not a real game) | \`fixtures/test-games/progress-lab\`, served from localhost | ${date(when)} | ${cell(osText)} | ${cell(electronVersion)} | window opens, page loads (H11 ${st(h11)}) | \`#play-step\` clicked by Playwright (H11); injected trusted input: H13 ${st(h13)} | persists across \`app.quit()\` and relaunch in its own partition (H2 ${st(h2)}) | export while closed, restore into a clean partition, same hash (H14 ${st(h14)}, variants a to d) | session partitions isolated (H1 ${st(latest("electron", "H1"))}); no manual real-click run | ${cell(h2?.file ?? "")} |`,
  );
} else out("| progress-lab | n/a | not tested | n/a | Electron | not tested | not tested | not tested | not tested | no result file | none |");

const appRuns = aggregates.filter((a) => a.data.runtime.name === "chrome-app");
const app = appRuns.at(-1) ?? null;
/** "PASS in 3 of 5 runs" over every chrome-app aggregate, so a mixed outcome is never reduced to the last run. */
const tally = (id) => {
  const statuses = appRuns.map((a) => a.data.hypotheses[id]?.status).filter(Boolean);
  const counts = {};
  for (const x of statuses) counts[x] = (counts[x] ?? 0) + 1;
  const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}/${statuses.length}`);
  return parts.length ? parts.join(", ") : "not run";
};
if (app) {
  const heights = appRuns.map((a) => a.data.hypotheses["H20-3"]?.metrics?.uiHeightPx).filter((x) => typeof x === "number");
  const uiHeights = heights.length ? (Math.min(...heights) === Math.max(...heights) ? `${heights[0]}` : `${Math.min(...heights)} to ${Math.max(...heights)}`) : "n/a";
  const survived = appRuns.filter((a) => a.data.checks.progressLab?.persistedAcrossRestart === true).length;
  out(
    `| progress-lab (controlled test fixture, not a real game) | \`fixtures/test-games/progress-lab\`, served from localhost | ${date(app)} | ${cell(osText)} | Google Chrome ${app.data.runtime.version}, launched directly with \`--app=URL\` and one \`--user-data-dir\` per game | window opens with a title bar only (H20-3 ${tally("H20-3")}): browser UI height ${uiHeights} px in ${appRuns.filter((a) => a.data.hypotheses["H20-3"]?.status === "PASS").length} of ${appRuns.length} runs (a normal window: 87 px); one screenshot read once by the agent (RESULTS.md, H20) | \`#play-step\` clicked through CDP | progress hash survived a graceful quit and relaunch in ${survived} of ${appRuns.length} runs (H20-2 ${tally("H20-2")}) | not tested (CDP IndexedDB can read but not write) | ${appRuns.length} runs. Two profiles isolated (H20-1 ${tally("H20-1")}); CDP reads (H20-4 ${tally("H20-4")}); the closed window's renderer exits ${cell(appRuns.map((a) => a.data.checks.progressLab && a.data.hypotheses["H20-5"]?.metrics?.rendererExitAfterCloseMs).filter((x) => x != null).map((x) => `${(x / 1000).toFixed(1)}`).join(", "))} s after the close (H20-5 ${tally("H20-5")}, threshold 5 s is Assumed); Chrome keeps running after its last window closes (a launcher must quit it itself) | ${cell(appRuns.map((a) => a.file).join(", "))} |`,
  );
} else out("| progress-lab | n/a | not tested | n/a | Chrome `--app` | not tested | not tested | not tested | not tested | no result file | none |");

const demos = lastOf("demos");
if (demos) {
  for (const r of demos.data.checks.rows) {
    const family = r.runtime.split("-")[0];
    const runtimeText = family === "electron" ? `Electron ${r.runtime.replace("electron-", "")}` : `Google Chrome ${r.runtime.replace("chrome-", "")}`;
    const favicon = r.faviconErrors ? `; ${r.faviconErrors} of the console errors is the /favicon.ico 404 that only Chrome requests` : "";
    const launch = r.unreachable ? "not tested (unreachable)" : r.loadOk ? `loads, ${r.canvases} canvas(es)` : `did not load: ${r.loadError}`;
    out(
      `| ${cell(`${r.id} (${r.id.startsWith("webgpu") || r.url.includes("webgpu") ? "WebGPU" : "WebGL"} demo)`)} | \`${cell(r.url)}\` | ${date(demos)} | ${cell(osText)} | ${cell(runtimeText)} | ${cell(launch)} | not tested | n/a (no game save) | n/a | WebGPU used: ${r.webgpuUsed}; console errors: ${r.consoleErrors}${cell(favicon)}; frame sample deferred to Phase 1 | ${cell(demos.file)} |`,
    );
  }
} else out("| public demos (webgpu-samples, three.js examples) | n/a | not tested | n/a | Electron, Chrome | not tested | not tested | not tested | not tested | no result file | none |");

const safari = lastOf("safari");
if (safari) {
  const h = safari.data.hypotheses;
  out(
    `| spike probe page (capabilities, not a game) | \`spikes/runtime-compat/probe/\`, served from localhost | ${date(safari)} | ${cell(osText)} | Safari ${safari.data.runtime.version} (WebKit proxy for WKWebView; not WKWebView itself) | loads (H3 ${h.H3?.status}, H5 ${h.H5?.status}, H6 ${h.H6?.status}: see notes) | n/a | n/a | n/a | ${cell(`${h.H3?.reason}; ${h.H5?.reason}; ${h.H6?.reason}. No frame time was taken`)} | ${cell(safari.file)} |`,
  );
}

out();
out("## Capability probe and measurements on the same machine");
out();
const chrome = lastOf("chrome");
const chromium = lastOf("chromium");
out("| Item | Electron | Chrome | Notes |");
out("| --- | --- | --- | --- |");
const electronGpuAggregate = aggregates.filter((a) => a.data.runtime.name === "electron" && a.data.checks?.gpu?.runs).at(-1);
const electronGpu = electronGpuAggregate?.data.checks.gpu.runs.at(-1)?.output?.result?.probe?.result?.data?.checks;
const gl = (c) => c?.webgl2?.renderer ?? "not recorded";
out(`| WebGL2 renderer (H6) | ${cell(gl(electronGpu))} | ${chrome ? cell(chrome.data.hypotheses.H6?.reason) : "not tested"} | ${chromium ? `Playwright bundled Chromium ${chromium.data.runtime.version}: ${cell(chromium.data.hypotheses.H6?.status)}` : "bundled Chromium not run"} |`);
out(`| WebGPU adapter and features (H5) | ${electronGpu?.webgpu?.adapter ? `${electronGpu.webgpu.adapter.vendor}/${electronGpu.webgpu.adapter.architecture}, ${electronGpu.webgpu.featureCount} features` : "not recorded"} | ${chrome ? cell(chrome.data.hypotheses.H5?.reason) : "not tested"} | ${chrome?.data.hypotheses.H5?.metrics?.featuresOnlyInElectron?.length ? `only in Electron: ${cell(chrome.data.hypotheses.H5.metrics.featuresOnlyInElectron.join(", "))}` : "no feature differences recorded"} |`);
out(`| Cross-origin isolation with server headers (H3) | ${cell(latest("electron", "H3")?.h.reason ?? "not recorded")} | ${chrome ? cell(chrome.data.hypotheses.H3?.reason) : "not tested"} | |`);
const DEFERRED = "deferred to Phase 1 (owner decision 2026-10-25)";
const electronH8 = latest("electron", "H8");
out(`| Frame time, capped scene (H7) | ${DEFERRED} | ${DEFERRED} | the Task 5 Electron numbers (see RESULTS.md) have no verdict without a calibrated Chrome baseline; deferred is not N/A and not a pass |`);
out(`| Frame time, Chrome \`--app\` (H20-6) | n/a | ${DEFERRED} | |`);
out(`| Spawn to first frame, cold and warm (H8) | ${electronH8?.h.metrics ? `cold ${electronH8.h.metrics.coldMedianMs} ms, warm ${electronH8.h.metrics.warmMedianMs} ms` : "not recorded"} | ${DEFERRED} | Electron: medians of 3 from ${cell(electronH8?.file ?? "no file")}; cold = empty profile, OS file cache not flushed |`);
out(`| Memory after 60 s of the scene (H9) | ${DEFERRED} (the Task 5 attempts were INVALID) | ${DEFERRED} | no number is reported |`);

out();
out("## Not tested");
out();
out("These have no run, so none of them is verified. Each reason is the actual state of this spike.");
out();
out("| Platform or item | Status | Reason |");
out("| --- | --- | --- |");
out("| Windows on real hardware (any GPU) | not tested | no Windows machine is available |");
out("| Windows, GitHub-hosted runner, no GPU | not tested | the optional non-GPU CI job was not added: the spike runner's process accounting is macOS-only, and a `workflow_dispatch` workflow can only be started once its file is on the default branch, and merging to `main` was out of scope. Even if run, it would prove install and non-GPU storage checks only, never game compatibility |");
out("| Linux | not tested | no Linux machine is available |");
out("| Other Macs, other macOS versions, other displays | not tested | one machine only |");
out("| Tauri 2 with WKWebView (H17, H18) | not tested | not run, decision-irrelevant (owner-approved scope change): per the decision rules Tauri wins only by passing a criterion Electron fails, Electron passed all fatal criteria measured so far except H7 (deferred to Phase 1), which Tauri cannot replace; and the save-transfer mechanism (ADR-0005) needs CDP, which WKWebView is assumed to lack (Assumed, runtime-and-storage.md sections 3 and 9) |");
out("| Gamepad input | not tested | no hardware |");
out("| Real Emscripten or Unity builds, heavy ports of commercial games | not tested | none is available; `progress-lab` only imitates the IDBFS layout. Their completeness is unproven |");
process.stdout.write(`${lines.join("\n")}\n`);
