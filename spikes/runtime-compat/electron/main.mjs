// THROWAWAY spike (runtime-compat): Electron 45 checks for spikes/runtime-compat/HYPOTHESES.md.
// Not product code. One check ("mode") per launch, driven by ../run.mjs:
//
//   electron . --mode=<mode> --out=<file.json> [--wg-user-data=<dir>] [--fixture-port=4417]
//              [--spike-port=4418] [mode options]
//
// The final result is written synchronously to --out; progress events go to stdout as
// "WGSPIKE {json}" lines (the runner reacts to some of them, e.g. to SIGKILL in H2b).
// Game and probe windows always run with sandbox on, context isolation on and no preload.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, screen, session, utilityProcess } from "electron";

const HERE = import.meta.dirname;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (match) out[match[1]] = match[2] ?? true;
  }
  return out;
}

const args = parseArgs(process.argv);
const MODE = args.mode ?? "probe";
const FIXTURE = Number(args["fixture-port"] ?? 4417);
const SPIKE = Number(args["spike-port"] ?? 4418);
const WORLD = 1001; // isolated world id for our code (>= 1000; 999 is Electron's preload world)
const STUB_PATH = "/__wg_quiescent__";
const SNAPSHOT_LIB = readFileSync(join(HERE, "isolated-snapshot.js"), "utf8");

// ---- Before ready ------------------------------------------------------------------------------

const userData = args["wg-user-data"] ?? mkdtempSync(join(tmpdir(), "wgspike-ud-"));
app.setPath("userData", userData);
if (args.uncapped) {
  // H7b: frame-rate limit and vsync off (Chromium switches; their effect is measured, not assumed).
  app.commandLine.appendSwitch("disable-frame-rate-limit");
  app.commandLine.appendSwitch("disable-gpu-vsync");
}
if (args["unsafe-webgpu"]) app.commandLine.appendSwitch("enable-unsafe-webgpu");
const disableFeaturesAtStart = app.commandLine.getSwitchValue("disable-features") || null;
if (args["restore-partitioning"] && disableFeaturesAtStart) {
  // Playwright's Electron loader appends --disable-features=...,ThirdPartyStoragePartitioning,...
  // before this file runs; re-append the list without it (the last value of a switch wins).
  const kept = disableFeaturesAtStart.split(",").filter((f) => f !== "ThirdPartyStoragePartitioning");
  app.commandLine.appendSwitch("disable-features", kept.join(","));
}

const processWarnings = [];
process.on("warning", (w) => processWarnings.push({ name: w.name, message: w.message }));

// Each mode quits by itself; closing the last window must not end a multi-window check.
app.on("window-all-closed", () => {});

// ---- Small helpers -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nonce = () => randomBytes(6).toString("hex");
const iso = () => new Date().toISOString();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const trace = (msg, data = {}) => {
  if (args.trace) emit("trace", { msg, ...data });
};

function emit(type, data = {}) {
  process.stdout.write(`WGSPIKE ${JSON.stringify({ type, mode: MODE, t: Date.now(), ...data })}\n`);
}

async function waitFor(fn, { timeout = 30000, interval = 100, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > end) {
      throw new Error(`timeout waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ""}`);
    }
    await sleep(interval);
  }
}

async function environment() {
  const display = screen.getPrimaryDisplay();
  const gpu = await app.getGPUInfo("basic").catch((error) => ({ error: String(error) }));
  return {
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    os: { platform: process.platform, arch: process.arch, systemVersion: process.getSystemVersion() },
    display: {
      displayFrequency: display.displayFrequency,
      size: display.size,
      scaleFactor: display.scaleFactor,
      colorDepth: display.colorDepth,
      count: screen.getAllDisplays().length,
    },
    gpu: {
      devices: gpu.gpuDevice ?? null,
      machineModelName: gpu.machineModelName ?? null,
      machineModelVersion: gpu.machineModelVersion ?? null,
    },
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    switches: {
      disableFeaturesAtStart,
      disableFeatures: app.commandLine.getSwitchValue("disable-features") || null,
      restorePartitioning: !!args["restore-partitioning"],
      enableFeatures: app.commandLine.getSwitchValue("enable-features") || null,
      uncapped: !!args.uncapped,
      unsafeWebgpu: !!args["unsafe-webgpu"],
    },
  };
}

function makeWindow({ partition, show = false, width = 1280, height = 720, preload, subframes = false }) {
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show,
    backgroundColor: "#111111",
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: subframes,
      backgroundThrottling: show, // hidden check windows must not be throttled
      ...(preload ? { preload } : {}),
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return win;
}

function bringToFront(win) {
  win.show();
  app.focus({ steal: true });
  win.focus();
}

async function closeWindow(win) {
  if (win.isDestroyed()) return;
  const closed = new Promise((resolve) => win.once("closed", resolve));
  win.close();
  await closed;
}

const fixtureUrl = (host, path = "/") => `http://${host}:${FIXTURE}${path}`;
const iframeHostUrl = () =>
  fixtureUrl("localhost", `/iframe-host.html?src=${encodeURIComponent(fixtureUrl("127.0.0.1", "/"))}`);

function findChildFrame(win, prefix) {
  return waitFor(() => win.webContents.mainFrame.frames.find((f) => f.url.startsWith(prefix)), {
    label: `frame ${prefix}`,
  });
}

/** Reads the fixture's state once data-ready is final. `target` is a WebContents or WebFrameMain. */
function gameState(target) {
  return waitFor(
    async () => {
      const s = await target.executeJavaScript(`(() => {
        const h = document.querySelector('#progress-hash');
        const b = document.querySelector('#play-step');
        const e = document.querySelector('#error');
        if (!h || !b) return null;
        return { ready: h.dataset.ready, hash: h.textContent, enabled: !b.disabled,
          level: document.querySelector('#level').textContent, coins: document.querySelector('#coins').textContent,
          error: e && !e.hidden ? e.textContent : null, href: location.href };
      })()`);
      return s && s.ready !== "false" && s.enabled && s.hash ? s : null;
    },
    { label: "game data-ready", timeout: 30000 },
  );
}

async function playSteps(target, steps) {
  await gameState(target);
  await target.executeJavaScript(
    `(() => { const b = document.querySelector('#play-step'); for (let i = 0; i < ${steps}; i++) b.click(); return true; })()`,
  );
  return gameState(target);
}

async function waitProbe(wc, timeout) {
  return waitFor(
    async () => {
      const s = await wc.executeJavaScript(
        "window.wgProbe ? { state: wgProbe.state, file: wgProbe.file, error: wgProbe.error, result: wgProbe.result } : null",
      );
      return s && (s.state === "posted" || s.state === "error") ? s : null;
    },
    { timeout, interval: 250, label: "probe result" },
  );
}

