// THROWAWAY spike (runtime-compat, Task 6). Injected into the public demo pages of H21 (H21 is
// reported, no threshold) before any page script runs, in Electron (CDP Page.addScriptToEvaluateOnNewDocument
// on webContents.debugger) and in Chrome (the same CDP call through Playwright), so both runtimes
// run identical instrumentation. It records WebGPU use (requestAdapter / requestDevice calls), the
// canvas context types the page asked for, the visibility and focus log, and, on request, the
// requestAnimationFrame deltas (the H7 sampler). Observation only: nothing is changed in the page's
// behavior except that the wrapped calls count themselves.
(() => {
  if (window.__wgDemo || window !== window.top) return;
  const state = {
    webgpu: { navigatorGpu: "gpu" in navigator, requestAdapterCalls: 0, adapters: 0, nullAdapters: 0, requestDeviceCalls: 0, devices: 0, errors: [] },
    contexts: [],
    visibility: { log: [], everHidden: false, everUnfocused: false },
  };
  const record = (event) => {
    const visibilityState = document.visibilityState;
    const hasFocus = document.hasFocus();
    state.visibility.log.push({ t: Math.round(performance.now()), event, visibilityState, hasFocus });
    if (visibilityState !== "visible") state.visibility.everHidden = true;
    if (!hasFocus) state.visibility.everUnfocused = true;
  };
  for (const name of ["visibilitychange", "blur", "focus"]) window.addEventListener(name, () => record(name), true);
  record("init");

  if (navigator.gpu?.requestAdapter) {
    const original = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (...args) => {
      state.webgpu.requestAdapterCalls++;
      try {
        const adapter = await original(...args);
        if (adapter) {
          state.webgpu.adapters++;
          const requestDevice = adapter.requestDevice.bind(adapter);
          adapter.requestDevice = async (...a) => {
            state.webgpu.requestDeviceCalls++;
            try {
              const device = await requestDevice(...a);
              state.webgpu.devices++;
              return device;
            } catch (error) {
              state.webgpu.errors.push(`requestDevice: ${error?.message ?? error}`);
              throw error;
            }
          };
        } else state.webgpu.nullAdapters++;
        return adapter;
      } catch (error) {
        state.webgpu.errors.push(`requestAdapter: ${error?.message ?? error}`);
        throw error;
      }
    };
  }

  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = getContext.call(this, type, ...rest);
    state.contexts.push({ type, ok: context !== null });
    return context;
  };

  /** rAF deltas for `durationMs` after `warmupMs` (same sampler as probe.js frametime mode). */
  function sample(durationMs, warmupMs) {
    return new Promise((resolve) => {
      const timestamps = [];
      let start = null;
      record("sample-start");
      const tick = (t) => {
        if (start === null) start = t;
        if (t - start >= warmupMs) timestamps.push(t);
        if (t - start >= warmupMs + durationMs) {
          record("sample-end");
          const deltas = [];
          for (let i = 1; i < timestamps.length; i++) deltas.push(timestamps[i] - timestamps[i - 1]);
          resolve({ deltasMs: deltas, viewport: { innerWidth, innerHeight, devicePixelRatio } });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  window.__wgDemo = {
    snapshot: () => ({
      webgpu: state.webgpu,
      contexts: state.contexts,
      canvases: document.querySelectorAll("canvas").length,
      visibility: state.visibility,
      title: document.title,
      href: location.href,
      viewport: { innerWidth, innerHeight, devicePixelRatio },
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    }),
    sample,
  };
})();
