# Compatibility matrix

<!-- Generated file. Do not edit by hand. Regenerate with: node spikes/runtime-compat/matrix.mjs > docs/compat/matrix.md -->

> **Generated** from `spikes/runtime-compat/results/*.json` by `node spikes/runtime-compat/matrix.mjs > docs/compat/matrix.md`.
> Do not edit by hand; running the command twice gives identical output. Only real recorded runs appear here. Each row is
> Verified on the date and for the OS shown, with the evidence file named in its last column (a file under
> `spikes/runtime-compat/results/`). Nothing is extrapolated to other machines, operating systems or games: see
> [methodology.md](methodology.md). "Verified" never applies to a platform or game that has no row with a run.

## Runs on the dev machine

| Game / build | URL or version | Date | OS | Runtime | Launch | Input | Save | Restore | Notes | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress-lab (controlled test fixture, not a real game) | `fixtures/test-games/progress-lab`, served from localhost | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Electron 45.0.0 (Chromium 156.0.8078.48) | window opens, page loads (H11 PASS) | `#play-step` clicked by Playwright (H11); injected trusted input: H13 INVALID | persists across `app.quit()` and relaunch in its own partition (H2 PASS) | export while closed, restore into a clean partition, same hash (H14 PASS, variants a to d) | session partitions isolated (H1 PASS); no manual real-click run | electron-45.0.0-20261024T151511.707Z.json |
| progress-lab (controlled test fixture, not a real game) | `fixtures/test-games/progress-lab`, served from localhost | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Google Chrome 155.0.8059.85, launched directly with `--app=URL` and one `--user-data-dir` per game | window opens without tab strip or address bar (H20-3 PASS 5/5) | `#play-step` clicked through CDP | progress hash survived a graceful quit and relaunch in 5 of 5 runs (H20-2 PASS 5/5) | not tested (CDP IndexedDB can read but not write) | 5 runs. Two profiles isolated (H20-1 PASS 5/5); CDP reads (H20-4 PASS 5/5); the closed window's renderer exits 5.1, 2.8, 3.0, 5.2, 4.9 s after the close (H20-5 FAIL 2/5, PASS 3/5, threshold 5 s is Assumed); Chrome keeps running after its last window closes (a launcher must quit it itself) | chrome-app-155.0.8059.85-20261024T172110.247Z.json, chrome-app-155.0.8059.85-20261024T172126.890Z.json, chrome-app-155.0.8059.85-20261024T172143.839Z.json, chrome-app-155.0.8059.85-20261024T172209.705Z.json, chrome-app-155.0.8059.85-20261024T172227.847Z.json |
| webgpu-hello-triangle (WebGPU demo) | `https://webgpu.github.io/webgpu-samples/sample/helloTriangle/` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Electron 45.0.0 | loads, 1 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: true; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| webgpu-hello-triangle (WebGPU demo) | `https://webgpu.github.io/webgpu-samples/sample/helloTriangle/` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Google Chrome 155.0.8059.85 | loads, 1 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: true; console errors: 1; 1 of the console errors is the /favicon.ico 404 that only Chrome requests | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| webgpu-cubemap (WebGPU demo) | `https://webgpu.github.io/webgpu-samples/sample/cubemap/` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Electron 45.0.0 | loads, 1 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: true; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| webgpu-cubemap (WebGPU demo) | `https://webgpu.github.io/webgpu-samples/sample/cubemap/` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Google Chrome 155.0.8059.85 | loads, 1 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: true; console errors: 1; 1 of the console errors is the /favicon.ico 404 that only Chrome requests | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| webgpu-compute-boids (WebGPU demo) | `https://webgpu.github.io/webgpu-samples/sample/computeBoids/` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Electron 45.0.0 | loads, 1 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: true; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| webgpu-compute-boids (WebGPU demo) | `https://webgpu.github.io/webgpu-samples/sample/computeBoids/` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Google Chrome 155.0.8059.85 | loads, 1 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: true; console errors: 1; 1 of the console errors is the /favicon.ico 404 that only Chrome requests | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| three-animation-keyframes (WebGL demo) | `https://threejs.org/examples/webgl_animation_keyframes.html` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Electron 45.0.0 | loads, 4 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: false; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| three-animation-keyframes (WebGL demo) | `https://threejs.org/examples/webgl_animation_keyframes.html` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Google Chrome 155.0.8059.85 | loads, 4 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: false; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| three-shadowmap (WebGL demo) | `https://threejs.org/examples/webgl_shadowmap.html` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Electron 45.0.0 | loads, 1 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: false; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| three-shadowmap (WebGL demo) | `https://threejs.org/examples/webgl_shadowmap.html` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Google Chrome 155.0.8059.85 | loads, 1 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: false; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| three-webgpu-compute-birds (WebGPU demo) | `https://threejs.org/examples/webgpu_compute_birds.html` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Electron 45.0.0 | loads, 5 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: true; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| three-webgpu-compute-birds (WebGPU demo) | `https://threejs.org/examples/webgpu_compute_birds.html` | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Google Chrome 155.0.8059.85 | loads, 5 canvas(es) | not tested | n/a (no game save) | n/a | WebGPU used: true; console errors: 0 | demos-electron-45.0.0_chrome-155.0.8059.85-20261024T171657.566Z.json |
| spike probe page (capabilities, not a game) | `spikes/runtime-compat/probe/`, served from localhost | 2026-10-24 | macOS 27.0.1 (26A434), arm64, Apple M3 | Safari 27.0.1 (WebKit proxy for WKWebView; not WKWebView itself) | loads (H3 REPORTED, H5 REPORTED, H6 REPORTED: see notes) | n/a | n/a | n/a | /coi/: crossOriginIsolated true, SharedArrayBuffer defined true, round trip true; control crossOriginIsolated false; adapter apple/apple, 21 features, device true, compute readback true; WebGL2 renderer string Apple GPU; software renderer flag false. No frame time was taken | safari-27.0.1-20261024T171525.689Z.json |