// ---- Isolated-world execution (main frame: webContents API; subframe: preload + webFrame) ------

let isolatedSeq = 0;
const isolatedPending = new Map();
ipcMain.on("wg:isolated-result", (_event, message) => {
  const resolve = isolatedPending.get(message.id);
  if (resolve) {
    isolatedPending.delete(message.id);
    resolve(message);
  }
});

function wrapIsolated(body) {
  return `(async () => { try { ${SNAPSHOT_LIB}
    const value = await (async () => { ${body} })();
    return JSON.stringify({ ok: true, value });
  } catch (error) { return JSON.stringify({ ok: false, error: String((error && error.stack) || error) }); } })()
//# sourceURL=wg-isolated-world`;
}

async function inIsolatedWorld(target, body) {
  const code = wrapIsolated(body);
  let raw;
  let via;
  // WebContents has executeJavaScriptInIsolatedWorld; WebFrameMain (a subframe) does not.
  if (typeof target.executeJavaScriptInIsolatedWorld === "function") {
    via = "webContents.executeJavaScriptInIsolatedWorld";
    trace("isolated:main:start");
    raw = await withTimeout(target.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]), 30000, via);
    trace("isolated:main:done");
  } else {
    via = "preload webFrame.executeJavaScriptInIsolatedWorld (subframe)";
    const id = ++isolatedSeq;
    const reply = new Promise((resolve) => isolatedPending.set(id, resolve));
    target.send("wg:isolated", { id, code, worldId: WORLD });
    const message = await Promise.race([
      reply,
      sleep(30000).then(() => ({ error: "isolated-world call timed out" })),
    ]);
    if (message.error) throw new Error(message.error);
    raw = message.result;
  }
  if (typeof raw !== "string") throw new Error(`isolated world returned ${typeof raw} via ${via}`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(`isolated world error: ${parsed.error}`);
  return { value: parsed.value, worldId: WORLD, via };
}

// ---- Quiescent window (H14, H16) -------------------------------------------------------------

const gameHosts = () => new Set([`localhost:${FIXTURE}`, `127.0.0.1:${FIXTURE}`]);

function stubHtml(requestUrl) {
  const url = new URL(requestUrl);
  let iframe = "";
  const frame = url.searchParams.get("frame");
  if (frame) {
    const frameUrl = new URL(frame);
    if (frameUrl.pathname === STUB_PATH && gameHosts().has(frameUrl.host)) {
      iframe = `<iframe id="wg-frame" src="${frameUrl.href.replace(/"/g, "&quot;")}"></iframe>`;
    }
  }
  return `<!doctype html><html data-wg-stub="1"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>wg quiescent stub</title></head><body>${iframe}</body></html>`;
}

/**
 * Opens a hidden window on `partition` whose documents are our empty stubs at the game origin(s),
 * served by ses.protocol.handle, with the service worker bypassed through CDP before navigating.
 * Records every request, every parsed script (with its execution context) and SW activity.
 */
