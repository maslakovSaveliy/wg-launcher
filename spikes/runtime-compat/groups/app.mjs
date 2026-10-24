// THROWAWAY spike (runtime-compat, Task 6). H20: installed Google Chrome launched directly with
// --app=<url> and one --user-data-dir per "game", controlled over CDP. Checks (1) isolation,
// (2) persistence after a graceful quit, (3) no tab strip or address bar, (4) CDP attach and storage
// reads, (5) process cleanup. Check (6), the frame-time method, is run-timing.mjs.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cdpConnect,
  chromeVersion,
  devToolsPort,
  jsonFetch,
  processesMatching,
  sh,
  sleep,
  spawnChrome,
} from "../common.mjs";

const KINDS = ["localStorage", "indexedDB", "cookie", "cacheStorage", "opfs"];
const EMPTY_HASH_PREFIX = "e0bc6e48"; // 0 steps, from the Electron spike (H14 reference)

async function waitFor(fn, { timeout = 30000, interval = 150, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${last ? ` (${last.message})` : ""}`);
}

const present = (read) => KINDS.filter((k) => read?.[k] !== null && read?.[k] !== undefined && !read[k]?.error);

function matching(read, id, value) {
  const expected = `${id}:${value}`;
  const ok = {
    localStorage: read.localStorage === expected,
    indexedDB: read.indexedDB?.value === expected && read.indexedDB?.dateIsDate === true && read.indexedDB?.blobText === expected,
    cookie: read.cookie === expected,
    cacheStorage: read.cacheStorage === expected,
    opfs: read.opfs === expected,
  };
  return KINDS.filter((k) => ok[k]);
}

const instanceProcesses = (dir) => processesMatching((c) => c.includes(dir));

export async function group(context) {
  const { run, log } = context;
  const base = join(run.tmp, "chrome-app");
  mkdirSync(base, { recursive: true });
  const dirs = { A: join(base, "game-a"), B: join(base, "game-b"), C: join(base, "game-c") };
  const storageUrl = run.spikeUrl("/storage.html", {}, { token: false });
  const labUrl = run.fixtureUrl("/");
  const checks = { chromeVersion: chromeVersion(), deviations: [] };
  const hypotheses = {};

  async function launch(dir, url) {
    rmSync(join(dir, "DevToolsActivePort"), { force: true }); // a stale file from the previous run names a dead port
    const spawned = spawnChrome({ url, userDataDir: dir, app: true, cdp: true });
    const port = await devToolsPort(dir);
    const version = await jsonFetch(`http://127.0.0.1:${port}/json/version`);
    const prefix = url.split("?")[0];
    const target = await waitFor(async () => (await jsonFetch(`http://127.0.0.1:${port}/json/list`)).find((t) => t.type === "page" && t.url.startsWith(prefix)), { label: `page target ${prefix}` });
    const page = await cdpConnect(target.webSocketDebuggerUrl);
    return { dir, url, spawned, port, version, target, page, browserWs: version.webSocketDebuggerUrl };
  }

  /** Graceful quit through the browser CDP endpoint; waits until no process of the profile remains. */
  async function quit(instance) {
    const started = Date.now();
    const browser = await cdpConnect(instance.browserWs);
    await browser.send("Browser.close").catch(() => {});
    browser.close();
    instance.page.close();
    await waitFor(() => instanceProcesses(instance.dir).length === 0, { timeout: 20000, interval: 200, label: "profile processes gone" }).catch(() => {});
    return { quitMs: Date.now() - started, remaining: instanceProcesses(instance.dir).length };
  }

  const ready = (instance) => waitFor(async () => (await instance.page.evaluate("typeof window.wgStorage === 'object'")) === true, { label: "wgStorage" });

  // ---- (1) and (2): isolation and persistence with the five-kind storage markers (H1/H2 method) ----
  const nonce = Math.random().toString(16).slice(2, 10);
  log("  chrome --app: storage markers in two profiles");
  const a = await launch(dirs.A, storageUrl);
  const b = await launch(dirs.B, storageUrl);
  await Promise.all([ready(a), ready(b)]);
  checks.versionString = a.version.Browser;
  const call = (instance, body) => instance.page.evaluate(`(async () => JSON.stringify(await (${body})))()`).then(JSON.parse);
  const writeA = await call(a, `wgStorage.write("A", ${JSON.stringify(nonce)}, { large: true })`);
  const bSeesABeforeWrite = await call(b, `wgStorage.read(["A"], { large: true })`);
  const writeB = await call(b, `wgStorage.write("B", ${JSON.stringify(nonce)}, { large: true })`);
  const bSeesA = await call(b, `wgStorage.read(["A"], { large: true })`);
  const aSeesB = await call(a, `wgStorage.read(["B"], { large: true })`);
  const aOwn = await call(a, `wgStorage.read(["A"], { large: true })`);
  const bOwn = await call(b, `wgStorage.read(["B"], { large: true })`);
  // Control: a second window of the same profile as A must see A's markers (the probe can detect sharing).
  const browserA = await cdpConnect(a.browserWs);
  const { targetId } = await browserA.send("Target.createTarget", { url: storageUrl, newWindow: true });
  const controlTarget = await waitFor(async () => (await jsonFetch(`http://127.0.0.1:${a.port}/json/list`)).find((t) => t.id === targetId), { label: "control target" });
  const controlPage = await cdpConnect(controlTarget.webSocketDebuggerUrl);
  await waitFor(async () => (await controlPage.evaluate("typeof window.wgStorage === 'object'")) === true, { label: "control wgStorage" });
  const controlSeesA = JSON.parse(await controlPage.evaluate(`(async () => JSON.stringify(await wgStorage.read(["A"], { large: true })))()`));
  controlPage.close();
  await browserA.send("Target.closeTarget", { targetId }).catch(() => {});
  browserA.close();

  const leaks = {
    AtoBBeforeBWrote: present(bSeesABeforeWrite.A),
    AtoB: present(bSeesA.A),
    BtoA: present(aSeesB.B),
  };
  const own = { A: matching(aOwn.A, "A", nonce), B: matching(bOwn.B, "B", nonce) };
  const controlKinds = matching(controlSeesA.A, "A", nonce);
  const leakCount = leaks.AtoBBeforeBWrote.length + leaks.AtoB.length + leaks.BtoA.length;
  // aSeesB.B was read in A: any non-null kind there is a leak; bSeesA.A read in B likewise.
  const isolationMetrics = { leaks, own, controlSameProfileSeesA: controlKinds, versions: { a: a.version.Browser, b: b.version.Browser } };
  if (controlKinds.length < 5) hypotheses["H20-1"] = { status: "INVALID", reason: `same-profile control saw ${controlKinds.length} of 5 kinds (probe cannot detect sharing)`, metrics: isolationMetrics };
  else if (own.A.length < 5 || own.B.length < 5) hypotheses["H20-1"] = { status: "INVALID", reason: "a profile does not see its own 5 markers", metrics: isolationMetrics };
  else if (leakCount > 0) hypotheses["H20-1"] = { status: "FAIL", reason: `${leakCount} leaked kind(s) across profiles`, metrics: isolationMetrics };
  else hypotheses["H20-1"] = { status: "PASS", reason: "0 leaked kinds in both directions between two --user-data-dir profiles; each saw its own 5; same-profile control saw 5 of 5", metrics: isolationMetrics };

  const quitA = await quit(a);
  const quitB = await quit(b);
  checks.storageQuit = { A: quitA, B: quitB };
  log(`  quit A ${quitA.quitMs} ms (left ${quitA.remaining}), B ${quitB.quitMs} ms (left ${quitB.remaining})`);

  const a2 = await launch(dirs.A, storageUrl);
  const b2 = await launch(dirs.B, storageUrl);
  await Promise.all([ready(a2), ready(b2)]);
  const aAgain = await call(a2, `wgStorage.read(["A", "B"], { large: true })`);
  const bAgain = await call(b2, `wgStorage.read(["A", "B"], { large: true })`);
  const largeEqual = (read, id, written) => read[id]?.large?.blobSha256 === written.large?.blobSha256 && read[id]?.large?.u8Sha256 === written.large?.u8Sha256 && !!written.large?.blobSha256;
  const persisted = {
    ownA: matching(aAgain.A, "A", nonce),
    ownB: matching(bAgain.B, "B", nonce),
    largeEqualA: largeEqual(aAgain, "A", writeA),
    largeEqualB: largeEqual(bAgain, "B", writeB),
    leaksAfterRestartInA: present(aAgain.B),
    leaksAfterRestartInB: present(bAgain.A),
    largeBlobBytes: aAgain.A?.large?.blobSize ?? null,
  };
  const persistOk = persisted.ownA.length === 5 && persisted.ownB.length === 5 && persisted.largeEqualA && persisted.largeEqualB;
  hypotheses["H20-2"] = persistOk
    ? { status: "PASS", reason: "all 5 kinds (persistent cookie included) and both 1 MiB values (SHA-256 equal) back in the right profiles after Browser.close and relaunch", metrics: persisted }
    : { status: "FAIL", reason: "something lost or altered after the graceful quit", metrics: persisted };
  await quit(a2);
  await quit(b2);

  // ---- (3), (4), (5) and gameplay persistence with progress-lab in a third profile -----------
  log("  chrome --app: progress-lab in a third profile (UI, CDP, processes)");
  const lab = {};
  const before = instanceProcesses(dirs.C).length;
  const c = await launch(dirs.C, labUrl);
  const hash = async (page) => page.evaluate(`(() => { const h = document.querySelector('#progress-hash'); return h && h.dataset.ready === 'true' ? h.textContent : null; })()`);
  await waitFor(() => hash(c.page), { label: "progress-lab ready" });
  lab.hash0 = await hash(c.page);
  await c.page.evaluate(`(() => { const b = document.querySelector('#play-step'); for (let i = 0; i < 3; i++) b.click(); return true; })()`);
  await waitFor(async () => {
    const h = await hash(c.page);
    return h && h !== lab.hash0 ? h : null;
  }, { label: "hash after 3 steps" });
  lab.hash3 = await hash(c.page);
  lab.emptyHashMatchesElectronReference = lab.hash0.startsWith(EMPTY_HASH_PREFIX);

  // (3) window chrome
  const ui = await c.page.evaluate(`({
    locationbar: window.locationbar.visible, menubar: window.menubar.visible, toolbar: window.toolbar.visible,
    statusbar: window.statusbar.visible, personalbar: window.personalbar.visible,
    outerWidth, outerHeight, innerWidth, innerHeight, screenX, screenY, devicePixelRatio,
    displayMode: matchMedia('(display-mode: standalone)').matches ? 'standalone' : matchMedia('(display-mode: minimal-ui)').matches ? 'minimal-ui' : matchMedia('(display-mode: browser)').matches ? 'browser' : 'other'
  })`);
  const browserC = await cdpConnect(c.browserWs);
  const { windowId, bounds } = await browserC.send("Browser.getWindowForTarget", { targetId: c.target.id });
  lab.ui = { ...ui, windowBounds: bounds, titleBarAndBorderHeight: ui.outerHeight - ui.innerHeight };
  lab.screenshot = await screenshotOf(run, bounds);
  // (4) CDP
  const origin = `http://localhost:${run.fixturePort}`;
  const cdp = {};
  cdp.jsonVersion = { answered: typeof c.version.Browser === "string", browser: c.version.Browser, protocol: c.version["Protocol-Version"] };
  await c.page.send("DOMStorage.enable");
  const ls = await c.page.send("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: origin, isLocalStorage: true } });
  cdp.domStorage = { items: ls.entries.length, hasState: ls.entries.some(([k]) => k === "progress-lab:state") };
  await c.page.send("IndexedDB.enable");
  const names = await c.page.send("IndexedDB.requestDatabaseNames", { securityOrigin: origin });
  const stepLog = await c.page.send("IndexedDB.requestData", { securityOrigin: origin, databaseName: "progress-lab", objectStoreName: "stepLog", skipCount: 0, pageSize: 50 });
  cdp.indexedDB = { databases: names.databaseNames, stepLogEntries: stepLog.objectStoreDataEntries.length, hasMore: stepLog.hasMore };
  cdp.restoreNote = "CDP IndexedDB has no put/add; restore through CDP is impossible (Verified in MEMORY.md from the PDL)";
  lab.cdp = cdp;
  const cdpOk = cdp.jsonVersion.answered && cdp.domStorage.hasState && cdp.indexedDB.stepLogEntries === 3 && cdp.indexedDB.databases.includes("progress-lab");
  hypotheses["H20-4"] = cdpOk
    ? { status: "PASS", reason: "/json/version answered; DOMStorage read progress-lab:state; IndexedDB.requestData read the 3 stepLog records", metrics: cdp }
    : { status: "FAIL", reason: "a CDP read did not return the expected data", metrics: cdp };

  // window.locationbar/toolbar/menubar.visible say true in an --app window, so they prove nothing.
  // The evidence is the height of the browser UI (outer minus inner height; a normal window is 87 px,
  // measured in the Playwright Chrome window) and a human reading of the captured screenshot.
  const observation = context.opts["h20-3-observation"] ?? null;
  const verdict = observation ? (/^pass/i.test(observation) ? "PASS" : /^fail/i.test(observation) ? "FAIL" : "REPORTED") : "REPORTED";
  hypotheses["H20-3"] = {
    status: verdict,
    reason: `browser UI height outerHeight - innerHeight = ${lab.ui.titleBarAndBorderHeight} px (a normal Chrome window: 87 px in the Playwright run); display-mode ${ui.displayMode}; window.locationbar/toolbar/menubar.visible are ${ui.locationbar}/${ui.toolbar}/${ui.menubar} even here, so they say nothing; screenshot ${lab.screenshot.captured ? "captured" : `not captured (${lab.screenshot.reason})`}; manual reading: ${observation ?? "none given (--h20-3-observation)"}`,
    metrics: { ui: lab.ui, screenshot: { captured: lab.screenshot.captured, region: lab.screenshot.region }, manualObservation: observation },
  };

  // (5) close the window; renderers of the page; then quit
  const processInfo = async () => (await browserC.send("SystemInfo.getProcessInfo")).processInfo;
  const procsOpen = await processInfo();
  const rendererPids = procsOpen.filter((p) => p.type === "renderer").map((p) => p.id);
  const snapshotsDir = {
    beforeLaunch: before,
    gameOpen: instanceProcesses(dirs.C).length,
  };
  const alivePids = (pids) => pids.filter((pid) => /^\d+$/.test(sh("ps", ["-p", String(pid), "-o", "pid="])));
  const closedAt = Date.now();
  await browserC.send("Target.closeTarget", { targetId: c.target.id }).catch(() => {});
  c.page.close();
  // Poll every 100 ms: when does the last renderer of the closed window exit?
  let rendererExitMs = null;
  while (Date.now() - closedAt < 60000) {
    if (alivePids(rendererPids).length === 0) {
      rendererExitMs = Date.now() - closedAt;
      break;
    }
    await sleep(100);
  }
  await sleep(Math.max(0, 5000 - (Date.now() - closedAt)));
  const aliveAt5 = rendererExitMs !== null && rendererExitMs <= 5000 ? [] : rendererPids;
  const pages = (await jsonFetch(`http://127.0.0.1:${c.port}/json/list`).catch(() => [])).filter((t) => t.type === "page").length;
  snapshotsDir.gameClosed5s = instanceProcesses(dirs.C).length;
  browserC.close();
  const quitC = await quit(c);
  await sleep(5000);
  snapshotsDir.appQuit5s = instanceProcesses(dirs.C).length;
  const cleanup = { rendererPidsAtOpen: rendererPids.length, rendererAliveAfterClose5s: aliveAt5.length > 0, rendererExitAfterCloseMs: rendererExitMs, pagesAfterClose: pages, processesOfProfile: snapshotsDir, browserSurvivedLastWindowClose: snapshotsDir.gameClosed5s > 0, quitMs: quitC.quitMs };
  const problems = [];
  if (cleanup.rendererAliveAfterClose5s) problems.push(`a renderer of the closed window was alive 5 s after the close (exited after ${rendererExitMs ?? "more than 60000"} ms)`);
  if (pages !== 0) problems.push(`${pages} page target(s) after close`);
  if (snapshotsDir.appQuit5s !== 0) problems.push(`${snapshotsDir.appQuit5s} process(es) of the profile 5 s after quit`);
  hypotheses["H20-5"] = problems.length
    ? { status: "FAIL", reason: problems.join("; "), metrics: cleanup }
    : { status: "PASS", reason: "no renderer of the closed window 5 s after the close, no page targets, nothing of the profile 5 s after Browser.close", metrics: cleanup };
  log(`  cleanup: renderer alive at 5 s ${cleanup.rendererAliveAfterClose5s}, exit ${rendererExitMs} ms, browser survived window close ${cleanup.browserSurvivedLastWindowClose}, left after quit ${snapshotsDir.appQuit5s}`);

  // Gameplay persistence (launch, input and save columns of the matrix): relaunch the third profile.
  const c2 = await launch(dirs.C, labUrl);
  await waitFor(() => hash(c2.page), { label: "progress-lab ready after relaunch" });
  lab.hashAfterRestart = await hash(c2.page);
  lab.persistedAcrossRestart = lab.hashAfterRestart === lab.hash3;
  const quitC2 = await quit(c2);
  lab.afterRestartQuit = quitC2;
  checks.progressLab = lab;
  hypotheses["H20-6"] = { status: "NOT_RUN", reason: "frame-time method: run-timing.mjs, hands-off phase" };
  hypotheses.H20 = {
    status: "REPORTED",
    reason: `Chrome ${checks.chromeVersion} --app with one --user-data-dir per game: isolation ${hypotheses["H20-1"].status}, persistence ${hypotheses["H20-2"].status}, window chrome reported, CDP ${hypotheses["H20-4"].status}, cleanup ${hypotheses["H20-5"].status}, frame time not run; progress-lab hash survived restart: ${lab.persistedAcrossRestart}; no restore path via CDP`,
  };
  for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  return {
    runtime: { name: "chrome-app", version: checks.chromeVersion },
    label: `Google Chrome ${checks.chromeVersion} launched directly with --app=URL and a separate --user-data-dir per game (H20)`,
    hypotheses,
    checks,
    probeFiles: [],
    leftoverProcesses: { profileProcessesAfterAll: Object.values(dirs).reduce((n, d) => n + instanceProcesses(d).length, 0) },
  };
}

/** Screenshot of the window's region with screencapture; reports whether it was captured. Not stored. */
async function screenshotOf(run, bounds) {
  const file = join(run.tmp, "app-window.png");
  const region = `${bounds.left},${bounds.top},${bounds.width},${bounds.height}`;
  const out = sh("screencapture", ["-x", "-R", region, file]);
  const captured = !out.startsWith("ERROR");
  return { captured, region, reason: captured ? null : out.slice(0, 120), file: captured ? run.sanitize(file) : null };
}
