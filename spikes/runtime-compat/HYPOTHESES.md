# Runtime compatibility spike: hypotheses

> **THROWAWAY.** This spike area is temporary: after ADR-0002 is decided, its code is deleted or archived and only the
> results are kept (in ADR-0002 and `docs/compat/`).
>
> **Written on 2026-10-24, before any spike code was written and before any measurement ran.** The hypotheses and
> thresholds below are fixed. After the first run they change only through a dated entry in "Amendments" at the end.

## 1. Purpose

Decide, with evidence from one real machine, whether Electron 45 is good enough as the desktop runtime, compared with
Tauri 2.12 and with plain Chrome 156. Background facts and sources are in
[runtime-and-storage.md](../../docs/research/runtime-and-storage.md). Results feed ADR-0002 (runtime) and ADR-0005 (save
transfer).

## 2. Conventions

- **Verdicts:** PASS, FAIL, INVALID (the run is unusable, for example a software renderer; rerun up to 3 times),
  INCONCLUSIVE (H7 only, see its noise rule), CONDITIONAL (H5 only) and N/A (cannot be run; the reason is recorded).
  INVALID, INCONCLUSIVE and N/A are never counted as PASS. A control that does not give its expected result makes the
  run INVALID, never FAIL, because the probe cannot be trusted. An INVALID that persists in one runtime while the other
  runtime's run is valid counts as FAIL for the criterion it blocks.
- **Visibility:** every timing or frame measurement (H7, H8, H9, H18 to H21) runs with the window visible, unobscured
  and in the foreground for the whole run, because occlusion and background state throttle `requestAnimationFrame` and
  timers. Each run records `document.visibilityState` and `document.hasFocus()` at the start, at the end and on every
  `visibilitychange`, `blur` and `focus` event; a run in which the page was ever hidden or unfocused is INVALID.
- **Machine:** the dev Mac (macOS arm64, Apple M3), plugged in, one display, no other heavy apps. Record OS version,
  display refresh rate, GPU and exact runtime versions with every result. Nothing from this machine is extrapolated to
  other machines or operating systems.
- **Runtimes:** Electron 45.0.0 (Chromium 156.0.8078.48); Electron 44.9.x only where a hypothesis says retry; Tauri
  2.12.x; Chrome stable, expected 156.x so the engine matches Electron 45. Record the exact Chrome version; if its major
  differs from 156, update Chrome first or mark the comparison "version mismatch".
- **Fixtures:** the shared probe page POSTs JSON to the spike server (schema `results.schema.json`, created in the
  Electron spike task). The controlled game `progress-lab` is built in an earlier task with this interface: `node
  server.mjs --port <n>` serves on both `localhost` and `127.0.0.1`; ids `#play-step`, `#reset`, `#progress-hash`;
  `?ephemeral=1` wipes storage on load; the `/coi/` path prefix adds COOP and COEP headers; `iframe-host.html?src=<url>`
  embeds a game cross-site; the game registers a service worker `sw.js`.
- **Frame-time scene:** one fixed WebGL2 scene (fixed seed and camera path), viewport 1280 by 720 CSS pixels in every
  runtime, 2 s warm-up discarded, then 20 s measured. Frame time is the delta between consecutive
  `requestAnimationFrame` timestamps. A long frame is a delta above 2 times the vsync interval (1000 divided by the
  display refresh rate). Each statistic is the median of 3 runs; runs alternate between runtimes (E, C, E, C, E, C) to
  spread thermal drift.
- **Cold and warm start:** cold is the first launch with an empty user-data directory; warm is an immediate relaunch with
  the same directory. The OS file cache is not flushed, so "cold" means cold app state, not cold disk.
- **Process-exit threshold:** 5 s is an assumed value (Assumed), used by H16.

## 3. Hypotheses

### H1. Partition isolation

- **Tests:** data written by a page in one session is invisible to a page of the same origin in another session.
- **Runtime:** Electron 45.0.0.
- **Method:** two windows (sandbox on, context isolation on, no preload) on partitions `persist:spike:a` and
  `persist:spike:b`, both loading `http://localhost:<n>/` from the same spike server. Window A writes one marker of each
  kind: a localStorage key, an IndexedDB record (with a Blob and a Date), a persistent cookie (`Max-Age` of at least one
  day; a session cookie would not survive the restart in H2), a Cache Storage entry and an OPFS file. Window B reads all five; then the roles swap. Control: two windows on the same partition `persist:spike:a`.