async function openQuiescent({ partition, iframe = false, bypass = true, host = "localhost" }) {
  const ses = session.fromPartition(partition);
  const handlerLog = [];
  const webRequestLog = [];
  const swEvents = [];
  ses.protocol.handle("http", (request) => {
    const url = new URL(request.url);
    const stub = gameHosts().has(url.host) && url.pathname === STUB_PATH;
    handlerLog.push({ t: iso(), url: request.url, served: stub ? "stub" : "passthrough" });
    if (stub) {
      return new Response(stubHtml(request.url), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          // Belt and braces: no main-world script may run in the stub, ours included.
          "Content-Security-Policy": "script-src 'none'; object-src 'none'; base-uri 'none'",
        },
      });
    }
    return ses.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    webRequestLog.push({ t: iso(), url: details.url, resourceType: details.resourceType });
    callback({});
  });
  const onSw = (details) =>
    swEvents.push({ t: iso(), versionId: details.versionId, runningStatus: details.runningStatus });
  ses.serviceWorkers.on("running-status-changed", onSw);
  const runningBefore = Object.values(ses.serviceWorkers.getAllRunning()).map((w) => ({
    scope: w.scope,
    scriptUrl: w.scriptUrl,
  }));

  const win = makeWindow({
    partition,
    show: false,
    preload: join(HERE, "quiescent-preload.cjs"),
    subframes: iframe,
  });
  const wc = win.webContents;
  const cdp = { scripts: [], contexts: [], targets: [], errors: [], bypass };
  // A webContents that has never navigated has no renderer, and CDP commands wait for one:
  // commit about:blank first (no network, no game origin), then attach.
  await withTimeout(win.loadURL("about:blank"), 10000, "about:blank");
  const dbg = wc.debugger;
  dbg.attach("1.3");
  const send = async (method, params, sessionId) => {
    trace(`cdp:${method}`, { sessionId: sessionId ?? "main" });
    const result = await dbg.sendCommand(method, params, sessionId);
    trace(`cdp:${method}:ok`);
    return result;
  };
  const setupSession = async (sessionId) => {
    await send("Network.enable", {}, sessionId);
    if (bypass) await send("Network.setBypassServiceWorker", { bypass: true }, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Debugger.enable", {}, sessionId);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  };
  dbg.on("message", (_event, method, params, sessionId) => {
    const sid = sessionId || "main";
    if (method === "Debugger.scriptParsed") {
      cdp.scripts.push({
        sessionId: sid,
        url: params.url,
        executionContextId: params.executionContextId,
        length: params.length,
        aux: params.executionContextAuxData ?? null,
      });
    } else if (method === "Runtime.executionContextCreated") {
      cdp.contexts.push({
        sessionId: sid,
        id: params.context.id,
        origin: params.context.origin,
        name: params.context.name,
        aux: params.context.auxData ?? null,
      });
    } else if (method === "Target.attachedToTarget") {
      const info = params.targetInfo;
      cdp.targets.push({ sessionId: params.sessionId, type: info.type, url: info.url, targetId: info.targetId });
      setupSession(params.sessionId)
        .then(() => dbg.sendCommand("Runtime.runIfWaitingForDebugger", {}, params.sessionId))
        .catch((error) => cdp.errors.push(`${info.type}: ${error.message}`));
    }
  });
  trace("quiescent:debugger attached");
  await withTimeout(setupSession(undefined), 10000, "CDP setup");
  trace("quiescent:cdp ready");

  const frameUrl = fixtureUrl("127.0.0.1", `${STUB_PATH}?role=frame`);
  const topUrl = iframe
    ? fixtureUrl("localhost", `${STUB_PATH}?frame=${encodeURIComponent(frameUrl)}`)
    : fixtureUrl(host, STUB_PATH);
  const t0 = iso();
  trace("quiescent:loadURL", { topUrl });
  await withTimeout(win.loadURL(topUrl), 20000, `loadURL ${topUrl}`);
  trace("quiescent:loaded");
  let frame = null;
  if (iframe) {
    frame = await findChildFrame(win, fixtureUrl("127.0.0.1", STUB_PATH));
    // The subframe preload must be listening; retry a trivial call until it answers.
    await waitFor(
      () =>
        inIsolatedWorld(frame, "return location.href;")
          .then(() => true)
          .catch(() => false),
      { timeout: 10000, label: "subframe preload" },
    );
  }

  async function storageKeys() {
    const keys = {};
    try {
      const tree = await dbg.sendCommand("Page.getFrameTree");
      keys.main = (await dbg.sendCommand("Storage.getStorageKey", { frameId: tree.frameTree.frame.id })).storageKey;
    } catch (error) {
      keys.mainError = error.message;
    }
    const child = cdp.targets.find((t) => t.type === "iframe");
    if (child) {
      try {
        keys.iframe = (
          await dbg.sendCommand("Storage.getStorageKey", { frameId: child.targetId }, child.sessionId)
        ).storageKey;
      } catch (error) {
        keys.iframeError = error.message;
      }
    }
    return keys;
  }

  async function mainWorldCanary(target) {
    // Reads (never writes) the stub's main world: game.js would have defined window.progressLab.
    return JSON.parse(
      await withTimeout(target.executeJavaScript(
        "JSON.stringify({ progressLab: typeof window.progressLab, scripts: document.scripts.length, stub: document.documentElement.dataset.wgStub || null, href: location.href })\n//# sourceURL=wg-main-world-canary",
      ), 10000, "main-world canary"),
    );
  }

  async function close() {
    const t1 = iso();
    try {
      dbg.detach();
    } catch {}
    await closeWindow(win);
    ses.protocol.unhandle("http");
    ses.webRequest.onBeforeRequest(null);
    ses.serviceWorkers.off("running-status-changed", onSw);
    return {
      t0,
      t1,
      topUrl,
      handlerLog,
      webRequestLog,
      swEvents,
      runningBefore,
      cdp,
      windowsAfterClose: BrowserWindow.getAllWindows().length,
    };
  }

  return { win, wc, ses, frame, target: frame ?? wc, storageKeys, mainWorldCanary, close };
}

/** Evaluates the quiescent-window evidence: no game code may have run there. */
function judgeQuiescence(logs, inventories, mainWorld) {
  const contextKey = (c) => `${c.sessionId}:${c.id}`;
  const contexts = new Map(logs.cdp.contexts.map((c) => [contextKey(c), c]));
  const scripts = logs.cdp.scripts.map((s) => {
    const ctx = contexts.get(`${s.sessionId}:${s.executionContextId}`);
    return { ...s, contextType: ctx?.aux?.type ?? null, isDefault: ctx?.aux?.isDefault ?? null };
  });
  const problems = [];
  // Our own read-only canary is the only code we run in a main world; it is tagged by sourceURL.
  const mainWorldScripts = scripts.filter((s) => s.isDefault === true && s.url !== "wg-main-world-canary");
  if (mainWorldScripts.length) problems.push(`scripts parsed in a main world: ${mainWorldScripts.length}`);
  const gameScripts = scripts.filter((s) => /game\.js|sw\.js/.test(s.url));
  if (gameScripts.length) problems.push(`game scripts parsed: ${gameScripts.map((s) => s.url).join(", ")}`);
  const passthroughGame = logs.handlerLog.filter((e) => e.served !== "stub" && gameHosts().has(new URL(e.url).host));
  if (passthroughGame.length) problems.push(`game-origin requests passed through: ${passthroughGame.map((e) => e.url).join(", ")}`);
  const nonStubRequests = logs.webRequestLog.filter((e) => !new URL(e.url).pathname.startsWith(STUB_PATH));
  if (nonStubRequests.length) problems.push(`non-stub requests: ${nonStubRequests.map((e) => e.url).join(", ")}`);
  const swStarts = logs.swEvents.filter((e) => e.runningStatus === "starting" || e.runningStatus === "running");
  if (swStarts.length) problems.push(`service worker started/running during window: ${swStarts.length}`);
  const swTargets = logs.cdp.targets.filter((t) => t.type === "service_worker");
  if (swTargets.length) {
    const preExisting = logs.runningBefore.length > 0;
    problems.push(
      `service worker targets attached: ${swTargets.length} (workers already running before the window: ${logs.runningBefore.length})${preExisting ? " [pre-existing]" : ""}`,
    );
  }
  for (const inv of inventories) {
    if (!inv.stub) problems.push(`document is not our stub: ${inv.href}`);
    if (inv.controller) problems.push(`document has a service-worker controller: ${inv.href}`);
    if (inv.scripts !== 0) problems.push(`stub has ${inv.scripts} script elements`);
  }
  for (const mw of mainWorld) {
    if (mw.progressLab !== "undefined") problems.push(`window.progressLab is ${mw.progressLab} in ${mw.href}`);
  }
  return {
    clean: problems.length === 0,
    problems,
    scriptsParsed: scripts.map((s) => ({ url: s.url, sessionId: s.sessionId, contextType: s.contextType, isDefault: s.isDefault })),
    requests: logs.webRequestLog.map((e) => e.url),
    handler: logs.handlerLog.map((e) => `${e.served} ${e.url}`),
    swEvents: logs.swEvents,
    targets: logs.cdp.targets.map((t) => ({ type: t.type, url: t.url })),
    cdpErrors: logs.cdp.errors,
    bypass: logs.cdp.bypass,
    runningBefore: logs.runningBefore,
  };
}

async function quiescentExport(partition, { iframe = false } = {}) {
  const q = await openQuiescent({ partition, iframe });
  const inventory = (await inIsolatedWorld(q.target, "return await wgInventory();")).value;
  const exported = await inIsolatedWorld(q.target, "return await wgExport();");
  const storageKeys = await q.storageKeys();
  const mainWorld = [await q.mainWorldCanary(q.wc)];
  const inventories = [inventory];
  if (iframe) {
    mainWorld.push(await q.mainWorldCanary(q.frame));
    inventories.push((await inIsolatedWorld(q.wc, "return await wgInventory();")).value);
  }
  const logs = await q.close();
  const snapshot = { ...exported.value, storageKeys, exporterWorld: exported.worldId, exporterVia: exported.via };
  return { snapshot, inventory, storageKeys, logs, quiescence: judgeQuiescence(logs, inventories, mainWorld) };
}

async function quiescentImport(partition, snapshot, { iframe = false } = {}) {
  const q = await openQuiescent({ partition, iframe });
  const pre = (await inIsolatedWorld(q.target, "return await wgInventory();")).value;
  const imported = (await inIsolatedWorld(q.target, `return await wgImport(${JSON.stringify(snapshot)});`)).value;
  const post = (await inIsolatedWorld(q.target, "return await wgInventory();")).value;
  const storageKeys = await q.storageKeys();
  const mainWorld = [await q.mainWorldCanary(q.wc)];
  if (iframe) mainWorld.push(await q.mainWorldCanary(q.frame));
  const logs = await q.close();
  return { pre, imported, post, storageKeys, logs, quiescence: judgeQuiescence(logs, [pre], mainWorld) };
}

async function quiescentInventory(partition, { iframe = false } = {}) {
  const q = await openQuiescent({ partition, iframe });
  const inventory = (await inIsolatedWorld(q.target, "return await wgInventory();")).value;
  const top = iframe ? (await inIsolatedWorld(q.wc, "return await wgInventory();")).value : null;
  const storageKeys = await q.storageKeys();
  const logs = await q.close();
  return { inventory, top, storageKeys, windowsAfterClose: logs.windowsAfterClose };
}

/** Opens the game in `partition` (top level, or the cross-site iframe pair) and reads its state. */
async function openGameAndRead(partition, { iframe = false, url } = {}) {
  const win = makeWindow({ partition, show: false });
  await win.loadURL(url ?? (iframe ? iframeHostUrl() : fixtureUrl("localhost", "/")));
  const target = iframe ? await findChildFrame(win, fixtureUrl("127.0.0.1", "/")) : win.webContents;
  const state = await gameState(target);
  await closeWindow(win);
  return state;
}

function flipOneByte(snapshot) {
  const copy = structuredClone(snapshot);
  for (const db of copy.indexedDB) {
    for (const store of db.stores) {
      for (const record of store.records) {
        const roll = record.value?.$t === "object" ? record.value.v.roll : null;
        if (roll?.$t === "view" && roll.type === "Uint8Array") {
          const bytes = Buffer.from(roll.b64, "base64");
          bytes[0] ^= 0xff;
          roll.b64 = bytes.toString("base64");
          return { snapshot: copy, flipped: `${db.name}/${store.name} key ${JSON.stringify(record.key)} roll[0]` };
        }
      }
    }
  }
  throw new Error("no Uint8Array to flip in the snapshot");
}

function storeKeys(snapshot, dbName, storeName) {
  const store = snapshot.indexedDB.find((d) => d.name === dbName)?.stores.find((s) => s.name === storeName);
  return store ? store.records.map((r) => r.key) : null;
}

function writeSnapshotFile(label, snapshot) {
  const text = JSON.stringify(snapshot);
  const file = join(userData, `snapshot-${label}.json`);
  writeFileSync(file, text);
  return { bytes: Buffer.byteLength(text), sha256: sha256(text) };
}

async function waitServiceWorkersIdle(partition, timeout) {
  const ses = session.fromPartition(partition);
  const started = Date.now();
  while (Object.keys(ses.serviceWorkers.getAllRunning()).length > 0 && Date.now() - started < timeout) {
    await sleep(500);
  }
  return {
    waitedMs: Date.now() - started,
    stillRunning: Object.values(ses.serviceWorkers.getAllRunning()).map((w) => w.scriptUrl),
  };
}

// ---- Modes -------------------------------------------------------------------------------------

async function modePageProbe() {
  const partition = args.partition ?? `spike:probe-${nonce()}`;
  const ses = session.fromPartition(partition);
  const injected = [];
  if (args["inject-coi"]) {
    // H4: the host adds COOP/COEP (and CORP) to every response of this session.
    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers)) {
        if (/^cross-origin-(opener|embedder|resource)-policy$/i.test(key)) delete headers[key];
      }
      headers["Cross-Origin-Opener-Policy"] = ["same-origin"];
      headers["Cross-Origin-Embedder-Policy"] = ["require-corp"];
      headers["Cross-Origin-Resource-Policy"] = ["same-origin"];
      injected.push({ url: details.url, resourceType: details.resourceType });
      callback({ responseHeaders: headers });
    });
  }
  const win = makeWindow({ partition, show: true });
  bringToFront(win);
  const query = new URLSearchParams({ mode: "probe", runtime: "electron", label: args.label ?? MODE });
  if (args.checks) query.set("checks", args.checks);
  const url = `http://localhost:${SPIKE}${args.path ?? "/"}?${query}`;
  await win.loadURL(url);
  const probe = await waitProbe(win.webContents, 90000);
  await closeWindow(win);
  return { url, partition, injectCoi: !!args["inject-coi"], injected, probe };
}

