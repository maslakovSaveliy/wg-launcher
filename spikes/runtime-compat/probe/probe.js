// THROWAWAY spike (runtime-compat). Not product code.
// Shared probe page for Electron (Task 5) and Chrome / Tauri (Task 6). Runs one mode, then POSTs a
// JSON result to the spike server (POST /results/<runtime>) and exposes the state on
// window.wgProbe so a host that controls the window can wait for it.
//
// Query parameters:
//   mode      probe (default) | frametime | coldstart | scene
//   runtime   runtime name for the result file (default: parsed from the user agent)
//   version   runtime version (default: parsed from the user agent)
//   checks    probe only: comma list of webgl2,webgpu,coi,wasm,storage,opfs,idb,audio (default all)
//   load      scene load (per-pixel loop count), default 64
//   duration  frametime: measured milliseconds, default 20000
//   warmup    frametime: discarded milliseconds, default 2000
//   vsyncHz   display refresh rate known to the host (Electron: screen.displayFrequency)
//   spawn     coldstart: wall-clock ms at which the host spawned the process
//   label     free text copied into the result
//   server    origin of the spike server when the page is served elsewhere (Tauri assets)
//   token     per-run secret the spike server requires on POST (sent as X-WG-Token; never recorded)
//   post      0 to skip the POST (debugging)

import { createScene } from "./scene.js";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "probe";
const statusElement = document.querySelector("#status");

const state = { state: "running", mode, result: null, error: null, file: null };
window.wgProbe = state;

function setStatus(text) {
  if (statusElement) statusElement.textContent = text;
}

// ---- Runtime identity ---------------------------------------------------------------------------

function runtimeIdentity() {
  const ua = navigator.userAgent;
  const electron = /Electron\/(\S+)/.exec(ua)?.[1];
  const chrome = /Chrome\/(\S+)/.exec(ua)?.[1];
  const safari = /Version\/(\S+).*Safari/.exec(ua)?.[1];
  const name = params.get("runtime") ?? (electron ? "electron" : chrome ? "chrome" : "webkit");
  const version =
    params.get("version") ?? (name === "electron" ? electron : name === "chrome" ? chrome : safari);
  return { name, version: version ?? "unknown", chromium: chrome ?? null, userAgent: ua };
}

// ---- Visibility and focus log (every timing run is INVALID if the page was ever hidden/unfocused)

const visibility = { log: [], everHidden: false, everUnfocused: false };
function recordVisibility(event) {
  const visible = document.visibilityState;
  const focused = document.hasFocus();
  visibility.log.push({ t: Math.round(performance.now()), event, visibilityState: visible, hasFocus: focused });
  if (visible !== "visible") visibility.everHidden = true;
  if (!focused) visibility.everUnfocused = true;
}
for (const name of ["visibilitychange", "blur", "focus"]) {
  window.addEventListener(name, () => recordVisibility(name), true);
}
document.addEventListener("visibilitychange", () => recordVisibility("document-visibilitychange"));

// ---- Helpers -----------------------------------------------------------------------------------

const errorText = (error) => (error ? `${error.name ?? "Error"}: ${error.message ?? String(error)}` : null);

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return { error: errorText(error) };
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)),
  ]);
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Capability checks ------------------------------------------------------------------------

function checkWebGL2() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) return { available: false };
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
  const extensions = gl.getSupportedExtensions() ?? [];
  const result = {
    available: true,
    vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    renderer,
    version: gl.getParameter(gl.VERSION),
    shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    extensionCount: extensions.length,
    timerQuery: extensions.includes("EXT_disjoint_timer_query_webgl2"),
    softwareRenderer: typeof renderer === "string" ? /swiftshader/i.test(renderer) : null,
  };
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return result;
}

async function checkWebGPU() {
  if (!("gpu" in navigator)) return { available: false, reason: "navigator.gpu missing" };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { available: true, adapter: null };
  const info = adapter.info ?? {};
  const limits = {};
  for (const key in adapter.limits) limits[key] = adapter.limits[key];
  const result = {
    available: true,
    adapter: {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      description: info.description ?? null,
      isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
    },
    features: [...adapter.features].sort(),
    featureCount: adapter.features.size,
    limits,
    preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat?.() ?? null,
    wgslLanguageFeatures: navigator.gpu.wgslLanguageFeatures ? [...navigator.gpu.wgslLanguageFeatures].sort() : null,
  };
  const device = await adapter.requestDevice();
  result.device = true;
  // One workgroup of 64 invocations writes i * 3 + 7; the result is read back from a mapped buffer.
  const module = device.createShaderModule({
    code: `@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) i: u32) { out[i] = i * 3u + 7u; }`,
  });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const size = 64 * 4;
  const storage = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: storage } }],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
  encoder.copyBufferToBuffer(storage, 0, readback, 0, size);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const values = new Uint32Array(readback.getMappedRange().slice(0));
  readback.unmap();
  result.computeReadbackCorrect = values.every((v, i) => v === i * 3 + 7);
  result.computeSample = Array.from(values.slice(0, 4));
  device.destroy();
  return result;
}

