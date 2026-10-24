// THROWAWAY spike (runtime-compat, Task 6). H21 public demos, load and console check in Electron and
// Chrome (no frame-time sampling here: run-timing.mjs does that in the hands-off phase).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, chromeVersion } from "../common.mjs";
import { runDemoChrome, runDemoElectron } from "./demo-lib.mjs";

export const demoConfig = () => JSON.parse(readFileSync(join(ROOT, "demos.json"), "utf8"));

export async function group(context) {
  const { run, log, electronEnv } = context;
  const config = demoConfig();
  const settings = { settleMs: config.settleMs, warmupMs: config.warmupMs, durationMs: 0, vsyncHz: electronEnv?.display?.displayFrequency ?? null };
  const rows = [];
  for (const demo of config.demos) {
    for (const [name, fn] of [["electron", runDemoElectron], ["chrome", runDemoChrome]]) {
      const row = await fn(run, demo, settings);
      rows.push(row);
      log(`  ${demo.id} in ${name}: loaded ${row.loadOk}${row.unreachable ? " (unreachable)" : ""}, canvases ${row.canvases}, webgpuUsed ${row.webgpuUsed}, console errors ${row.consoleErrors}`);
    }
  }
  const byDemo = {};
  for (const row of rows) (byDemo[row.id] ??= {})[row.runtime.split("-")[0]] = row;
  const findings = [];
  for (const [id, pair] of Object.entries(byDemo)) {
    const e = pair.electron;
    const c = pair.chrome;
    if (e?.unreachable || c?.unreachable) findings.push(`${id}: not tested (unreachable)`);
    else if (e && c) {
      const worksInChrome = c.loadOk && c.canvases > 0;
      const worksInElectron = e.loadOk && e.canvases > 0;
      if (worksInChrome && !worksInElectron) findings.push(`${id}: works in Chrome, FAILS in Electron`);
      else if (!worksInChrome && worksInElectron) findings.push(`${id}: fails in Chrome, works in Electron`);
      else if (e.webgpuUsed !== c.webgpuUsed) findings.push(`${id}: WebGPU used in ${e.webgpuUsed ? "Electron only" : "Chrome only"}`);
      else if (e.consoleErrors - e.faviconErrors !== c.consoleErrors - c.faviconErrors) findings.push(`${id}: console errors differ (Electron ${e.consoleErrors}, Chrome ${c.consoleErrors}, favicon errors excluded)`);
      else findings.push(`${id}: same in both (loaded ${e.loadOk}, WebGPU used ${e.webgpuUsed}, console errors Electron ${e.consoleErrors} and Chrome ${c.consoleErrors}${c.faviconErrors || e.faviconErrors ? `; of these ${e.faviconErrors} and ${c.faviconErrors} are /favicon.ico 404s, which only Chrome requests` : ""})`);
    }
  }
  const electronVersion = rows.find((r) => r.runtime.startsWith("electron"))?.runtime.replace("electron-", "") ?? "unknown";
  return {
    runtime: { name: "demos", version: `electron-${electronVersion}_chrome-${chromeVersion()}` },
    label: "Public demos (H21): load and console check in Electron and Chrome, no frame time",
    hypotheses: { H21: { status: "REPORTED", reason: findings.join("; "), metrics: { settings: { settleMs: settings.settleMs }, demos: config.demos.map((d) => d.id) } } },
    checks: { configFile: "demos.json", fixedOn: config.fixedOn, rows },
    probeFiles: [],
    leftoverProcesses: {},
  };
}