async function modeFrameTime() {
  const win = makeWindow({ partition: `spike:frametime-${nonce()}`, show: true });
  bringToFront(win);
  const hz = screen.getPrimaryDisplay().displayFrequency;
  const query = new URLSearchParams({
    mode: "frametime",
    runtime: "electron",
    load: String(args.load ?? 64),
    duration: String(args.duration ?? 20000),
    warmup: String(args.warmup ?? 2000),
    vsyncHz: String(hz),
    label: args.label ?? "frametime",
  });
  await win.loadURL(`http://localhost:${SPIKE}/?${query}`);
  const duration = Number(args.duration ?? 20000) + Number(args.warmup ?? 2000);
  const probe = await waitProbe(win.webContents, duration + 60000);
  await closeWindow(win);
  return { displayFrequency: hz, probe };
}

async function modeMemory() {
  const seconds = Number(args.seconds ?? 60);
  const win = makeWindow({ partition: `spike:memory-${nonce()}`, show: true });
  bringToFront(win);
  await win.loadURL(`http://localhost:${SPIKE}/?mode=scene&runtime=electron&load=${args.load ?? 64}`);
  await waitFor(() => win.webContents.executeJavaScript("window.wgProbe && wgProbe.state === 'rendering'"), {
    label: "scene rendering",
  });
  await sleep(seconds * 1000);
  const page = await win.webContents.executeJavaScript(
    "({ frames: wgProbe.frames, visibility: wgProbe.visibility, scene: wgProbe.scene, hidden: document.visibilityState, focus: document.hasFocus() })",
  );
  const metrics = app.getAppMetrics();
  await closeWindow(win);
  const memoryFieldNames = [...new Set(metrics.flatMap((m) => Object.keys(m.memory ?? {})))].sort();
  const sumKiB = (field) => metrics.reduce((sum, m) => sum + (m.memory?.[field] ?? 0), 0);
  return {
    seconds,
    page,
    memoryFieldNames,
    workingSetSumMiB: sumKiB("workingSetSize") / 1024,
    peakWorkingSetSumMiB: sumKiB("peakWorkingSetSize") / 1024,
    processes: metrics.map((m) => ({
      type: m.type,
      name: m.name ?? null,
      serviceName: m.serviceName ?? null,
      workingSetMiB: (m.memory?.workingSetSize ?? 0) / 1024,
      peakWorkingSetMiB: (m.memory?.peakWorkingSetSize ?? 0) / 1024,
    })),
    note: "MemoryInfo values are in KiB (Electron docs); summed over app.getAppMetrics() processes",
  };
}