- **Metric:** number of marker kinds visible across partitions, 0 to 5 per direction.
- **PASS:** 0 leaked kinds in both directions, each window sees its own 5, and the control sees 5 of 5. **FAIL:** any
  leaked kind. A control below 5 of 5 makes the run INVALID (the probe cannot detect sharing).
- **FAIL means:** Electron partitions cannot back per-game sessions. Fatal for Electron.

### H2. Persistence across restart

- **Tests:** data survives a full application restart.
- **Runtime:** Electron 45.0.0.
- **Method:** after H1's writes (plus a 1 MiB Blob and a 1 MiB Uint8Array in IndexedDB), quit with `app.quit()`, confirm
  no process of the app remains, relaunch, and read the markers back in the same partitions. Variant H2b (reported, no
  threshold): kill the app with SIGKILL 5 s after the writes and record which kinds survived.
- **Metric:** all marker kinds present in the right partitions, and the SHA-256 of the large values equal.
- **PASS:** everything present and byte-equal after the graceful quit. **FAIL:** anything lost or altered. Session
  cookies are excluded from this comparison, because they are not kept across restarts by design.
- **FAIL means:** progress would not survive normal use. Fatal for Electron.

### H3. Cross-origin isolation with server headers

- **Tests:** `crossOriginIsolated` is true when the server sends the right headers.
- **Runtime:** Electron 45.0.0; if it fails, retry on the latest 44.9.x.
- **Method:** load `http://localhost:<n>/coi/` (the fixture server adds `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`). The page reads `crossOriginIsolated`, creates a `SharedArrayBuffer`,
  shares it with a Worker and waits for an `Atomics.notify` round trip. Control: the same page without `/coi/` must
  report false.
- **Metric:** `crossOriginIsolated` and the round trip.
- **PASS:** true and the round trip works, control false. **FAIL:** false on 45.0.0, then retry on 44.9.x; fatal only
  if both fail. A control that reports true makes the run INVALID.