async function checkCrossOriginIsolation() {
  const result = {
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBufferDefined: typeof SharedArrayBuffer === "function",
    roundTrip: false,
  };
  if (!result.sharedArrayBufferDefined) {
    result.error = "SharedArrayBuffer is not defined";
    return result;
  }
  const worker = new Worker(new URL("coi-worker.js", location.href));
  try {
    const sab = new SharedArrayBuffer(8);
    const shared = new Int32Array(sab);
    const messages = [];
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        messages.push(event.data);
        if (event.data.type === "ready") resolve();
        if (event.data.type === "error") reject(new Error(event.data.error));
      };
      worker.onerror = (event) => reject(new Error(`worker error: ${event.message}`));
      worker.onmessageerror = () => reject(new Error("messageerror (SharedArrayBuffer not shareable)"));
    });
    worker.postMessage(sab);
    await withTimeout(ready, 5000, "worker ready");
    Atomics.store(shared, 0, 1);
    Atomics.notify(shared, 0);
    if (typeof Atomics.waitAsync === "function") {
      const waiting = Atomics.waitAsync(shared, 1, 0, 5000);
      const outcome = waiting.async ? await waiting.value : waiting.value;
      result.waitAsync = outcome;
    } else {
      const deadline = performance.now() + 5000;
      while (Atomics.load(shared, 1) === 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      result.waitAsync = "unavailable (polled)";
    }
    result.roundTrip = Atomics.load(shared, 1) === 2;
    result.workerMessages = messages;
  } catch (error) {
    result.error = errorText(error);
  } finally {
    worker.terminate();
  }
  return result;
}

async function checkWasm() {
  const detect = await import(new URL("vendor/wasm-feature-detect.js", location.href).href);
  const features = {};
  for (const [name, fn] of Object.entries(detect).sort()) {
    if (typeof fn !== "function") continue;
    try {
      features[name] = await withTimeout(Promise.resolve(fn()), 3000, name);
    } catch (error) {
      features[name] = { error: errorText(error) };
    }
  }
  return { library: "wasm-feature-detect", features };
}

async function checkStorage() {
  const estimate = await navigator.storage.estimate();
  const persistedBefore = await navigator.storage.persisted();
  const persist = await attempt(() => withTimeout(navigator.storage.persist(), 5000, "persist"));
  return {
    quota: estimate.quota ?? null,
    usage: estimate.usage ?? null,
    persistedBefore,
    persist,
    persistedAfter: await navigator.storage.persisted(),
  };
}

async function checkOpfs() {
  const root = await navigator.storage.getDirectory();
  const name = `wg-probe-${Date.now()}.bin`;
  const bytes = crypto.getRandomValues(new Uint8Array(4096));
  const handle = await root.getFileHandle(name, { create: true });
  if (typeof handle.createWritable !== "function") {
    await root.removeEntry(name);
    return { getDirectory: true, createWritable: false };
  }
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  const back = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  await root.removeEntry(name);
  return { getDirectory: true, createWritable: true, roundTrip: bytesEqual(bytes, back) };
}