async function modeColdStart() {
  const readyAt = Date.now();
  const win = makeWindow({ partition: "persist:spike:coldstart", show: true });
  bringToFront(win);
  const query = new URLSearchParams({
    mode: "coldstart",
    runtime: "electron",
    load: String(args.load ?? 64),
    spawn: String(args["spawn-ms"] ?? ""),
    label: args.label ?? "coldstart",
  });
  await win.loadURL(`http://localhost:${SPIKE}/?${query}`);
  const probe = await waitProbe(win.webContents, 30000);
  await closeWindow(win);
  return { readyAtWallMs: readyAt, spawnWallMs: Number(args["spawn-ms"] ?? 0) || null, probe };
}

const KINDS = ["localStorage", "indexedDB", "cookie", "cacheStorage", "opfs"];

function presentKinds(read) {
  return KINDS.filter((k) => read[k] !== null && read[k] !== undefined && !read[k]?.error);
}

function matchingKinds(read, id, value) {
  const expected = `${id}:${value}`;
  const ok = {
    localStorage: read.localStorage === expected,
    indexedDB:
      read.indexedDB?.value === expected &&
      read.indexedDB?.dateIsDate === true &&
      read.indexedDB?.blobText === expected &&
      read.indexedDB?.blobType === "text/plain",
    cookie: read.cookie === expected,
    cacheStorage: read.cacheStorage === expected,
    opfs: read.opfs === expected,
  };
  return KINDS.filter((k) => ok[k]);
}

async function storageWindow(partition) {
  const win = makeWindow({ partition, show: false });
  await win.loadURL(`http://localhost:${SPIKE}/storage.html`);
  await waitFor(() => win.webContents.executeJavaScript("!!window.wgStorage"), { label: "storage page" });
  return win;
}

const storageWrite = (win, id, value, large) =>
  win.webContents.executeJavaScript(`wgStorage.write(${JSON.stringify(id)}, ${JSON.stringify(value)}, { large: ${large} })`);
const storageRead = (win, ids, large) =>
  win.webContents.executeJavaScript(`wgStorage.read(${JSON.stringify(ids)}, { large: ${large} })`);

async function modeH1Write() {
  const nA = nonce();
  const nB = nonce();
  const winA = await storageWindow("persist:spike:a");
  const writeA = await storageWrite(winA, "A", nA, true);
  const winB = await storageWindow("persist:spike:b");
  const bReadsBeforeOwnWrite = await storageRead(winB, ["A", "B"], false);
  const writeB = await storageWrite(winB, "B", nB, true);
  const aReads = await storageRead(winA, ["A", "B"], false);
  const bReads = await storageRead(winB, ["A", "B"], false);
  // Control: a second window on the SAME partition must see all five of A's markers.
  const winA2 = await storageWindow("persist:spike:a");
  const controlReads = await storageRead(winA2, ["A"], false);
  for (const w of [winA, winB, winA2]) await closeWindow(w);
  const state = {
    nonces: { A: nA, B: nB },
    large: { A: writeA.large, B: writeB.large },
  };
  writeFileSync(args.state, JSON.stringify(state));
  return {
    nonces: state.nonces,
    writes: { A: writeA, B: writeB },
    leaks: {
      AtoB: presentKinds(bReadsBeforeOwnWrite.A),
      AtoBAfterBWrote: presentKinds(bReads.A),
      BtoA: presentKinds(aReads.B),
    },
    own: { A: matchingKinds(aReads.A, "A", nA), B: matchingKinds(bReads.B, "B", nB) },
    control: { samePartitionSeesA: matchingKinds(controlReads.A, "A", nA) },
    raw: { bReadsBeforeOwnWrite, aReads, bReads, controlReads },
  };
}

async function modeH2Read() {
  const state = JSON.parse(readFileSync(args.state, "utf8"));
  const winA = await storageWindow("persist:spike:a");
  const winB = await storageWindow("persist:spike:b");
  const aReads = await storageRead(winA, ["A", "B"], true);
  const bReads = await storageRead(winB, ["A", "B"], true);
  for (const w of [winA, winB]) await closeWindow(w);
  const largeOk = (read, written) =>
    read?.blobIsBlob === true &&
    read?.blobSize === 1048576 &&
    read?.blobSha256 === written.blobSha256 &&
    read?.u8IsUint8Array === true &&
    read?.u8Length === 1048576 &&
    read?.u8Sha256 === written.u8Sha256;
  return {
    own: {
      A: matchingKinds(aReads.A, "A", state.nonces.A),
      B: matchingKinds(bReads.B, "B", state.nonces.B),
    },
    large: { A: largeOk(aReads.A.large, state.large.A), B: largeOk(bReads.B.large, state.large.B) },
    leaksAfterRestart: { BinA: presentKinds(aReads.B), AinB: presentKinds(bReads.A) },
    raw: { aReads, bReads },
    written: state,
  };
}

async function modeH2bWrite() {
  const n = nonce();
  const win = await storageWindow("persist:spike:k");
  const written = await storageWrite(win, "K", n, true);
  writeFileSync(args.state, JSON.stringify({ nonce: n, large: written.large }));
  emit("written", { pid: process.pid });
  // Wait for the runner's SIGKILL (5 s after "written"); give up after 30 s.
  await sleep(30000);
  return { error: "not killed" };
}

async function modeH2bRead() {
  const state = JSON.parse(readFileSync(args.state, "utf8"));
  const win = await storageWindow("persist:spike:k");
  const read = await storageRead(win, ["K"], true);
  await closeWindow(win);
  const large = read.K.large;
  return {
    survived: matchingKinds(read.K, "K", state.nonce),
    largeSurvived: {
      blob: large?.blobSha256 === state.large.blobSha256,
      u8: large?.u8Sha256 === state.large.u8Sha256,
    },
    raw: read,
  };
}