- **FAIL means:** games needing threads or shared memory (for example Emscripten with pthreads) cannot run; the known
  Electron 41 regression (#50242) would still be present.

### H4. Cross-origin isolation with injected headers

- **Tests:** isolation also works when the host injects the headers.
- **Runtime:** Electron 45.0.0; if it fails, retry on the latest 44.9.x, as in H3.
- **Method:** serve the page without COOP and COEP; in the session, `webRequest.onHeadersReceived` adds both headers to
  the document and its worker responses; check as in H3.
- **Metric and thresholds:** as H3, including its control (an unexpected control result is INVALID). **PASS:** true and
  round trip works on 45.0.0 or on the 44.9.x retry. **FAIL:** false on both.
- **FAIL means:** games whose server lacks the headers cannot be helped by the launcher and stay "Compatibility not
  verified". Not fatal.

### H5. WebGPU adapter and device

- **Tests:** WebGPU is usable in Electron wherever Chrome has it.
- **Runtime:** Electron 45.0.0 against Chrome (H19); retried with the `enable-unsafe-webgpu` switch if the adapter is null.
- **Method:** the probe calls `navigator.gpu.requestAdapter()`, records `adapter.info` (vendor, architecture, device,
  description), features and limits, then `requestDevice()` and runs a one-workgroup compute pass whose result is read
  back from a mapped buffer.
- **Metric:** adapter non-null, device created, readback value correct, adapter info, feature count against Chrome.
- **PASS:** all of it without any switch. **CONDITIONAL:** works only with `enable-unsafe-webgpu`. **FAIL:** adapter
  null even with the switch while Chrome has one. If Chrome has none either, the comparison is N/A. The split into PASS,
  CONDITIONAL and FAIL is Assumed; the brief names only "null even after the switch" as fatal.
- **CONDITIONAL means:** not fatal, but the risk is recorded in ADR-0002 and the question becomes an owner decision
  (PRD OQ-7). The switch is experimental and conflicts with our no-experimental-features rule, so production must not
  ship it without an ADR; until then WebGPU-dependent games stay "Compatibility not verified". Assumed
- **FAIL means:** heavy WebGPU games cannot run in Electron on this machine. Fatal for Electron if Chrome passes.

### H6. WebGL2 renderer is hardware

- **Tests:** WebGL2 runs on the GPU, not on a software renderer.
- **Runtime:** every runtime that takes part in H7.
- **Method:** create a WebGL2 context and read `UNMASKED_RENDERER_WEBGL` through `WEBGL_debug_renderer_info`.
- **Metric:** the renderer string.
- **PASS:** it does not contain "SwiftShader" (case-insensitive). **INVALID:** it does; discard every GPU or frame-time
  number of that run and retry up to 3 times. **FAIL:** a persistent software renderer in Electron while Chrome reports
  hardware.
- **FAIL means:** the GPU path of Electron is broken here. Fatal GPU criterion for Electron.

### H7. Frame time against Chrome

- **Tests:** Electron renders the same scene as smoothly as Chrome.
- **Runtime:** Electron 45.0.0 against Chrome (H19); the same method is reused for Tauri (H18) and Chrome `--app` (H20).
- **Calibration (before any comparison):** a vsync cap can hide differences, so the scene must put real load on the GPU.
  In Chrome with the frame-rate limit and vsync disabled (the H7b conditions below), the scene's p50 frame time must be
  between 60% and 120% of the vsync interval. If it is lower, increase the scene load and recalibrate; the final load is
  then fixed for every runtime and recorded. The 60% and 120% bounds are Assumed. If Chrome's cap cannot be removed,
  calibrate with a GPU timer query (`EXT_disjoint_timer_query_webgl2`, availability Unverified); if neither works, H7 is
  N/A. A run on an uncalibrated or saturated scene (Chrome sitting at the vsync interval with no load pressure) is
  INVALID, never PASS.
- **Method:** the frame-time scene from section 2 at the calibrated load, 3 alternating runs per runtime, same viewport
  size, only valid runs (H6, visibility, calibration).
- **Metric:** p50 and p95 frame time, count and share of long frames, each the median of the runs.
- **Noise rule:** the spread of Chrome's p95 is (max minus min) divided by the median over its runs. If it is 15% or
  more, the comparison is INCONCLUSIVE: rerun both runtimes with 5 runs each before any verdict. If the spread is still
  15% or more, H7 stays INCONCLUSIVE, is not counted as PASS, and the owner decides (decision rule 5). Assumed
- **PASS:** Electron p95 is at most Chrome p95 times 1.15. **FAIL:** above that. p50 and long frames are reported, not
  thresholded.
- **Variant H7b (reported):** the same scene with the frame-rate limit and vsync disabled in both runtimes (Chromium
  switches such as `--disable-frame-rate-limit` and `--disable-gpu-vsync`; names Unverified, check at run time). It
  doubles as the calibration condition above.
- **FAIL means:** the runtime costs frames the user would notice. Fatal for Electron.

### H8. Cold and warm start

- **Tests:** time from process start to the first presented frame of the scene (reported, no threshold).
- **Runtime:** Electron, Chrome, Tauri.
- **Method:** the runner records wall time at spawn; the page reports wall time at its first `requestAnimationFrame`
  callback after the first draw. 3 cold and 3 warm launches per runtime.
- **Metric:** milliseconds, median and all values. **PASS and FAIL:** none; the numbers back later claims and nothing else.

### H9. Memory

- **Tests:** memory use after 60 s of the scene (reported, no threshold).
- **Runtime:** Electron, Chrome, Tauri.
- **Method:** Electron sums per-process memory from `app.getAppMetrics()` (field names Unverified, check at run time);
  Chrome uses the per-process memory footprint in its Task Manager, summed by hand with a saved screenshot; Tauri uses
  the resident size summed over its process tree.
- **Metric:** MiB per runtime. The definitions differ, so the numbers are shown side by side and never turned into a
  percentage claim.

### H10. `node:sqlite` and zstd in Electron

- **Tests:** SQLite and zstd compression work in the main process and in a `utilityProcess`.
- **Runtime:** Electron 45.0.0.
- **Method:** in each process, open a file database in the user-data directory, set WAL mode, create a table, insert and
  select rows, write and read `PRAGMA user_version`, close and reopen; round-trip 1 MiB through `zlib.zstdCompressSync`
  and `zlib.zstdDecompressSync`. Record any experimental warning and its text.
- **PASS:** every step works in both processes. **FAIL:** a missing module, a crash or a mismatch in either.
- **FAIL means:** fall back to `better-sqlite3` (a native addon that needs a rebuild) or another compressor; affects
  ADR-0004. Not fatal.

### H11. Playwright with Electron

- **Tests:** end-to-end tests can drive the Electron app.
- **Runtime:** Electron 45.0.0.
- **Method:** `_electron.launch` with the spike main file, `firstWindow()`, a click on `#play-step`, `evaluate` in the
  main process, clean close. If that fails, `connectOverCDP` against `--remote-debugging-port`.
- **PASS:** `_electron.launch` works. **FALLBACK:** only `connectOverCDP` works. **FAIL:** neither.
- **FAIL means:** launcher end-to-end tests need another approach. Not fatal.

### H12. Deny-by-default permissions

- **Tests:** the permission handlers block five sensitive permissions and allow only the three we need.
- **Runtime:** Electron 45.0.0.
- **Method:** a session with `setPermissionRequestHandler` and `setPermissionCheckHandler` that allow only `fullscreen`,
  `pointerLock` and `keyboardLock` and log every denial. The page requests camera, microphone, geolocation,
  notifications and display capture (`getDisplayMedia`, which arrives as `display-capture` in Electron 45), then
  fullscreen, pointer lock and keyboard lock; requests that need a gesture use trusted input (H13). Control: with the
  handlers removed, `Notification.requestPermission()` resolves `granted` (Electron approves by default); camera,
  microphone and display capture are not requested in the control.
- **PASS:** the five are denied and logged and the three are allowed. **FAIL:** any of the eight has another outcome. A
  control that does not show `granted` makes the run INVALID.
- **FAIL means:** the security invariant "deny by default" cannot be enforced as designed. Not fatal for the runtime
  choice, but blocks the security spec until understood.

### H13. Trusted-input fullscreen and pointer lock

- **Tests:** injected input counts as a user gesture, so fullscreen and pointer lock can be tested automatically.
- **Runtime:** Electron 45.0.0.
- **Method:** a test page with a button; the runner clicks it with `webContents.sendInputEvent` (mouse down and up, key
  events); the handler calls `requestFullscreen()`, `requestPointerLock()` and `navigator.keyboard.lock()`. Control:
  the same calls from a script without a gesture must be rejected (otherwise the run is INVALID). One manual run with a
  real click is also recorded.
- **PASS:** all three succeed after injected input and are rejected without it. **FAIL:** injected input grants no
  gesture; the automated tests then become manual. A failure of the manual run too is a serious finding for the owner.

### H14. Quiescent export and restore

- **Tests:** progress can be exported while the game is closed and restored into a clean session with the same result.
- **Runtime:** Electron 45.0.0.
- **Method:** (1) in partition `persist:spike:src` open `progress-lab`, click `#play-step` 7 times, record
  `#progress-hash` as Hs, close the window. (2) Export: a hidden window on the same partition whose session serves an
  empty document at the game origin through `ses.protocol.handle`, so no game code runs; `executeJavaScriptInIsolatedWorld`
  reads localStorage and every IndexedDB database (name, version, key path, auto-increment, indexes, all records) with
  the real IndexedDB API and structured clone; the main process writes a throwaway snapshot file. (3) Restore: the same
  technique into a fresh partition `persist:spike:dst-<nonce>`. (4) Open `progress-lab` there and record `#progress-hash`
  as Hd. Negative control: flip one byte in a Uint8Array of the snapshot before restore; Hd must then differ.
- **Variants:** (a) plain, the service worker unregistered first; (b) the service worker still registered: the fixture
  server's request log shows no request for `game.js` or `sw.js` during the export window, the export window has no
  service-worker controller, and its document is our stub; (c) cross-site iframe: the top level is
  `http://localhost:<n>/iframe-host.html?src=http://127.0.0.1:<n>/`, the export and restore recreate the same top-level
  and iframe pair (the exporter runs in an isolated world of the stub iframe if Electron offers that for frames,
  otherwise in the stub's main world, which holds no game code); extra control: the restored game opened top-level at
  `127.0.0.1` is expected to show different data, documenting storage partitioning; (d) restore in place after
  `ses.clearStorageData` wipes the source partition.
- **Metric:** Hd equals Hs as strings, per variant.
- **PASS:** Hd equals Hs and the negative control differs, in a, b, c and d. **FAIL:** unequal, or the stub was
  bypassed. A negative control that does not differ makes the run INVALID (the hash is insensitive).
- **FAIL means:** (a) or (d): ADR-0005 needs another mechanism, for example CDP reads with a different write path;
  (b): the service worker must be neutralized before export or the stub moved outside its scope; (c): cross-site iframe
  games stay unsupported at first. Not fatal for the runtime, but decisive for ADR-0005 and for Tauri, which has no CDP.

### H15. Packaged app deep link

- **Tests:** a packaged, ad-hoc-signed arm64 app handles `wgspike://launch?id=x` and keeps a single instance.
- **Runtime:** Electron 45.0.0, packaged with electron-builder, scheme declared in `Info.plist`, signed with
  `codesign --sign -`.
- **Method:** run the app once so macOS registers the scheme. (1) App not running: `open 'wgspike://launch?id=x'`. (2) App
  running with a window: the same command, and a second launch of the executable with `--launch-game=x`. Log every
  `open-url` and `second-instance` event.
- **Metric:** number of main processes of the app (expected 1) and the received id.
- **PASS:** one main process and id `x` received in every case. **FAIL:** a second instance or a missing id.
- **FAIL means:** the shortcut and deep-link design (PRD AC-19) must change. Not fatal.

### H16. No leftover windows or processes

- **Tests:** closing a game leaves nothing behind.
- **Runtime:** Electron 45.0.0; the same method is applied to Tauri (H17) and Chrome `--app` (H20).
- **Method:** capture `ps -axo pid,ppid,command` for the app before launch, with a game window open, 5 s after closing
  the game window, and 5 s after quitting the app; also count `BrowserWindow.getAllWindows()` after an export (H14).
- **PASS:** 5 s after closing, no renderer process of that window remains and the window count is back to baseline; 5 s
  after quitting, no process whose path is inside the app bundle remains. **FAIL:** otherwise.
- **FAIL means:** PRD AC-13 cannot be met without extra cleanup code or a different runtime. Not fatal.

### H17. Tauri: per-webview isolation and persistence

- **Tests:** two Tauri webviews with distinct `data_store_identifier` values are isolated and persistent.
- **Runtime:** Tauri 2.12.x on macOS 27 (the feature needs macOS 14 or later). Timebox: about half a day.
- **Method:** a minimal app with two webviews (the `unstable` multi-webview feature) or two windows, each with its own
  `data_store_identifier`, both loading the H1 storage page from the spike server. Run the H1 procedure, the H2
  restart, and the H16 process check.
- **PASS and FAIL:** as H1, H2 and H16. If the timebox runs out, the result is N/A with the reason, not PASS.
- **FAIL means:** Tauri cannot give per-game sessions on macOS and is eliminated.

### H18. Tauri: probe results

- **Tests:** WebGPU, WebGL2, cross-origin isolation, frame time and start time inside a Tauri webview (WKWebView).
- **Runtime:** Tauri 2.12.x on macOS 27.
- **Method:** the probe page from the spike server runs the H3 procedure (also with COOP and COEP set through Tauri's
  security `headers` configuration for packaged assets), H5, H6, H7 and H8.
- **PASS and FAIL:** the same thresholds as for Electron in H3, H5, H6 and H7, so the decision rules can compare the two.
  A part Tauri cannot reach is N/A with the reason.

### H19. Chrome baseline

- **Tests:** reference values for H3, H5, H6 and H7 on the same machine and scene.
- **Runtime:** Chrome stable, driven by Playwright with `channel: 'chrome'`, headed, fresh `--user-data-dir`.
- **Method:** the H3 (`/coi/`), H5, H6 and H7 procedures with the same viewport size.
- **Metric and role:** the baseline is valid only if its H6 passes (otherwise INVALID, rerun). It has no PASS or FAIL of
  its own; it defines "Chrome has a WebGPU adapter" for H5 and the p95 reference for H7.

### H20. Chrome `--app` with a per-game profile

- **Tests:** feasibility of the fallback architecture: Chrome in app mode, one profile per game, controlled over CDP.
- **Runtime:** Chrome stable.
- **Method:** launch two instances with `--app=http://localhost:<n>/` and distinct `--user-data-dir` and
  `--remote-debugging-port` values. Check (1) isolation as in H1, (2) persistence after quit as in H2, (3) no tab strip
  or address bar (screenshot, manual), (4) CDP attach: `/json/version` answers, `DOMStorage` and `IndexedDB.requestData`
  reads work, (5) process cleanup as in H16, (6) the H7 frame-time method.
- **Metric and role:** one PASS or FAIL per check, no combined threshold. The result matters only under decision rules 3 and 4.

### H21. Public demos

- **Tests:** public WebGPU and WebGL demos behave the same in Electron and Chrome (reported, no threshold).
- **Runtime:** Electron 45.0.0 and Chrome.
- **Method:** three webgpu-samples pages and three three.js examples, fixed before the run and listed in the results;
  record load success, console error count and the H7 sampler for 20 s at the same viewport size.
- **Role:** a demo that fails in Electron but works in Chrome is a finding for the compatibility matrix. It triggers the
  decision rules only when it reproduces an H5, H6 or H7 failure.

## 4. Decision rules

1. **Electron fatal criteria:** H1 FAIL (partition leak); H2 FAIL (lost persistence); H3 FAIL on both 45 and 44.9.x
   (`crossOriginIsolated` false with correct headers); H5 FAIL (no WebGPU adapter where Chrome has one, also after
   `enable-unsafe-webgpu`); H7 FAIL (p95 worse than Chrome by more than 15%). A persistent H6 FAIL also counts as a GPU
   failure (Assumed interpretation). A CONDITIONAL H5 is not fatal.
2. **If Electron passes every fatal criterion:** ADR-0002 is accepted with Electron 45 (or 44.9.x if H3 forced it).
   A CONDITIONAL H5 counts as passing here, but its risk and the `enable-unsafe-webgpu` question are recorded in the ADR
   and the switch is not shipped without an ADR. H1, H2, H5, H6 and H7 are measured on 45.0.0 only (H3 and H4 also on
   44.9.x when retried), so before the ADR is accepted H1 to H7, including H4, are re-run on the exact version finally
   chosen. Findings from the non-fatal hypotheses become spec changes, not runtime changes.
3. **If Electron fails H1, H2 or H3:** Electron is not accepted. The candidates are then Tauri (rule 6) and Chrome
   `--app` (H20); the owner decides. Assumed
4. **If Electron's comparison against a valid Chrome baseline (H19) fails a GPU or performance criterion:** H5 (Chrome
   has an adapter and Electron has none, also after the switch), H6 (Chrome reports hardware and Electron persistently
   reports software) or H7 (p95 above Chrome times 1.15, after the noise rule is satisfied). Then reconsider the
   architecture around Chrome `--app` with CDP, using the H20 evidence. ADR-0002 is not accepted as is; the owner
   decides, because this changes the window, shortcut and packaging design.
5. **If there is no valid Chrome baseline for the criterion** (Chrome has no WebGPU adapter, or Chrome's own H6 reports
   software), it is a limit of the machine or the OS, not a runtime difference, and it is recorded without counting
   against Electron. If H7 is still INCONCLUSIVE after the 5-run rerun, there is no verdict: Electron cannot be accepted
   on H7 alone and the owner decides.
6. **Tauri wins only by passing a criterion that Electron fails**, and only if it also passes H17 and the H18 counterparts
   of the other fatal criteria. Equal results are not a reason to switch: the default stays Electron (Assumed: planned
   stack, one engine on every OS, a pinned version, CDP available).
7. **Never counted as PASS:** INVALID runs, INCONCLUSIVE results, N/A items and anything that was not run. Windows is
   covered only by non-GPU checks on a CI runner if they are run (H1, H2, H3, H10, H14), recorded as "Windows (CI
   runner, no GPU)" and never as game compatibility.

## 5. Not covered

- Windows and Linux GPUs, drivers and engines (no such machine); iOS and Android.
- Gamepad input: N/A, no hardware.
- Real Emscripten `syncfs` flush behavior and real Unity builds: `progress-lab` only imitates the IDBFS layout.
- OPFS extraction (H1 and H2 test only that OPFS persists per partition).
- Code signing and notarization beyond ad-hoc signing, and auto-update.
- Heavy real-world ports: none is available, and their completeness is unproven.

## 6. Amendments

None yet. Any change after the first run is added here with its date, the reason and the old and new text.