async function checkIdbBlob() {
  const name = `wg-probe-${Date.now()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("blobs");
  const db = await idbRequest(opening);
  try {
    const write = db.transaction("blobs", "readwrite");
    write.objectStore("blobs").put({ blob: new Blob([bytes], { type: "application/x-probe" }), at: new Date(0) }, "k");
    await new Promise((resolve, reject) => {
      write.oncomplete = resolve;
      write.onerror = () => reject(write.error);
    });
    const value = await idbRequest(db.transaction("blobs").objectStore("blobs").get("k"));
    const back = new Uint8Array(await value.blob.arrayBuffer());
    return {
      blobType: value.blob.type,
      dateType: value.at instanceof Date,
      roundTrip: value.blob instanceof Blob && bytesEqual(bytes, back),
    };
  } finally {
    db.close();
    await idbRequest(indexedDB.deleteDatabase(name));
  }
}

async function checkAudio() {
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) return { available: false };
  const context = new Context();
  const result = {
    available: true,
    initialState: context.state,
    sampleRate: context.sampleRate,
    baseLatency: context.baseLatency ?? null,
  };
  result.resume = await attempt(async () => {
    await withTimeout(context.resume(), 2000, "resume");
    return { ok: true };
  });
  result.stateAfterResume = context.state;
  await context.close();
  return result;
}

const CHECKS = {
  webgl2: checkWebGL2,
  webgpu: checkWebGPU,
  coi: checkCrossOriginIsolation,
  wasm: checkWasm,
  storage: checkStorage,
  opfs: checkOpfs,
  idb: checkIdbBlob,
  audio: checkAudio,
};

async function runProbe() {
  const wanted = (params.get("checks") ?? Object.keys(CHECKS).join(",")).split(",").filter((c) => CHECKS[c]);
  const checks = {};
  for (const name of wanted) {
    setStatus(`running ${name}`);
    checks[name] = await attempt(() => withTimeout(Promise.resolve(CHECKS[name]()), 20000, name));
  }
  return { checks };
}

// ---- Frame time, cold start, scene -------------------------------------------------------------

function sceneCanvas() {
  const canvas = document.createElement("canvas");
  canvas.id = "scene";
  canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;display:block";
  document.body.append(canvas);
  return canvas;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function frameStats(deltas, vsyncMs) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const longThreshold = vsyncMs ? vsyncMs * 2 : null;
  const longFrames = longThreshold === null ? null : deltas.filter((d) => d > longThreshold).length;
  const sum = deltas.reduce((a, b) => a + b, 0);
  return {
    count: deltas.length,
    meanMs: deltas.length ? sum / deltas.length : null,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
    longFrameThresholdMs: longThreshold,
    longFrames,
    longFrameShare: longFrames === null || deltas.length === 0 ? null : longFrames / deltas.length,
  };
}

async function runFrameTime() {
  const load = Number(params.get("load") ?? 64);
  const duration = Number(params.get("duration") ?? 20000);
  const warmup = Number(params.get("warmup") ?? 2000);
  const hostHz = params.get("vsyncHz") ? Number(params.get("vsyncHz")) : null;
  const scene = createScene(sceneCanvas(), { load });
  recordVisibility("start");
  const timestamps = [];
  let frame = 0;
  await new Promise((resolve) => {
    let start = null;
    const tick = (t) => {
      scene.draw(frame++);
      if (start === null) start = t;
      if (t - start >= warmup) timestamps.push(t);
      if (t - start >= warmup + duration) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  recordVisibility("end");
  const deltas = [];
  for (let i = 1; i < timestamps.length; i++) deltas.push(timestamps[i] - timestamps[i - 1]);
  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  const estimatedHz = sortedDeltas.length ? 1000 / percentile(sortedDeltas, 50) : null;
  const vsyncMs = hostHz ? 1000 / hostHz : null;
  return {
    scene: scene.info,
    settings: { load, durationMs: duration, warmupMs: warmup },
    vsync: { hostReportedHz: hostHz, intervalMs: vsyncMs, p50EstimatedHz: estimatedHz },
    viewport: { innerWidth, innerHeight },
    stats: frameStats(deltas, vsyncMs),
    framesDrawn: frame,
    deltasMs: deltas.length <= 4000 ? deltas.map((d) => Math.round(d * 1000) / 1000) : null,
  };
}

async function runColdStart() {
  const load = Number(params.get("load") ?? 64);
  const scene = createScene(sceneCanvas(), { load });
  scene.draw(0);
  const firstFrameWallMs = await new Promise((resolve) => requestAnimationFrame(() => resolve(Date.now())));
  recordVisibility("first-frame");
  const spawn = params.get("spawn") ? Number(params.get("spawn")) : null;
  const navigation = performance.getEntriesByType("navigation")[0];
  return {
    scene: scene.info,
    spawnWallMs: spawn,
    firstFrameWallMs,
    spawnToFirstFrameMs: spawn === null ? null : firstFrameWallMs - spawn,
    timeOriginWallMs: Math.round(performance.timeOrigin),
    navigation: navigation
      ? { responseEnd: navigation.responseEnd, domContentLoaded: navigation.domContentLoadedEventEnd }
      : null,
  };
}

async function runScene() {
  const load = Number(params.get("load") ?? 64);
  const scene = createScene(sceneCanvas(), { load });
  recordVisibility("start");
  let frame = 0;
  const tick = () => {
    scene.draw(frame++);
    window.wgProbe.frames = frame;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // A scene run never finishes by itself; the host reads wgProbe and closes the window.
  state.state = "rendering";
  state.scene = scene.info;
  state.visibility = visibility;
  return null;
}

// ---- Main -------------------------------------------------------------------------------------

async function post(payload) {
  if (params.get("post") === "0") return null;
  const base = params.get("server") ?? location.origin;
  const response = await fetch(`${base}/results/${encodeURIComponent(payload.runtime.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WG-Token": params.get("token") ?? "" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`POST failed: ${response.status}`);
  return (await response.json()).file;
}

async function main() {
  recordVisibility("load");
  const runners = { probe: runProbe, frametime: runFrameTime, coldstart: runColdStart, scene: runScene };
  const runner = runners[mode];
  if (!runner) throw new Error(`unknown mode ${mode}`);
  const data = await runner();
  if (data === null) return;
  recordVisibility("done");
  const kinds = { probe: "probe", frametime: "frame-time", coldstart: "cold-start" };
  const recordedUrl = new URL(location.href);
  recordedUrl.searchParams.delete("token");
  const payload = {
    schemaVersion: 1,
    kind: kinds[mode],
    createdAt: new Date().toISOString(),
    runtime: runtimeIdentity(),
    label: params.get("label"),
    page: {
      url: recordedUrl.href,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      visibility,
    },
    data,
  };
  state.result = payload;
  setStatus("posting");
  state.file = await post(payload);
  state.state = "posted";
  setStatus(`done ${state.file ?? ""}`);
}

main().catch((error) => {
  state.state = "error";
  state.error = errorText(error);
  setStatus(`error: ${state.error}`);
  console.error(error);
});