async function modeSqlite() {
  const { runSqliteAndZstd } = await import("./sqlite-steps.mjs");
  const main = await runSqliteAndZstd(join(userData, "h10-main.sqlite"));
  const child = utilityProcess.fork(join(HERE, "sqlite-utility.mjs"), [], {
    serviceName: "wgspike-sqlite",
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  const utility = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "utility process timeout" }), 30000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `utility exited with ${code}` });
    });
    child.postMessage({ dbPath: join(userData, "h10-utility.sqlite") });
  });
  child.kill();
  return { main, utility, utilityStderr: stderr.trim() || null };
}

async function trustedClick(wc, id) {
  const point = await wc.executeJavaScript(`wgPerm.buttonRect(${JSON.stringify(id)})`);
  wc.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  wc.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return point;
}

async function trustedEnter(wc, id) {
  await wc.executeJavaScript(`document.querySelector('#${id}').focus()`);
  wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  wc.sendInputEvent({ type: "char", keyCode: "Enter" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
}

async function settleWindow(win) {
  await win.webContents.executeJavaScript("wgPerm.release()").catch(() => null);
  await waitFor(() => !win.isFullScreen(), { timeout: 10000, label: "leave fullscreen" }).catch(() => null);
  await sleep(1200); // macOS fullscreen animation
}

const GESTURE_ORDERS = {
  asSpecified: ["fullscreen", "pointerLock", "keyboardLock"],
  fullscreenOnly: ["fullscreen"],
  pointerLockOnly: ["pointerLock"],
  keyboardLockOnly: ["keyboardLock"],
};
const GESTURE_BUTTONS = {
  asSpecified: "gesture",
  fullscreenOnly: "only-fullscreen",
  pointerLockOnly: "only-pointerLock",
  keyboardLockOnly: "only-keyboardLock",
  pointerLockFirst: "pointer-first",
};

async function modePermissions() {
  const ALLOW = new Set(["fullscreen", "pointerLock", "keyboardLock"]);
  const log = [];
  const partition = `spike:perm-${nonce()}`;
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const allowed = ALLOW.has(permission);
    log.push({
      t: iso(),
      handler: "request",
      permission,
      allowed,
      mediaTypes: details?.mediaTypes ?? null,
      requestingUrl: details?.requestingUrl ?? null,
    });
    callback(allowed);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const allowed = ALLOW.has(permission);
    log.push({ t: iso(), handler: "check", permission, allowed, requestingOrigin, mediaType: details?.mediaType ?? null });
    return allowed;
  });
  const win = makeWindow({ partition, show: true });
  bringToFront(win);
  const wc = win.webContents;
  const fullscreenEvents = [];
  wc.on("enter-html-full-screen", () => fullscreenEvents.push({ t: iso(), event: "enter-html-full-screen" }));
  wc.on("leave-html-full-screen", () => fullscreenEvents.push({ t: iso(), event: "leave-html-full-screen" }));
  await win.loadURL(`http://localhost:${SPIKE}/perm.html`);
  await waitFor(() => wc.executeJavaScript("!!window.wgPerm"), { label: "perm page" });
  await sleep(500);
  const focusAtStart = await wc.executeJavaScript("document.hasFocus()");

  // H13 control first: the same calls from a script, without any user gesture (as specified:
  // all three in one go; diagnostic: each call alone).
  const noGesture = {};
  for (const [label, order] of Object.entries(GESTURE_ORDERS)) {
    noGesture[label] = await wc.executeJavaScript(`wgPerm.lockCalls("script-no-gesture", ${JSON.stringify(order)})`);
    await settleWindow(win);
  }

  // H12: the five sensitive permissions (camera, mic, geolocation, notifications need no gesture).
  const denied = await wc.executeJavaScript("wgPerm.denyBatch()");
  // display-capture needs transient activation: trusted click on #display.
  await trustedClick(wc, "display");
  const display = await waitFor(() => wc.executeJavaScript("wgPerm.state.display"), {
    label: "display result",
    timeout: 15000,
  });

  // H13: trusted mouse input (sendInputEvent) on each button, then trusted Enter key presses.
  const trusted = { mouse: {}, key: {} };
  let fullscreenWhileLocked = null;
  for (const [label, id] of Object.entries(GESTURE_BUTTONS)) {
    await sleep(600);
    await wc.executeJavaScript("wgPerm.state.gesture = null");
    await trustedClick(wc, id);
    trusted.mouse[label] = await waitFor(() => wc.executeJavaScript("wgPerm.state.gesture"), {
      label: `mouse ${label}`,
      timeout: 20000,
    }).catch((error) => ({ error: error.message }));
    if (label === "asSpecified") fullscreenWhileLocked = win.isFullScreen();
    await settleWindow(win);
  }
  for (const label of ["asSpecified", "pointerLockOnly"]) {
    await sleep(600);
    await wc.executeJavaScript("wgPerm.state.gesture = null");
    await trustedEnter(wc, GESTURE_BUTTONS[label]);
    trusted.key[label] = await waitFor(() => wc.executeJavaScript("wgPerm.state.gesture"), {
      label: `key ${label}`,
      timeout: 20000,
    }).catch((error) => ({ error: error.message }));
    await settleWindow(win);
  }
  const clicks = await wc.executeJavaScript("wgPerm.state.clicks");
  await closeWindow(win);

  // H12 control: no handlers at all; Electron approves by default.
  const controlPartition = `spike:perm-control-${nonce()}`;
  const controlSes = session.fromPartition(controlPartition);
  controlSes.setPermissionRequestHandler(null);
  controlSes.setPermissionCheckHandler(null);
  const control = makeWindow({ partition: controlPartition, show: true });
  bringToFront(control);
  await control.loadURL(`http://localhost:${SPIKE}/perm.html`);
  await waitFor(() => control.webContents.executeJavaScript("!!window.wgPerm"), { label: "control page" });
  const controlNotification = await control.webContents.executeJavaScript(
    "Notification.requestPermission().then((r) => ({ result: r, permission: Notification.permission }))",
  );
  await closeWindow(control);

  return {
    focusAtStart,
    noGesture,
    denied: { ...denied, displayCapture: display },
    trusted,
    fullscreenWhileLocked,
    fullscreenEvents,
    clicks,
    handlerLog: log,
    control: controlNotification,
  };
}

/** Cross-site iframe storage partitioning: is the 127.0.0.1 iframe under localhost partitioned? */
async function partitionCheck() {
  const partition = `spike:partition-check-${nonce()}`;
  const host = makeWindow({ partition, show: false });
  await host.loadURL(iframeHostUrl());
  const frame = await findChildFrame(host, fixtureUrl("127.0.0.1", "/"));
  const before = await gameState(frame);
  const after = await playSteps(frame, 3);
  await closeWindow(host);
  const topLevel = await openGameAndRead(partition, { url: fixtureUrl("127.0.0.1", "/") });
  return {
    iframeHashBefore: before.hash,
    iframeHashAfter3Steps: after.hash,
    topLevelHash: topLevel.hash,
    partitioned: topLevel.hash === before.hash && topLevel.hash !== after.hash,
    shared: topLevel.hash === after.hash,
    disableFeatures: app.commandLine.getSwitchValue("disable-features") || null,
  };
}

