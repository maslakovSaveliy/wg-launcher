# Compatibility methodology

How the runs behind [matrix.md](matrix.md) are made, and what their numbers do **not** mean. The hypotheses, thresholds and
decision rules are frozen in [`spikes/runtime-compat/HYPOTHESES.md`](../../spikes/runtime-compat/HYPOTHESES.md); the verdicts
with their evidence files are in [`spikes/runtime-compat/RESULTS.md`](../../spikes/runtime-compat/RESULTS.md). Claim tags
follow `AGENTS.md`: `Verified (date, source)`, `Assumed`, `Unverified`.

## Scope and honesty rules

- One machine, one operating system: a fanless MacBook Air (Apple M3), macOS 27.0.1, built-in display at 1470 x 956 points,
  scale factor 2, 60 Hz. Verified (2026-10-24, `machine` and `environment` of the aggregate result files).
- A runtime, game or OS is "verified" only after a recorded run on that OS with its date and versions. A platform that has no
  row in the matrix is **not tested**, never "probably works". A CI runner proves install and non-GPU checks only, never game
  compatibility.
- Results from this machine are not extrapolated to other Macs, to Windows, to Linux, to other GPUs, drivers or displays, and
  never turned into a frames-per-second promise for a user. They say how two runtimes compared here, on one scene.
- Invalid, inconclusive and not-run items are reported as such and never counted as a pass. A control that does not behave as
  expected makes a run INVALID (the probe cannot be trusted), never a failure of the runtime.

## How a run is made

- **Harness.** The shared probe page (`probe/probe.js`) and scene (`probe/scene.js`) are served by the spike server on
  `localhost` and run unchanged in every runtime; each posts a JSON result (schema `results.schema.json`) that carries the
  versions, the user agent, the visibility log and the page's own measurements. Aggregates (`kind: run`) hold the verdicts,
  the commands and the machine facts. Home directories, the repository path and the user name are replaced before anything
  is written. Verified (2026-10-24, `node validate.mjs results/*.json`).
- **Runtimes.** Electron 45.0.0 (Chromium 156.0.8078.48) driven by its own main process; the installed Google Chrome driven
  by Playwright 1.64.1 (`channel: "chrome"`, headed, fresh profile) as the baseline; the same Chrome started directly with
  `--app=<url>` and its own `--user-data-dir` per game (the fallback architecture); Playwright's bundled Chromium as a
  same-engine reference only, never as the baseline; Safari as a WebKit proxy (see below). The exact versions are in every
  result file.