## Capability probe and measurements on the same machine

| Item | Electron | Chrome | Notes |
| --- | --- | --- | --- |
| WebGL2 renderer (H6) | ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version) | hardware renderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version) | Playwright bundled Chromium 156.0.8078.4: PASS |
| WebGPU adapter and features (H5) | apple/metal-3, 24 features | adapter apple/metal-3, 23 features, device true, compute readback true; Electron 45 had 24 features | only in Electron: texture-compression-unaligned |
| Cross-origin isolation with server headers (H3) | crossOriginIsolated true, SharedArrayBuffer Atomics round trip with a Worker works, control false | /coi/: crossOriginIsolated true, SharedArrayBuffer round trip true; control false (no PASS or FAIL for the baseline) | |
| Frame time, capped scene (H7) | not run | not run | not run |
| Frame time, Chrome `--app` (H20-6) | n/a | not run | not run |
| Spawn to first frame, cold and warm (H8) | not run | not run | medians of 3; cold = empty profile, OS file cache not flushed |
| Memory after 60 s of the scene (H9) | not run | not run | process tree summed from outside with `ps` and `footprint`; definitions differ between runtimes, no percentage is claimed |

## Not tested

These have no run, so none of them is verified. Each reason is the actual state of this spike.

| Platform or item | Status | Reason |
| --- | --- | --- |
| Windows on real hardware (any GPU) | not tested | no Windows machine is available |
| Windows, GitHub-hosted runner, no GPU | not tested | the optional non-GPU CI job was not added: the spike runner's process accounting is macOS-only, and a `workflow_dispatch` workflow can only be started once its file is on the default branch, which this task may not change. Even if run, it would prove install and non-GPU storage checks only, never game compatibility |
| Linux | not tested | no Linux machine is available |
| Other Macs, other macOS versions, other displays | not tested | one machine only |
| Tauri 2 with WKWebView (H17, H18) | not tested | not run, decision-irrelevant (controller ruling R27): per the decision rules Tauri wins only by passing a criterion Electron fails, Electron passed all fatal criteria measured so far except H7, which Tauri cannot replace; and the save-transfer mechanism (ADR-0005) needs CDP, which WKWebView lacks |
| Gamepad input | not tested | no hardware |
| Real Emscripten or Unity builds, heavy ports of commercial games | not tested | none is available; `progress-lab` only imitates the IDBFS layout. Their completeness is unproven |