async function referenceHashes() {
  const partition = `spike:reference-${nonce()}`;
  const win = makeWindow({ partition, show: false });
  await win.loadURL(fixtureUrl("localhost", "/?ephemeral=1"));
  const h0 = (await gameState(win.webContents)).hash;
  const h7 = (await playSteps(win.webContents, 7)).hash;
  const h8 = (await playSteps(win.webContents, 1)).hash;
  await closeWindow(win);
  return { h0, h7, h8 };
}

async function runVariant(variant, run, reference) {
  const iframe = variant === "c";
  const src = `persist:spike:src-${variant}-${run}`;
  const out = { variant, src };
  const steps = [];
  const mark = (name) => steps.push({ t: iso(), step: name });

  // (1) play 7 steps, record Hs, close the game window.
  mark("play");
  const game = makeWindow({ partition: src, show: false });
  await game.loadURL(iframe ? iframeHostUrl() : fixtureUrl("localhost", "/"));
  const target = iframe ? await findChildFrame(game, fixtureUrl("127.0.0.1", "/")) : game.webContents;
  const played = await playSteps(target, 7);
  out.Hs = played.hash;
  out.HsMatchesReference = played.hash === reference.h7;
  if (variant === "a") {
    out.swUnregister = await target.executeJavaScript(
      "navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister())).then((results) => ({ count: rs.length, results })))",
    );
  } else {
    out.swRegistrations = await target.executeJavaScript(
      "navigator.serviceWorker.getRegistrations().then((rs) => rs.map((r) => ({ scope: r.scope, active: !!r.active })))",
    );
  }
  await closeWindow(game);
  // The closed game's service worker keeps running for up to ~30 s (idle timeout). Wait until it
  // has stopped, so anything the canary sees during export would have been started by export.
  mark("wait-sw-idle");
  out.swIdle = await waitServiceWorkersIdle(src, 45000);

  // (2) quiescent export.
  mark("export");
  emit("export-window", { variant, phase: "open" });
  const exported = await quiescentExport(src, { iframe });
  emit("export-window", { variant, phase: "closed", t0: exported.logs.t0, t1: exported.logs.t1 });
  out.export = {
    t0: exported.logs.t0,
    t1: exported.logs.t1,
    inventory: exported.inventory,
    storageKeys: exported.storageKeys,
    quiescence: exported.quiescence,
    windowsAfterClose: exported.logs.windowsAfterClose,
    exporterVia: exported.snapshot.exporterVia,
    stepLogKeys: storeKeys(exported.snapshot, "progress-lab", "stepLog"),
    file: writeSnapshotFile(`${variant}`, exported.snapshot),
  };
  const negative = flipOneByte(exported.snapshot);
  out.negativeFlipped = negative.flipped;

  // (3) restore and (4) open the game and read Hd; negative control with one flipped byte.
  if (variant === "d") {
    const ses = session.fromPartition(src);
    const wipeAndCheck = async (label) => {
      mark(`wipe-${label}`);
      await ses.clearStorageData();
      const cookies = await ses.cookies.get({});
      const inventory = await quiescentInventory(src);
      return {
        cookies: cookies.length,
        runningServiceWorkers: Object.keys(ses.serviceWorkers.getAllRunning()).length,
        inventory: inventory.inventory,
      };
    };
    out.wipeBeforeNegative = await wipeAndCheck("negative");
    mark("restore-negative");
    out.negativeImport = await quiescentImport(src, negative.snapshot);
    out.Hneg = (await openGameAndRead(src)).hash;
    out.wipeBeforeRestore = await wipeAndCheck("restore");
    mark("restore");
    out.restore = await quiescentImport(src, exported.snapshot);
    const restored = await openGameAndRead(src);
    out.Hd = restored.hash;
    out.restoredError = restored.error;
  } else {
    const dst = `persist:spike:dst-${variant}-${run}`;
    mark("restore");
    out.restore = await quiescentImport(dst, exported.snapshot, { iframe });
    const restored = await openGameAndRead(dst, { iframe });
    out.Hd = restored.hash;
    out.restoredError = restored.error;
    mark("restore-negative");
    const negDst = `persist:spike:dst-neg-${variant}-${run}`;
    out.negativeImport = await quiescentImport(negDst, negative.snapshot, { iframe });
    out.Hneg = (await openGameAndRead(negDst, { iframe })).hash;

    if (variant === "a") {
      // IDB key generator after restore: explicit-key puts 1..7 must advance it to 8.
      mark("autoincrement");
      const win = makeWindow({ partition: dst, show: false });
      await win.loadURL(fixtureUrl("localhost", "/"));
      const eight = await playSteps(win.webContents, 1);
      await closeWindow(win);
      const again = await quiescentExport(dst);
      out.autoIncrement = {
        hashAfterOneMoreStep: eight.hash,
        matchesReference8: eight.hash === reference.h8,
        gameError: eight.error,
        stepLogKeysAfter: storeKeys(again.snapshot, "progress-lab", "stepLog"),
      };
    }
    if (variant === "c") {
      mark("partition-control");
      // Extra control: the same origin opened TOP-LEVEL is a different storage key and must not
      // see the restored iframe data.
      out.topLevel127Hash = (await openGameAndRead(dst, { url: fixtureUrl("127.0.0.1", "/") })).hash;
      out.topLevelDiffers = out.topLevel127Hash !== out.Hd;
      out.topLevelIsEmptyState = out.topLevel127Hash === reference.h0;
      // Wipe probes on the restored partition: origin-based clearStorageData, then CDP by storage key.
      mark("wipe-probes");
      const ses = session.fromPartition(dst);
      await ses.clearStorageData({ origin: fixtureUrl("127.0.0.1", "").replace(/\/$/, "") });
      const afterOriginClear = await quiescentInventory(dst, { iframe: true });
      const q = await openQuiescent({ partition: dst, iframe: true });
      const keys = await q.storageKeys();
      let cdpClear;
      try {
        await q.wc.debugger.sendCommand("Storage.clearDataForStorageKey", {
          storageKey: keys.iframe,
          storageTypes: "all",
        });
        cdpClear = { ok: true };
      } catch (error) {
        cdpClear = { ok: false, error: error.message };
      }
      const afterKeyClear = (await inIsolatedWorld(q.frame, "return await wgInventory();")).value;
      await q.close();
      out.wipeProbes = {
        clearStorageDataByOrigin: { origin: fixtureUrl("127.0.0.1", "").replace(/\/$/, ""), iframeAfter: afterOriginClear.inventory },
        clearDataForStorageKey: { storageKey: keys.iframe, result: cdpClear, iframeAfter: afterKeyClear },
      };
    }
    if (variant === "b") {
      // Canary sensitivity control: the same stub navigation WITHOUT the CDP bypass, in the source
      // partition where the service worker is still registered.
      mark("sw-bypass-control");
      await waitServiceWorkersIdle(src, 45000);
      const q = await openQuiescent({ partition: src, bypass: false });
      const inventory = (await inIsolatedWorld(q.wc, "return await wgInventory();")).value;
      const mainWorld = [await q.mainWorldCanary(q.wc)];
      const logs = await q.close();
      out.bypassControl = { inventory, quiescence: judgeQuiescence(logs, [inventory], mainWorld), t0: logs.t0, t1: logs.t1 };
    }
  }
  out.equal = out.Hd === out.Hs;
  out.negativeDiffers = out.Hneg !== out.Hs;
  out.windowsAtEnd = BrowserWindow.getAllWindows().length;
  out.steps = steps;
  return out;
}

