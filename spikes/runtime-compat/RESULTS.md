# Runtime compatibility spike: results

> **THROWAWAY.** Outcomes of the pre-registered hypotheses in [HYPOTHESES.md](HYPOTHESES.md), which stay frozen.
> Nothing below changes a threshold; every interpretation or deviation from a method is listed in its own section. This
> file covers Electron (Task 5); Task 6 adds the Chrome baseline (H19, H20), Tauri (H17, H18) and the public demos (H21).

## Run

- **Date:** 2026-10-24. **Command:** `node run.mjs --runtime=electron` (all groups), then twice `node run.mjs
  --runtime=electron --only=memory --load=512` for H9.
- **Machine:** MacBook Air with Apple M3 (model `Mac15,12`, fanless), 10-core GPU (Metal 4), built-in Retina display at
  1470 x 956 points, scale factor 2, 60 Hz (Electron `displayFrequency` 60.0024), one display, on AC power, screen
  unlocked. macOS 27.0.1 (26A434).
- **Runtime:** Electron 45.0.0 (Chromium 156.0.8078.48, Node 24.22.0, V8 15.6.75.19-electron.0). Spike tools:
  playwright-core 1.64.1, electron-builder 26.18.0, ajv 8.20.0, wasm-feature-detect 1.9.0; runner on Node 24.13.0.
- **Evidence:** every path below is under `results/`. The run aggregate is
  `electron-45.0.0-20261024T151511.707Z.json` ("aggregate"); probe payloads are the other files, each named by its
  timestamp and carrying its label. All 22 files of the run and the two H9 reruns validate against `results.schema.json`
  (`node validate.mjs results/*.json`), and the validator rejects deliberately corrupted copies.
- **Not extrapolated:** one machine, one OS. Nothing here says anything about Windows, Linux or other Macs.

## Summary

| H | Status | Evidence | One line |
| --- | --- | --- | --- |
| H1 | PASS | aggregate `hypotheses.H1`, `checks.storage.h1` | 0 of 5 kinds leaked in either direction; each window saw its own 5; same-partition control 5 of 5 |
| H2 | PASS | aggregate `checks.storage.h2` | All 5 kinds and both 1 MiB values (SHA-256 equal) back after `app.quit()` and relaunch; no process left before relaunch |
| H2b | reported | aggregate `checks.storage.h2b` | SIGKILL 5.0 s after the writes: the persistent cookie was lost; localStorage, IndexedDB (both 1 MiB values), Cache Storage and OPFS survived |
| H3 | PASS | `…150308.376Z` (/coi/), `…150309.211Z` (control) | `crossOriginIsolated` true, SharedArrayBuffer + Atomics round trip with a Worker; control false |
| H4 | PASS | `…150310.061Z` (injected), `…150310.887Z` (control) | Same with COOP/COEP added by `webRequest.onHeadersReceived` to the document and worker responses; control false |
| H5 | PASS (Electron side) | `…150312.029Z` (`checks.webgpu`) | Adapter `apple` / `metal-3`, 24 features, device created, compute readback correct, no switch. Feature count vs Chrome: Task 6 |
| H6 | PASS | `…150312.029Z`, every frame-time file | `ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)` in every run |
| H7 | not decided | `…150833.269Z`, `…150926.645Z`, `…151019.994Z` | Electron only: p50 16.7 ms, p95 18.6 / 18.7 / 18.7 ms, 0 long frames. Verdict needs the calibrated Chrome baseline (Task 6) |
| H7b | reported | `…151113.336Z`, `…151221.931Z`, `…151329.509Z` | Uncapped: p50 13.9 / 14.0 / 20.5 ms, p95 14.2 / 15.3 / 26.5 ms |
| H8 | reported | `…150631.684Z` to `…150636.190Z` | Spawn to first frame: cold 420, 362, 341 ms (median 362); warm 370, 369, 320 ms (median 369); all focused and visible |
| H9 | INVALID | aggregate `checks.memory`, `…151642.234Z`, `…152143.695Z` (reruns) | In all three attempts the window was hidden and lost focus 4 to 6 s into the 60 s because the machine was in use |
| H10 | PASS | aggregate `checks.sqlite` | `node:sqlite` (SQLite 3.53.4) and zstd work in the main process and a `utilityProcess`; no warning emitted |
| H11 | PASS | aggregate `checks.playwright` | `_electron.launch`, `firstWindow`, click, `evaluate` in main, close. Playwright turns iframe storage partitioning off |
| H12 | FAIL | aggregate `checks.permissions` | Camera, geolocation, notifications, display capture denied and logged; the microphone request never reached the handler (8 s timeout) |
| H13 | INVALID | aggregate `checks.permissions` | Control not rejected: `navigator.keyboard.lock()` succeeds without a gesture. Injected input does grant gestures |
| H14 | PASS | aggregate `checks.h14`, `hypotheses.H14` | Variants a, b, c, d: Hd equals Hs, negative control differs, no game code ran in any quiescent window |
| H15 | PASS | aggregate `checks.package` | One main process in every case; id `x` via `open-url` (not running, running) and `second-instance` (second executable) |
| H16 | FAIL | aggregate `checks.h16` | The closed window's renderer lived 27.8 s, until the game's service worker stopped; windows and quit cleanup fine |

