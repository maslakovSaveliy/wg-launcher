// THROWAWAY spike (runtime-compat, Task 6). One public demo (H21) in Electron or in Chrome, with
// the same injected hooks (probe/demo-hooks.js), the same console-error counting through CDP and the
// same window size. durationMs 0 = load and console check only; > 0 adds the rAF sampler (indicative
// only: external pages are not calibrated).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, frameStats, launchElectron, launchPlaywrightBrowser, sleep } from "../common.mjs";

const HOOKS = readFileSync(join(ROOT, "probe", "demo-hooks.js"), "utf8");
const UNREACHABLE = /ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_(REFUSED|RESET|TIMED_OUT|CLOSED)|TIMED_OUT|NETWORK_CHANGED|ADDRESS_UNREACHABLE|PROXY)/;

function sampleVisibility(log, whole) {
  // Judge from "sample-start"; without sampling, from "focus-ready" (or "focus-timeout"); never from the
  // "init" entry, which is written before a new window has focus.
  let start = log.findIndex((e) => e.event === "sample-start");
  let from = "sample-start";
  if (start < 0) {
    start = log.findLastIndex((e) => e.event === "focus-ready" || e.event === "focus-timeout");
    from = start >= 0 ? log[start].event : "whole log";
  }
  const since = start >= 0 ? log.slice(start) : log;
  return {
    everHidden: since.some((e) => e.visibilityState !== "visible"),
    everUnfocused: since.some((e) => !e.hasFocus),
    judgedFrom: from,
    wholeLoad: { everHidden: whole.everHidden, everUnfocused: whole.everUnfocused },
  };
}

function normalize(raw, runtimeLabel, demo, vsyncHz) {
  const c = raw.console ?? {};
  const snap = raw.snapshotEnd ?? raw.snapshot;
  const gpu = snap?.webgpu;
  const vsyncMs = vsyncHz ? 1000 / vsyncHz : null;
  const sampled = raw.sample?.deltasMs ?? null;
  return {
    runtime: runtimeLabel,
    id: demo.id,
    url: demo.url,
    loadOk: raw.loadOk,
    unreachable: raw.loadOk ? false : UNREACHABLE.test(raw.loadError ?? ""),
    loadError: raw.loadError ?? null,
    loadMs: raw.loadMs ?? null,
    title: snap?.title ?? null,
    finalUrl: snap?.href ?? null,
    canvases: snap?.canvases ?? null,
    canvasContexts: snap?.contexts ?? null,
    webgpu: gpu ? { navigatorGpu: gpu.navigatorGpu, requestAdapterCalls: gpu.requestAdapterCalls, adapters: gpu.adapters, nullAdapters: gpu.nullAdapters, requestDeviceCalls: gpu.requestDeviceCalls, devices: gpu.devices, errors: gpu.errors } : null,
    webgpuUsed: gpu ? gpu.devices > 0 || (snap.contexts ?? []).some((x) => x.type === "webgpu" && x.ok) : null,
    consoleErrors: (c.consoleErrors ?? 0) + (c.exceptions ?? 0) + (c.logErrors ?? 0),
    // Chrome requests /favicon.ico (a 404 on these sites logs an error); an Electron BrowserWindow does not.
    faviconErrors: (c.messages ?? []).filter((m) => /favicon\.ico/.test(m.text)).length,
    consoleErrorBreakdown: { consoleError: c.consoleErrors ?? 0, exceptions: c.exceptions ?? 0, logErrors: c.logErrors ?? 0, consoleWarnings: c.consoleWarnings ?? 0 },
    consoleMessagesSample: c.messages ?? [],
    // Early in the load the window may not have focus yet; what counts for a timing run is the log from
    // the start of the sampling window (the "sample-start" entry) to its end.
    visibility: snap?.visibility ? sampleVisibility(snap.visibility.log, snap.visibility) : null,
    viewport: raw.sample?.viewport ?? snap?.viewport ?? null,
    vsyncHz,
    stats: sampled ? frameStats(sampled, vsyncMs) : null,
    deltasMs: sampled && sampled.length <= 4000 ? sampled.map((d) => Math.round(d * 1000) / 1000) : null,
  };
}

export async function runDemoElectron(run, demo, { settleMs, warmupMs, durationMs, vsyncHz }) {
  const launch = await launchElectron(
    run,
    "demo",
    [`--url=${demo.url}`, `--settle-ms=${settleMs}`, `--warmup-ms=${warmupMs}`, `--duration=${durationMs}`],
    { timeoutMs: settleMs + warmupMs + durationMs + 120000 },
  );
  const result = launch.output?.result;
  if (!result) {
    return { runtime: "electron", id: demo.id, url: demo.url, loadOk: false, unreachable: false, loadError: `no result: ${launch.output?.error?.split("\n")[0] ?? launch.exit.signal ?? launch.exit.code}`, consoleErrors: null };
  }
  const environment = launch.output.environment;
  return { ...normalize(result, `electron-${environment?.versions?.electron ?? "?"}`, demo, vsyncHz), launchMs: launch.durationMs };
}

export async function runDemoChrome(run, demo, { settleMs, warmupMs, durationMs, vsyncHz, channel = "chrome" }) {
  const browser = await launchPlaywrightBrowser({ channel });
  try {
    const { cdp, page } = browser;
    const collected = { consoleErrors: 0, consoleWarnings: 0, exceptions: 0, logErrors: 0, messages: [] };
    const keep = (kind, text) => {
      if (collected.messages.length < 12) collected.messages.push({ kind, text: String(text).slice(0, 300) });
    };
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const text = (params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      if (params.type === "error") {
        collected.consoleErrors++;
        keep("console.error", text);
      } else if (params.type === "warning") collected.consoleWarnings++;
    });
    cdp.on("Runtime.exceptionThrown", (params) => {
      collected.exceptions++;
      keep("exception", params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text);
    });
    cdp.on("Log.entryAdded", (params) => {
      if (params.entry?.level === "error") {
        collected.logErrors++;
        keep(`log.${params.entry.source}`, `${params.entry.text} ${params.entry.url ?? ""}`);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOKS });
    const started = Date.now();
    let loadOk = true;
    let loadError = null;
    try {
      await page.goto(demo.url, { waitUntil: "load", timeout: 60000 });
    } catch (error) {
      loadOk = false;
      loadError = String(error.message ?? error).split("\n")[0].slice(0, 300);
    }
    const loadMs = Date.now() - started;
    await sleep(settleMs);
    if (loadOk) {
      await page.bringToFront().catch(() => {});
      await page.evaluate("window.__wgDemo ? window.__wgDemo.waitFocus(5000) : null").catch(() => null);
    }
    const snapshot = loadOk ? await page.evaluate("window.__wgDemo ? window.__wgDemo.snapshot() : null").catch(() => null) : null;
    let sample = null;
    if (loadOk && durationMs > 0) sample = await page.evaluate(`window.__wgDemo.sample(${durationMs}, ${warmupMs})`);
    const snapshotEnd = loadOk && durationMs > 0 ? await page.evaluate("window.__wgDemo.snapshot()").catch(() => null) : null;
    const raw = { loadOk, loadMs, loadError, console: collected, snapshot, snapshotEnd, sample };
    return { ...normalize(raw, `${channel === "chrome" ? "chrome" : "chromium"}-${browser.version}`, demo, vsyncHz), launchMs: browser.launchedMs };
  } finally {
    await browser.close();
  }
}