async function modeH14() {
  const run = nonce();
  const reference = await referenceHashes();
  const variants = {};
  for (const v of String(args.variants ?? "a,b,c,d").split(",")) {
    try {
      variants[v] = await runVariant(v, run, reference);
    } catch (error) {
      variants[v] = { variant: v, error: String(error?.stack ?? error) };
    }
  }
  const partitioning = await partitionCheck();
  return { reference, variants, partitioning };
}

async function modePartitionCheck() {
  return partitionCheck();
}

async function modeH16() {
  const partition = "persist:spike:h16";
  const ses = session.fromPartition(partition);
  const win = makeWindow({ partition, show: true });
  await win.loadURL(fixtureUrl("localhost", "/"));
  await gameState(win.webContents);
  const rendererPid = win.webContents.getOSProcessId();
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const runningWorkers = () =>
    Object.values(ses.serviceWorkers.getAllRunning()).map((w) => ({ scriptUrl: w.scriptUrl, renderProcessId: w.renderProcessId }));
  emit("game-open", { rendererPid, windows: BrowserWindow.getAllWindows().length });
  await sleep(2500); // runner takes a ps snapshot now
  const closedAt = Date.now();
  await closeWindow(win);
  await sleep(5000);
  const rendererAlive5s = alive(rendererPid);
  const windowsAfterClose = BrowserWindow.getAllWindows().length;
  const workersAt5s = runningWorkers();
  emit("game-closed-5s", { rendererPid, rendererAlive: rendererAlive5s, windows: windowsAfterClose });
  await sleep(2500); // runner takes a ps snapshot now
  // Diagnostic: how long until that renderer exits, and does it coincide with the SW stopping?
  let rendererExitAfterMs = null;
  let workersStoppedAfterMs = runningWorkers().length === 0 ? Date.now() - closedAt : null;
  while (Date.now() - closedAt < 90000 && (rendererExitAfterMs === null || workersStoppedAfterMs === null)) {
    if (rendererExitAfterMs === null && !alive(rendererPid)) rendererExitAfterMs = Date.now() - closedAt;
    if (workersStoppedAfterMs === null && runningWorkers().length === 0) workersStoppedAfterMs = Date.now() - closedAt;
    await sleep(250);
  }
  const exported = await quiescentExport(partition);
  const windowsAfterExport = BrowserWindow.getAllWindows().length;
  return {
    rendererPid,
    rendererAliveAfterClose5s: rendererAlive5s,
    workersRunningAtClose5s: workersAt5s,
    rendererExitAfterCloseMs: rendererExitAfterMs,
    serviceWorkersStoppedAfterCloseMs: workersStoppedAfterMs,
    baselineWindows: 0,
    windowsAfterClose,
    windowsAfterExport,
    exportQuiescenceClean: exported.quiescence.clean,
    metricsAtEnd: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? null })),
  };
}

async function modeH11() {
  // Driven by Playwright _electron.launch; it clicks, evaluates and closes. Never quits by itself.
  globalThis.__wgSpike = { partitionCheck, environment };
  const win = makeWindow({ partition: `spike:h11-${nonce()}`, show: true });
  await win.loadURL(fixtureUrl("localhost", "/?ephemeral=1"));
  return null;
}

async function modeEnv() {
  // app.getGPUFeatureStatus() right after ready reports everything disabled until the GPU process
  // has reported; complete GPU info collection waits for it.
  const before = app.getGPUFeatureStatus();
  await app.getGPUInfo("complete");
  return { gpuFeatureStatusBeforeGpuInfo: before };
}

async function modeQuiescentDebug() {
  const q = await openQuiescent({ partition: args.partition ?? `spike:qdebug-${nonce()}`, iframe: !!args.iframe });
  const inventory = (await inIsolatedWorld(q.target, "return await wgInventory();")).value;
  const mainWorld = await q.mainWorldCanary(q.wc).catch((error) => ({ error: error.message }));
  const keys = await q.storageKeys();
  const logs = await q.close();
  return { inventory, mainWorld, keys, quiescence: judgeQuiescence(logs, [inventory], mainWorld.error ? [] : [mainWorld]) };
}

const MODES = {
  "quiescent-debug": modeQuiescentDebug,
  env: modeEnv,
  "page-probe": modePageProbe,
  frametime: modeFrameTime,
  memory: modeMemory,
  coldstart: modeColdStart,
  "h1-write": modeH1Write,
  "h2-read": modeH2Read,
  "h2b-write": modeH2bWrite,
  "h2b-read": modeH2bRead,
  sqlite: modeSqlite,
  permissions: modePermissions,
  h14: modeH14,
  "partition-check": modePartitionCheck,
  h16: modeH16,
  h11: modeH11,
};

app.whenReady().then(async () => {
  const startedAt = iso();
  let result;
  let error = null;
  try {
    const mode = MODES[MODE];
    if (!mode) throw new Error(`unknown mode ${MODE}`);
    result = await mode();
    if (result === null) return; // externally driven (H11)
  } catch (caught) {
    error = String(caught?.stack ?? caught);
  }
  const output = {
    mode: MODE,
    startedAt,
    finishedAt: iso(),
    pid: process.pid,
    environment: await environment(),
    processWarnings,
    error,
    result: result ?? null,
  };
  if (args.out) writeFileSync(args.out, JSON.stringify(output, null, 2));
  emit("done", { error });
  app.quit();
});