Decision-rule view (HYPOTHESES section 4), Electron side only: none of the Electron fatal criteria that can be judged
without Chrome failed (H1, H2, H3 PASS; H5 has an adapter without the switch; H6 hardware). H7 has no verdict yet, so
ADR-0002 cannot be accepted from this file alone. H3 passed on 45.0.0, so no 44.9.x retry was run.

## Per hypothesis

### H1 and H2: partition isolation and persistence

- Two hidden windows (sandbox and context isolation on, no preload) on `persist:spike:a` and `persist:spike:b` loaded
  `http://localhost:4418/storage.html` from the spike server. Writer A wrote one marker per kind: localStorage key,
  IndexedDB record holding a Blob and a Date, a cookie with `Max-Age=172800`, a Cache Storage entry and an OPFS file,
  plus a 1 MiB Blob and a 1 MiB Uint8Array in IndexedDB. B read before and after writing its own markers; then A read
  B's. Leaked kinds A to B: 0 (before B wrote) and 0 (after); B to A: 0. Own markers: A 5, B 5. Control (second window
  on `persist:spike:a`): 5 of 5.
- The app quit with `app.quit()`; the runner found 0 processes of the Electron bundle before relaunching with the same
  user-data directory. After relaunch A saw its 5 kinds and B its 5, both large values with equal SHA-256, and still no
  cross-partition leak.
- H2b: a separate partition (`persist:spike:k`) was written, then the main process got SIGKILL 5002 ms later (the
  helpers exited with it; 0 left after 10 s). After relaunch localStorage, IndexedDB (including both 1 MiB values),
  Cache Storage and OPFS were there; the persistent cookie was not. Assumed explanation: Chromium flushes the cookie
  store lazily, so an abrupt kill loses recent cookie writes.

### H3 and H4: cross-origin isolation

- H3: `http://localhost:4418/coi/` (server sends COOP `same-origin`, COEP `require-corp`, CORP `same-origin`) reported
  `crossOriginIsolated: true`; a `SharedArrayBuffer` was posted to a Worker, the page stored and notified, the worker
  woke from `Atomics.wait`, stored back and notified, and `Atomics.waitAsync` returned `ok`. The same page at `/`
  reported `false` and no `SharedArrayBuffer`.
- H4: the plain page in a session whose `onHeadersReceived` adds the three headers to every response (the injection log
  lists `mainFrame /`, `script /probe.js`, `script /scene.js`, `script /coi-worker.js` and the results POST) reported
  `true` with a working round trip; the same page in a session without injection reported `false`.
