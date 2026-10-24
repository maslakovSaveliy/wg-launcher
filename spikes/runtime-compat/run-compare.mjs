// THROWAWAY spike runner (runtime-compat, Task 6). Not product code.
//
//   node run-compare.mjs [--only=<group,...>] [--skip=<group,...>] [--fixture-port=4417] [--spike-port=4418]
//
// Non-timing checks of the Chrome baseline (H19), Chrome --app per-game profiles (H20), the Safari
// WebKit proxy and the public demos (H21). Timing (H7, H8, H9, demo frame time) is run-timing.mjs.
// Groups: chrome (installed Chrome via Playwright), chromium (Playwright's bundled Chromium, a
// same-engine reference, not the baseline), app, safari, demos. Each group writes its own aggregate
// results/<runtime>-<version>-<UTC timestamp>.json (kind "run") and validates it against the schema.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { group as appGroup } from "./groups/app.mjs";
import { group as demosGroup } from "./groups/demos.mjs";
import { group as playwrightGroup } from "./groups/playwright-probe.mjs";
import { group as safariGroup } from "./groups/safari.mjs";
import {
  RESULTS,
  ROOT,
  createRun,
  electronEnvironment,
  iso,
  killProcessesWithin,
  log,
  machineInfo,
  processesMatching,
  validateFiles,
  writeAggregate,
} from "./common.mjs";

const ALL = ["chrome", "chromium", "app", "safari", "demos"];
const { values: opts } = parseArgs({
  options: {
    only: { type: "string" },
    skip: { type: "string" },
    "fixture-port": { type: "string", default: "4417" },
    "spike-port": { type: "string", default: "4418" },
    "keep-temp": { type: "boolean", default: false },
    "h20-3-observation": { type: "string" },
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

const run = createRun({ fixturePort: Number(opts["fixture-port"]), spikePort: Number(opts["spike-port"]) });
const startedAt = iso();
const machine = machineInfo();
log(`run-compare: groups ${groups.join(" ")}; ${machine.osVersion}, ${machine.cpu}, ${machine.power}, screen locked: ${machine.screenLockedAtStart}`);

/** Electron results of Task 5 that Chrome is compared with (latest aggregate with a GPU group). */
function electronReference() {
  const files = readdirSync(RESULTS).filter((f) => /^electron-.*\.json$/.test(f)).sort();
  for (const f of files.reverse()) {
    const data = JSON.parse(readFileSync(join(RESULTS, f), "utf8"));
    const gpuRun = data.kind === "run" ? data.checks?.gpu?.runs?.at(-1) : null;
    const checks = gpuRun?.output?.result?.probe?.result?.data?.checks;
    if (checks?.webgpu) {
      return {
        file: f,
        electronVersion: data.runtime.version,
        chromium: data.runtime.chromium,
        webgpu: checks.webgpu,
        webgl2: checks.webgl2,
        displayRefreshHz: data.machine?.displayRefreshHz ?? null,
      };
    }
  }
  return null;
}

const context = { run, opts, machine, electronReference, log };
const written = [];
let fatal = null;
try {
  await run.startServers();
  const env = await electronEnvironment(run);
  machine.displayRefreshHz = env?.display?.displayFrequency ?? null;
  context.electronEnv = env;
  const runners = { chrome: () => playwrightGroup(context, "chrome"), chromium: () => playwrightGroup(context, "chromium"), app: () => appGroup(context), safari: () => safariGroup(context), demos: () => demosGroup(context) };
  for (const name of groups) {
    log(`group ${name}`);
    let outcome;
    try {
      outcome = await runners[name]();
    } catch (error) {
      log(`  group ${name} ERROR ${error.message}`);
      outcome = { runtime: { name: `${name}-error`, version: "unknown" }, label: `${name} group failed`, hypotheses: { H21: { status: "INVALID", reason: `group ${name} failed: ${run.sanitize(error.message).slice(0, 300)}` } }, checks: { error: run.sanitize(String(error.stack ?? error)) }, probeFiles: [] };
    }
    const processes = processesMatching((c) => c.includes(run.tmp));
    const files = writeAggregate(run, {
      runtime: outcome.runtime,
      label: outcome.label,
      machine,
      startedAt,
      groups: [name],
      hypotheses: outcome.hypotheses,
      checks: outcome.checks,
      probeFiles: outcome.probeFiles,
      leftoverProcesses: { processesWithTempDirInCommand: processes.length, ...outcome.leftoverProcesses },
      extra: outcome.extra,
    });
    written.push(files.rel);
    log(`  wrote ${files.rel}${files.schemaError ? ` SCHEMA INVALID: ${files.schemaError}` : ""}`);
    for (const [id, h] of Object.entries(outcome.hypotheses)) log(`  ${id.padEnd(8)} ${h.status.padEnd(12)} ${h.reason}`);
    const allProbeFiles = outcome.probeFiles ?? [];
    for (const bad of validateFiles(allProbeFiles)) log(`  probe file SCHEMA INVALID ${bad.file}: ${bad.error}`);
  }
} catch (error) {
  fatal = String(error.stack ?? error);
  log(`FATAL ${fatal}`);
} finally {
  run.stopServers();
  const leaked = await killProcessesWithin(run.tmp);
  if (leaked) log(`WARNING: ${leaked} process(es) of this run could not be stopped`);
  if (!opts["keep-temp"]) rmSync(run.tmp, { recursive: true, force: true });
}
console.log(`\nwritten: ${written.join(", ") || "nothing"}`);
process.exit(fatal ? 1 : 0);