- **Version mismatch.** The Chrome on the machine was 155.0.8059.85 while Electron 45 carries Chromium 156. HYPOTHESES.md says
  to update Chrome or mark the comparison "version mismatch"; the Chrome was not updated (it is the owner's browser), so every
  Chrome-versus-Electron number is marked as a mismatch of one major version. Playwright's bundled Chromium 156.0.8078.4 gives
  a same-major reference for capability checks only.
- **Playwright flags.** Playwright starts Chrome with its own switch list (for example `--disable-background-timer-throttling`,
  `--disable-renderer-backgrounding`, `--disable-field-trial-config`, `--force-color-profile=srgb`, and
  `ThirdPartyStoragePartitioning` disabled). Verified (2026-10-24, `playwright-core` 1.64.1 `chromiumSwitches`). The
  `--app` runs use a plain command line without them, so a difference between the two Chrome rows can come from the flags.
- **Window.** Every timing run uses a 1280 x 720 CSS-pixel viewport at scale factor 2 (a 2560 x 1440 drawing buffer). Electron
  sets the content size; Chrome's window is resized over CDP until `innerWidth` and `innerHeight` are exactly 1280 and 720;
  the viewport and the drawing buffer are recorded in every result and a run with other values is INVALID.

## Visibility, foreground and input

Timing and frame measurements are only valid when the page was visible and focused for the whole run, because occlusion and
background state throttle `requestAnimationFrame`. Each run records `document.visibilityState` and `document.hasFocus()` at
the start, at the end and on every `visibilitychange`, `blur` and `focus` event; a run in which the page was ever hidden or
unfocused is INVALID and is retried at most twice. The runner also records the time since the last keyboard or trackpad input
before and after each run (IOHIDSystem idle time) and the power source; input during a run, or battery power, makes it
INVALID. It holds the display awake with `caffeinate -d -i` for the duration. The owner must leave the machine alone during
these runs. A locked screen puts the login window in front, so the runner refuses to start then.

## Cold and warm start (H8)

Spawn to first presented frame: the runner takes the wall time immediately before starting the process; the page reports the
wall time of its first `requestAnimationFrame` callback after the first draw of the scene. **Cold** is the first launch with an
empty user-data directory; **warm** is an immediate relaunch with the same directory. The operating system's file cache is not
flushed, so "cold" means cold application state, not a cold disk. Focus and visibility are required from the first frame.
Three cold and three warm launches per runtime, alternating between runtimes; the median and every value are reported.
Chrome is started directly (not through Playwright) so that no automation setup time is included.

## Frame time (H7, H7b, H20-6)

- **Scene.** One fixed WebGL2 scene: a fixed seed, a camera path that is a function of the frame index only, 1024 instanced
  cubes over a full-screen pass whose per-pixel loop count is the load. Frame time is the difference between consecutive
  `requestAnimationFrame` timestamps; a long frame is a difference above twice the vsync interval (1000 divided by the display
  refresh rate).
- **Calibration.** A vsync cap can hide differences, so the scene must put real load on the GPU. In Chrome with the frame-rate
  limit and vsync disabled (`--disable-gpu-vsync --disable-frame-rate-limit`), the scene's median frame time must be 60% to
  120% of the vsync interval; the load is raised or lowered until it is, then fixed and used unchanged for every runtime and
  recorded. The 60% and 120% bounds are Assumed (HYPOTHESES.md). A run on an uncalibrated or saturated scene is INVALID.
- **Runs.** 2 s warm-up discarded, then 20 s measured; three valid runs per runtime, alternating between runtimes (Electron,
  Chrome, Chrome `--app`, Electron, ...) with a cooldown between runs to spread thermal drift. Each statistic (p50, p95, long
  frame count and share) is the median of the valid runs. Capped runs come before uncapped ones, because uncapped runs leave
  seconds of queued GPU work and heat behind that slowed later capped runs in an earlier experiment. Verified (2026-10-24,
  Electron spike dev runs, `spikes/runtime-compat/RESULTS.md` findings).
- **Verdict.** Electron passes when its p95 is at most Chrome's p95 times 1.15. **Noise rule:** the spread of Chrome's p95 is
  (maximum minus minimum) divided by the median over its runs; at 15% or more the comparison is INCONCLUSIVE, both runtimes
  are rerun with five runs each, and if the spread is still 15% or more the result stays INCONCLUSIVE and is not counted as a
  pass. Chrome itself has no pass or fail: it is the baseline.
- **Validity.** The WebGL2 renderer string must not contain "SwiftShader" (a software renderer makes the run INVALID and every
  number of it is discarded). Uncapped numbers are throughput, not presentation.

## Memory (H9)

After 60 s of the scene, the process tree of each runtime is summed from outside with the same two tools: resident size (`ps`)
and physical footprint (macOS `footprint`). Electron also reports its own `app.getAppMetrics()` working-set sum. The
definitions differ between runtimes and tools, so the numbers are shown side by side and never turned into a percentage claim.
Chrome's tree includes its own browser user interface and helpers, which an Electron app does not have (Assumed); both sums
include everything the runtime started for the run.

## Public demos (H21)

Three webgpu-samples pages and three three.js examples, listed in `spikes/runtime-compat/demos.json` before any demo run.
Each is loaded in Electron and in Chrome with the same hooks injected before any page script (WebGPU adapter and device
calls, canvas context types, visibility log), the same console-error counting over CDP, the same window size and a 6 s
settle time. The load check says whether the page loads, has a canvas, used WebGPU and logged errors. The 20 s frame sampler
is the H7 sampler on a page that is **not calibrated**: its numbers are indicative only. These are external sites: an
unreachable one is "not tested (unreachable)", never a compatibility verdict. Chrome requests `/favicon.ico` and Electron
does not, so a 404 for it counts as a Chrome-only console error and is called out separately.

## Safari as a WebKit proxy

The Tauri comparison was not built (controller ruling R27, see `RESULTS.md`). As a cheap indication of what a system
WebKit engine does on this machine, the probe page was opened in Safari and its capability checks recorded: WebGPU adapter,
WebGL2 renderer, cross-origin isolation, SharedArrayBuffer, storage, OPFS, IndexedDB. This is **Safari, not WKWebView**: the
embedded WebView of an app can differ in settings, entitlements and storage. No frame time was measured in Safari.

## Chrome `--app` per game (H20)

The installed Chrome is started directly with `--app=<url>`, one `--user-data-dir` per game and a DevTools port chosen by
Chrome. The checks: isolation of two profiles with the five-kind storage markers of H1; persistence after a graceful quit
(`Browser.close`) and relaunch; whether the window has a tab strip or address bar (measured by the height of the browser
UI and a screenshot read by a person); a CDP attach with storage reads (`DOMStorage`, `IndexedDB.requestData`); and process
cleanup after closing the window and after quitting. The progress-lab fixture is the "game" for the last three. CDP's
IndexedDB domain can read but not write, so restore is not part of this mode.

## What the results do not mean

- They do not say a game "works" on Electron, Chrome or Safari: they say what a controlled fixture, three public WebGPU
  samples and three three.js examples did here. Heavy ports of commercial games, real Emscripten or Unity builds and gamepad
  input were not tested (no hardware, no samples). Completeness of such ports is unproven.
- They do not say anything about Windows or Linux, about integrated or discrete GPUs other than the Apple M3, or about other
  display refresh rates. An optional Windows non-GPU CI run, if it were ever added, would be recorded as "Windows (GitHub-hosted
  runner, no GPU)" and would prove install and non-GPU storage checks only.
- They do not support a frames-per-second claim or a speed-up claim. A p95 ratio on one calibrated scene on one machine is not
  a product number.

## Regenerating the matrix

`node spikes/runtime-compat/matrix.mjs > docs/compat/matrix.md` rebuilds the matrix from the committed result files. It reads no
clock and no environment, so running it twice gives identical output (checked by running it twice and comparing with `diff`).