- So the Electron 41 regression (#50242) is absent in 45.0.0 on this machine, for both server and injected headers.

### H5 and H6: WebGPU and WebGL2

- WebGPU without any switch: adapter vendor `apple`, architecture `metal-3`, `device` and `description` empty strings,
  `isFallbackAdapter` false, 24 features (including `shader-f16`, `subgroups`, `timestamp-query`, the BC, ETC2 and ASTC
  texture compression families), `requestDevice()` succeeded and a one-workgroup compute pass wrote `i * 3 + 7` for 64
  invocations, read back correctly from a mapped buffer. `enable-unsafe-webgpu` was not needed and not used. The H5
  verdict proper compares the feature count with Chrome (H19, Task 6); FAIL is impossible here because the adapter
  exists.
- WebGL2: `ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)`, vendor `Google Inc. (Apple)`, 36
  extensions including `EXT_disjoint_timer_query_webgl2` (relevant to the H7 calibration fallback). Every frame-time
  run recorded the same renderer string for its own scene context.
- Other probe results in the same file, reported only: wasm-feature-detect 1.9.0 reports every feature except
  `typeReflection` and `wideArithmetic` (threads, SIMD, relaxed SIMD, exceptions, GC, memory64, JSPI, tail calls and the
  rest true); storage quota about 2.95 GB, `persist()` true; OPFS write and read back; IndexedDB Blob and Date round
  trip; `AudioContext` starts `running` at 44.1 kHz.

### H7 and H7b: frame time (Electron numbers only)

- Scene: `probe/scene.js`, fixed seed and frame-indexed camera path, 1024 instanced cubes over a full-screen pass whose
  per-pixel loop count is the load; viewport 1280 x 720 CSS pixels (verified as `innerWidth` and `innerHeight` in every
  file), 2560 x 1440 drawing buffer, 2 s warm-up, 20 s measured, vsync interval 16.666 ms from `displayFrequency`.
- Provisional load: an Electron-only sweep with vsync off gave p50 2.5, 3.8, 7.05 and 13.9 ms at loads 64, 128, 256
  and 512; 512 is the first inside the 60 to 120% band (83%), so the runs used load 512. This is not the H7
  calibration, which happens in Chrome.
- Capped (default) runs, each after a 30 s cooldown: p50 16.7 ms in all three; p95 18.6, 18.7, 18.7 ms; 0 long frames
  (> 33.3 ms) in 1200, 1200 and 1201 frames. Every run visible and focused throughout.
- H7b, `--disable-frame-rate-limit --disable-gpu-vsync`: p50 13.9, 14.0, 20.5 ms; p95 14.2, 15.3, 26.5 ms; long frames
  0, 0, 32. The third run was slower; see the findings on GPU backlog and heat.
- No verdict: H7 compares Electron p95 with a calibrated Chrome p95 in alternating E, C runs and applies the noise rule
  to Chrome's spread. Both need Task 6.

### H8: cold and warm start

The runner took `Date.now()` immediately before `spawn()`; the page drew the scene once and reported `Date.now()` in
its next `requestAnimationFrame` callback. Cold (fresh user-data directory): 420, 362, 341 ms. Warm (immediate relaunch,
same directory): 370, 369, 320 ms. Medians 362 and 369 ms: on this machine and with the OS file cache warm, cold and
warm do not differ meaningfully. Every run had the window visible and focused at its first frame.

### H9: memory

INVALID in three attempts (`checks.memory` of the aggregate, `…151642.234Z` and `…152143.695Z`). Full run: the window
lost focus at 5.5 s and then became hidden. Second attempt: hidden at 6.1 s, focus lost at 6.4 s; a diagnostic run that
logged the frontmost app every 0.5 s showed Electron in front for about 4 s, then Google Chrome again. Third attempt,
started only after 91 s without keyboard or trackpad input: hidden at 3.9 s while still focused, then blur, the pattern
of a Space switch; macOS reported a trackpad event from the built-in keyboard and trackpad about 4 s into the run
(`pmset -g assertions`, `UserIsActive`). So someone was using the machine; the runs are not results. The numbers they
would have reported (sum of `workingSetSize` over `app.getAppMetrics()`: about 312, 323 and 323 MiB; field names
`workingSetSize` and `peakWorkingSetSize`, in KiB) are recorded but do not count. To get a valid H9: `node run.mjs
--runtime=electron --only=memory --load=512` while nobody touches the machine for a minute.

### H10: `node:sqlite` and zstd

In the main process and in a `utilityProcess` (ESM entry, `stdio: "pipe"`): file database in the user-data directory,
`PRAGMA journal_mode = WAL` returned `wal`, table with a BLOB column, 100 inserts through a prepared statement, select,
`PRAGMA user_version = 7` written and read, close and reopen (rows, user version and WAL mode kept), and a 1 MiB
`zlib.zstdCompressSync` / `zstdDecompressSync` round trip with equal SHA-256. `process.versions.sqlite` is 3.53.4. No
warning was emitted in either process. A synthetic `ExperimentalWarning` was captured by the same listener in Electron,
and plain Node 24.13.0 does emit "SQLite is an experimental feature", so the absence is real for Electron 45's Node
24.22.0. Its stability label was not checked.

### H11: Playwright

`_electron.launch({ args: [electronDir, "--mode=h11", ...] })` started the spike app, `firstWindow()` returned the
progress-lab window, a click on `#play-step` changed the hash, `app.evaluate` in the main process returned the Electron
version, and `app.close()` left no process. The `connectOverCDP` fallback was not needed. Important for later
end-to-end tests: under `_electron.launch` the main process sees `--disable-features=...,ThirdPartyStoragePartitioning,...`
(Playwright's loader appends it), and a cross-site iframe then **shares** storage with the top level; with a normal
launch it is partitioned. Re-appending the `disable-features` list without that entry in the main process (the last
value of a switch wins) restored partitioning under Playwright. Only the normal launch counts for the runtime decision.

### H12: deny-by-default permissions

- Handlers on the session allowed only `fullscreen`, `pointerLock` and `keyboardLock` and logged every call. Camera:
  request `media` with `["video"]`, denied, `NotAllowedError` after 313 ms. Geolocation: request denied, error code 1.
  Notifications: request and check denied, `requestPermission()` resolved `denied`. Display capture (after an injected
  click): request `display-capture` with `["video"]`, denied, `NotAllowedError`. Fullscreen, pointer lock and keyboard
  lock: requests logged and allowed, each call succeeded alone after an injected click. Control (handlers set to
  `null`): `Notification.requestPermission()` resolved `granted`.
- Microphone: `getUserMedia({ audio: true })` neither resolved nor rejected within 8 s and the handler was **never
  called** (no request or check with `audio`). Development observations, not in the committed files: a stuck audio
  request also blocked a later video request in a separate script; `systemPreferences.getMediaAccessStatus` reports
  `not-determined` for both microphone and camera for the development Electron binary (`com.github.Electron`); and a
  macOS `UserNotificationCenter` process started at the moment of the first microphone request and was still running. Assumed explanation: Chromium opens the audio input device before asking for
  permission, which makes macOS ask for microphone access first; not visually confirmed (no screen access). By the
  frozen rule ("any of the eight has another outcome") H12 is FAIL. The security invariant still holds in the sense that
  no audio was captured, but "deny by default, logged" cannot be shown for the microphone until this is understood,
  ideally with a packaged app and a decided OS-level permission.

### H13: trusted input

- Without a gesture (`executeJavaScript`, no `userGesture`): `requestFullscreen()` rejected ("Permissions check
  failed"), `requestPointerLock()` rejected ("A user gesture is required"), but `navigator.keyboard.lock()` resolved.
  Keyboard lock does not require user activation, so the frozen control ("the same calls without a gesture must be
  rejected") cannot hold for it, and the run is INVALID by rule.
- With injected input (`webContents.sendInputEvent` mouse down and up, and Enter key events on a focused button):
  every call succeeded when made alone, and all three succeeded in the order pointer lock, fullscreen, keyboard lock.
  In the order the method names (fullscreen, then pointer lock, then keyboard lock in one handler) pointer lock failed
  with "A user gesture is required", for mouse and for key input alike. Assumed explanation: `requestFullscreen()`
  consumes the transient activation in Chromium; Chrome in Task 6 can confirm it is not Electron-specific.
- Pointer lock also needs a focused window: while the screen was locked during development every pointer-lock call
  failed with `WrongDocumentError`.
- The manual run with a real click was not performed (it needs the owner at the machine).

### H14: quiescent export and restore

- Reference hashes from a fresh in-memory partition: 0 steps `e0bc6e48…`, 7 steps `b52d575f…`, 8 steps `4747e918…`.
- For each variant a new source partition (`persist:spike:src-<variant>-<run>`) played 7 steps; Hs was `b52d575f…`
  every time, equal to the reference. The game window was closed and the runner waited until the session had no
  running service worker (about 30 s where one was registered). Then a hidden quiescent window on the same partition
  loaded `about:blank`, attached `webContents.debugger`, enabled Network (with `Network.setBypassServiceWorker`),
  Runtime, Debugger and auto-attach, and navigated to `http://localhost:4417/__wg_quiescent__`, which
  `ses.protocol.handle("http")` served as an empty stub (CSP `script-src 'none'`); every other request passed through
  `ses.fetch(..., { bypassCustomProtocolHandlers: true })`. The exporter ran in isolated world 1001 and read
  localStorage and every IndexedDB database with schema and records (tagged JSON: Date, ArrayBuffer, typed arrays and
  Blob). The importer ran the same way in a fresh partition (`persist:spike:dst-<variant>-<run>`), recreated both
  databases at the same versions with the same stores and indexes and put every record with its own key.
- Every variant: Hd equals Hs (`b52d575f…`); the negative control (first byte of `stepLog` key 1 `roll` flipped)
  restored into another fresh partition gave `0ed7f4db…`. Every quiescent window: only stub requests, the fixture
  server logged 0 requests during the export window, no script parsed in a main world other than our tagged read-only
  canary, no service-worker start or target, no controller, `window.progressLab` undefined.
- (a) The service worker was unregistered in the game window first. Afterwards one more step in the restored partition
  got key 8 (`stepLog` keys 1 to 8) and the hash `4747e918…`, the 8-step reference: explicit-key puts advance the key
  generator, and the restored game continues normally.
- (b) The service worker stayed registered (`http://localhost:4417/`, active). Export saw the registration in its
  inventory but no controller and no worker start. Canary-sensitivity control: the same stub navigation without
  `setBypassServiceWorker` was controlled by the service worker, which started (twice) and whose `sw.js` was parsed;
  the canary flagged all of that. So the bypass is what keeps the worker out.
- (c) Top level `http://localhost:4417/iframe-host.html?src=http://127.0.0.1:4417/`. The quiescent window recreated the
  pair (a localhost stub embedding a 127.0.0.1 stub, both from the protocol handler); the service-worker bypass also
  covered the cross-site iframe. CDP `Storage.getStorageKey` gave `http://localhost:4417/` for the top level and
  `http://127.0.0.1:4417/^0http://localhost` for the iframe, the same at export and restore. Electron's main-process
  `WebFrameMain` has no `executeJavaScriptInIsolatedWorld`, so the exporter ran in isolated world 1001 of the iframe
  through the window's preload (`nodeIntegrationInSubFrames`) calling `webFrame.executeJavaScriptInIsolatedWorld`. The
  restored game opened top level at 127.0.0.1 showed the empty state `e0bc6e48…`, documenting the partition.
- (d) In place: `ses.clearStorageData()` (no options) on the source partition left no database, no localStorage key, no
  cache, no service-worker registration and no cookie. The flipped snapshot restored in place gave `0ed7f4db…`; after a
  second wipe the real snapshot gave Hd `b52d575f…`.
- Wipe probes on the restored variant-c partition: `ses.clearStorageData({ origin: "http://127.0.0.1:4417" })` left
  the partitioned iframe storage untouched (both databases, localStorage, cache and service-worker registration still
  there); CDP `Storage.clearDataForStorageKey` with the iframe's storage key and `all` removed all of it.

### H15: packaged deep link

electron-builder 26.18.0 built `wgspike.app` for darwin-arm64 with `identity: null`; `codesign --force --deep --sign -`
gave `flags=0x2(adhoc)`, sealed resources, "valid on disk", and `CFBundleURLTypes` lists `wgspike`. A first launch with
`open <app>` registered it. (1) Not running: `open 'wgspike://launch?id=x'` started one main process and `open-url`
delivered id `x` before `ready`. (2) Running: the same command delivered `open-url` id `x` to the same process, still
one main process. A second launch of the executable with `--launch-game=x` briefly made two main processes; the second
did not get the single-instance lock and exited with code 0, the first logged `second-instance` with id `x`, one main
process remained. `setAsDefaultProtocolClient("wgspike")` returned true. Cleanup: `lsregister -u`, then the app,
`electron/dist/` and `~/Library/Application Support/wgspike` were deleted. One LaunchServices handler-preference record
(`wgspike` to the app's bundle id, written by `setAsDefaultProtocolClient`) stays in the database; it points to an app
that no longer exists. It was left alone because removing it means editing the LaunchServices secure preferences.

### H16: no leftover processes

The game window's renderer process was still alive 5 s after the window closed, so H16 is FAIL by rule. It hosted the
game's service worker, and it exited 27.8 s after the close, at the same moment the session reported no running
service worker. Window count was 0 after the close and 0 after a quiescent export; 5 s after the app quit no process of
the bundle remained. A launcher that wants the 5 s guarantee has to stop the game's service workers (or the process)
itself; this is a Chromium lifetime rule, not a crash.

## Deviations from the methods, and why

1. **Partition names (H14).** One source and one destination partition per variant and run
   (`persist:spike:src-a-<run>`, `persist:spike:dst-a-<run>`, plus `dst-neg-…` for the negative controls) instead of a
   single `persist:spike:src`, so variants cannot contaminate each other.
2. **Service-worker idle wait (H14).** Not in the method: before every export the runner waits until the session has no
   running service worker. In a dev run without the wait, variant d's canary flagged a `service_worker` target and a
   parsed `sw.js` that belonged to the worker still running from the just-closed game window (no controller, no request,
   no start); waiting makes the canary unambiguous. Product implication: export after the game's worker has stopped.
3. **Subframe exporter (H14c).** The method allows the stub's main world if Electron offers no isolated world for
   frames. Electron offers one only in the renderer, so the quiescent window (and only it) has a preload that calls
   `webFrame.executeJavaScriptInIsolatedWorld` on request. Our main-world canary (a read of `window.progressLab`) is the
   only code run in a stub's main world and is tagged by `sourceURL`.
4. **H12 "three are allowed"** was judged from each call made alone after an injected click, because in the H13 order
   the fullscreen call consumes the activation the pointer lock call needs. The as-specified order is reported in H13.
5. **H13 diagnostics.** Added single-call buttons and a pointer-lock-first order next to the specified handler; the
   verdict uses the specified handler and control only.
6. **H7.** The calibration sweep ran in Electron with vsync off, as a provisional choice of load; the calibration that
   counts is Chrome's (Task 6). Capped runs ran first and uncapped runs after, each after a 30 s cooldown, because an
   earlier dev run that interleaved them degraded the capped runs (p95 18.6 then 34.2 and 33.3 ms); with 60 s cooldowns
   and no uncapped runs in between, three capped runs were identical (p95 18.6 ms). Those dev runs are not committed.
7. **H1 page.** The storage page is `http://localhost:4418/storage.html` on the spike server (the method says
   `http://localhost:<n>/`); the origin is what matters, and it is the same for both windows.
8. **H2b** kills only the main process (helpers exit with it).
9. **H15** also calls `setAsDefaultProtocolClient`, which the method does not require.

## Findings and gotchas

- `webContents.debugger` commands, even `Network.enable`, wait forever on a window that has never navigated: load
  `about:blank` first.
- `app.getGPUFeatureStatus()` right after `ready` reports WebGL, WebGPU and GPU compositing as disabled; after
  `app.getGPUInfo("complete")` (or a rendered window) the same call reports them enabled.
- With `--disable-gpu-vsync --disable-frame-rate-limit` on macOS the page's `requestAnimationFrame` ran far ahead of
  the GPU during warm-up (2088 callbacks in the 1 s warm-up at load 512, about 2160 in the 2 s warm-up of each 22 s
  uncapped run), so the uncapped launches took 38.5, 37.4 and 63.5 s instead of about 23 s: 15 to 41 s of queued GPU
  work after the page had finished. Uncapped numbers are throughput, not presentation, and they heat the
  machine; `pmset -g therm` recorded no thermal warning, so heat as the cause of slower runs is Assumed. For Task 6:
  keep cooldowns, do not interleave uncapped and capped runs, and consider `EXT_disjoint_timer_query_webgl2` (available)
  for calibration.
- Timing checks need an unlocked screen: while it was locked, `loginwindow` was frontmost and no window could get focus.
  The runner skips the timing groups then.

## Open items for the owner

- H9 and the H13 manual real-click run need a run with nobody else using the machine.
- H12 microphone: decide the macOS microphone permission for the test binary (System Settings, Privacy and Security,
  Microphone) and rerun `--only=permissions`; a system prompt from the first request may still be open.
- Optional: remove the LaunchServices `wgspike` handler preference (harmless).
