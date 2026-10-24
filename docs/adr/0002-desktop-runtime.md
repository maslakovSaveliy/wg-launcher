# ADR-0002: Desktop runtime

**Status:** Accepted, by owner decision of 2026-10-25, under the Phase 1 H7 condition in "Decision".

**Date:** 2026-10-24

**Deciders:** owner (maslakovSaveliy); drafted by AI agent

Conventions: [ADR-0000](0000-template.md#conventions). `H<n>` is a hypothesis in
[HYPOTHESES.md](../../spikes/runtime-compat/HYPOTHESES.md), frozen before any run; results are in
[RESULTS.md](../../spikes/runtime-compat/RESULTS.md).

## Context

- The runtime must give every game an isolated, persistent session, cross-origin isolation, WebGPU and WebGL2 on the
  GPU, frame times close to Chrome, and a way to export and restore saves (ADR-0005). `Owner` (PRD; HYPOTHESES
  section 4)
- The decision follows the frozen decision rules of HYPOTHESES section 4, measured on one machine: MacBook Air M3,
  macOS 27.0.1, 60 Hz. Verified (2026-10-24, RESULTS.md "Run").

### Fatal criteria for Electron 45.0.0

| H | Criterion (fatal if it fails) | Result | Tag |
| --- | --- | --- | --- |
| H1 | No partition leak | PASS: 0 of 5 kinds leaked both ways, control 5 of 5 | Verified (2026-10-24, RESULTS.md H1) |
| H2 | Persistence across `app.quit()` | PASS: 5 kinds and 1 MiB values byte-equal | Verified (2026-10-24, RESULTS.md H2) |
| H3 | `crossOriginIsolated` with COOP and COEP | PASS on 45.0.0, so no 44.9.x retry | Verified (2026-10-24, RESULTS.md H3) |
| H5 | WebGPU adapter where Chrome has one | PASS: adapter, device and compute without a switch; 24 features, Chrome 23 | Verified (2026-10-24, RESULTS.md H5 and H19) |
| H6 | Hardware WebGL2 renderer | PASS: ANGLE Metal in Electron and in Chrome | Verified (2026-10-24, RESULTS.md H6 and H19) |
| H7 | p95 frame time at most Chrome's p95 x 1.15 | **Not measured**: Electron-only numbers exist, the calibrated Chrome runs do not; deferred to Phase 1 | Verified (2026-10-24, RESULTS.md summary, H7 "pending"); the deferral is `Owner` (2026-10-25) |

H4 (injected headers) also passed; it is not fatal. Verified (2026-10-24, RESULTS.md H4). By the frozen rules this ADR
could be accepted only once every fatal criterion passed (rule 2), and a criterion that was not run never counts as PASS
(rule 7). Verified (2026-10-24, HYPOTHESES.md section 4)

## Decision

- **Electron 45.0.0** (Chromium 156.0.8078.48, Node 24.22.0) is the runtime: the exact version every spike result was
  measured on. Verified (2026-10-24, RESULTS.md "Run") for the version. Fallback line 44.9.x (44.9.3 published
  2026-10-21) only for a 45-specific blocker. Verified (2026-10-24,
  [runtime-and-storage.md](../research/runtime-and-storage.md) section 2.1) for the release.
- **Owner override.** The owner deferred the hands-off timing runs (H7, H8, H9 and the demo frame samples) to Phase 1,
  to be measured on the real launcher against Chrome, and chose to proceed with Electron now. This overrides waiting for
  H7 under rules 2 and 7: H7 has not passed, it is a condition of this acceptance. `Owner` (2026-10-25)
- **Condition: Phase 1 MUST re-run H7** on the launcher with the frozen method (Chrome calibrated to an uncapped p50 of
  60 to 120% of the vsync interval at a fixed load, hardware WebGL2 in both, window visible and focused, three
  alternating runs per runtime at 1280 x 720). `Owner` for the re-run; the outcomes follow HYPOTHESES sections 2 and 4:
  - **PASS:** median Electron p95 at most median Chrome p95 x 1.15. Measured against the installed Chrome 155 it is
    labeled "version mismatch, re-check when Chrome 156 is installed".
  - **FAIL,** only after the noise rule is satisfied (Chrome's p95 spread below 15% in 3 runs, or in the 5-run rerun of
    both runtimes that a larger spread triggers): Electron p95 above Chrome p95 x 1.15. A persistent Electron-side
    INVALID while Chrome's runs are valid also counts as FAIL (HYPOTHESES section 2).
  - **No verdict, the owner decides (rule 5):** spread still 15% or more after 5 runs (INCONCLUSIVE), calibration
    impossible (N/A), or a persistent Chrome-side INVALID (no valid baseline). Never counted as PASS.
  - **A FAIL reopens this ADR and ADR-0005.** Rule 4 then points to Chrome `--app` with CDP (H20 evidence). Tauri stays
    N/A (H17 and H18 were not run), so rule 6 cannot select it unless they are run first.
- **Upgrade policy:** stay on a supported major and move before it leaves support; re-run H1 to H7 (with H4) on every
  major upgrade, and on the exact version Phase 1 ships if it is not 45.0.0 (rule 2). Electron supports the latest 3
  majors, ships one every 8 weeks, and 45 is supported until 2027-04-27 (tentative). Verified (2026-10-24,
  runtime-and-storage.md section 2.1); the policy is `Assumed`.
- PRD OQ-7 does not arise on this machine: H5 passed without `enable-unsafe-webgpu`, and the switch is not shipped (the
  OQ-7 default). `Assumed`

## Options considered

### Option A: Electron 45 (fallback 44.9.x)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: one pinned Chromium on every OS, CDP and isolated worlds available (H14 used both). Verified (2026-10-24, RESULTS.md H14) |
| Cost and size | Ships its own Chromium; app size not measured. Unverified |
| Compatibility | H1 to H6 PASS on macOS arm64, H7 deferred to Phase 1; builds only for x64 and arm64. Verified (2026-10-24, RESULTS.md; runtime-and-storage.md section 2.2) |
| Security | Sandbox, context isolation, permission handlers and fuses; Electron grants every permission unless denied, so handlers are mandatory. Verified (2026-10-24, runtime-and-storage.md sections 2.3 and 2.4) |
| Team familiarity | TypeScript and Node; the spike app exists. Verified (2026-10-24, `spikes/runtime-compat/electron/`) |
| Reversibility | Medium: main-process code is Electron-specific; the snapshot format is engine-independent ([snapshot-format.md](../specs/snapshot-format.md) section 1). Assumed |
| Pros | Measured evidence on the target engine; the save mechanism of ADR-0005 works on it. Verified (2026-10-24, RESULTS.md H14) |
| Cons | A major every 8 weeks means a recurring upgrade and re-measurement task. Assumed |

### Option B: Tauri 2 (system WebViews)

| Dimension | Assessment |
| --- | --- |
| Complexity | High: a different engine per OS (WebView2, WKWebView, WebKitGTK), versions follow the OS. Verified (2026-10-24, runtime-and-storage.md section 3) |
| Cost and size | Smaller app without a bundled engine. Assumed (not measured) |
| Compatibility | Per-webview data stores (`data_store_identifier`) need macOS 14 or iOS 17 and are unsupported on Windows, Linux and Android. Verified (2026-10-24, runtime-and-storage.md section 3). Not built: H17 and H18 are N/A, owner-approved, because Tauri can only win by passing a criterion Electron fails. Verified (2026-10-24, RESULTS.md H17) |
| Security | Engine updates come from the OS; we could not pin the engine. Assumed |
| Team familiarity, reversibility | Needs Rust for the shell; medium. Assumed |
| Pros | Safari 27.0.1, used as a WebKit proxy, showed WebGPU and cross-origin isolation on this Mac. Verified (2026-10-24, RESULTS.md "Safari as a WebKit proxy"); that WKWebView behaves alike is Assumed |
| Cons | WKWebView has no CDP, so ADR-0005's mechanism is unavailable. Assumed (runtime-and-storage.md section 3) |

### Options C and D: Tauri 3 with CEF, or an own Rust shell around CEF

| Dimension | Assessment |
| --- | --- |
| Complexity | Tauri 3 with CEF is alpha only (`tauri-v3.0.0-alpha.5`, `tauri-runtime-cef-v3.0.0-alpha.6`, 2026-10-14) with open Linux keyboard, focus and WebGPU-fallback bugs. Verified (2026-10-24, runtime-and-storage.md section 3). An own shell means owning the browser shell, its Chromium updates and the build and signing matrix. Assumed (not researched) |
| Cost, compatibility, security | Bundles Chromium like Electron; nothing measured, unknown without a spike. Unverified |
| Familiarity, reversibility, pros and cons | Low, low; would pin Chromium, but is not usable now (alpha) or costs far beyond the MVP (own shell). Assumed |

### Option E: system Chrome `--app` with CDP (fallback architecture)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: one `--user-data-dir` per game, control over CDP. Verified (2026-10-24, RESULTS.md H20) |
| Cost and size | No bundled engine, but depends on the user's installed Chrome version and policies. Assumed |
| Compatibility | Isolation and persistence PASS in 5 of 5 runs, no tab strip or address bar, CDP reads work; Chrome 155 here. Verified (2026-10-24, RESULTS.md H20) |
| Security | A DevTools port reachable by local processes. Assumed |
| Team familiarity, reversibility | Spike code exists (Verified (2026-10-24, `spikes/runtime-compat/groups/app.mjs`)); high. Assumed |
| Pros | Real Chrome engine; renderer exited 3.1 to 5.9 s after close (Electron 27.8 s, H16). Verified (2026-10-24, RESULTS.md H16 and H20); *correction (2026-10-25):* the first draft said 2.8 to 5.2 s, the range of an earlier set of runs that was not kept; the committed runs give 3.1 to 5.9 s |
| Cons | Chrome keeps running after its last window; CDP IndexedDB cannot write, so restore was not tested in this mode. Verified (2026-10-24, RESULTS.md H20) |

## Trade-off analysis

Electron is the only option with a pinned engine, CDP and a measured save mechanism, and it passed every fatal criterion
measured so far. Tauri cannot pin the engine, lacks per-game data stores outside Apple platforms and lacks CDP; equal
results would not justify a switch (decision rule 6). Chrome `--app` stays the documented fallback if the Phase 1 H7
fails. Assumed

## Consequences

- **Easier:** one engine and one compatibility record per OS; the ADR-0005 mechanism. Assumed. Playwright drives the
  app end to end. Verified (2026-10-24, RESULTS.md H11)
- **Harder:** a recurring upgrade task; no iOS reuse. Assumed
- **Version mismatch:** installed Chrome is 155.0.8059.85, Electron's Chromium 156.0.8078.48, so every Chrome comparison
  carries the label "version mismatch" (HYPOTHESES section 2). `texture-compression-unaligned` is in Electron only;
  cause not investigated. Verified (2026-10-24, RESULTS.md H19)
- **Platforms:** macOS arm64 is the only tested platform (one machine). Windows: CI runs install and unit tests on
  `windows-latest`; the fixture e2e runs on Ubuntu and macOS only and no Windows spike job ran. Linux: not tested.
  Verified (2026-10-25, [ci.yml](../../.github/workflows/ci.yml), RESULTS.md "Windows CI job"). iOS needs a separate
  WebKit client: App Store guideline 2.5.6 requires WebKit (Verified (2026-10-24, runtime-and-storage.md section 4)),
  the separate client is Assumed. Android's WebView is Chromium-based but untested. Assumed

### Findings that bind Phase 1

| H | Result | Phase 1 response | Tag |
| --- | --- | --- | --- |
| H16 | FAIL: a closed window's renderer lived 27.8 s, until its service worker stopped | Close procedure, [architecture.md](../specs/architecture.md) section 4 | Verified (2026-10-24, RESULTS.md H16) |
| H12 | Environment-dependent: the microphone request stalled before the handler while macOS access was undecided | Media denied in both handlers, packaged test, [security.md](../specs/security.md) section 5 | Verified (2026-10-24, RESULTS.md H12) |
| H13 | INVALID: `navigator.keyboard.lock()` needs no gesture; pointer lock fails right after fullscreen | Test design, architecture.md section 9 | Verified (2026-10-24, RESULTS.md H13) |
| H11 | Playwright's Electron loader turns storage partitioning off | Switch re-appended at start-up, architecture.md section 5 | Verified (2026-10-24, RESULTS.md H11) |
| H2b | SIGKILL 5 s after the writes lost the persistent cookie; localStorage, IndexedDB, Cache Storage and OPFS survived | None for saves; cookies are not snapshot data | Verified (2026-10-24, RESULTS.md H2b) |
| H9, H8 | H9 INVALID (machine in use), so no memory number; H8 medians cold 362 ms, warm 369 ms on this machine only | No memory or speed claim (AC-22) | Verified (2026-10-24, RESULTS.md H8 and H9) |

### Revisit triggers

- The Phase 1 H7 fails or gives no verdict; an H7 PASS against Chrome 155 fails its re-check against Chrome 156; a fatal
  criterion fails on a later Electron version; a game class needs something only another engine offers; a mobile client
  is started. Assumed

## Evidence

- [HYPOTHESES.md](../../spikes/runtime-compat/HYPOTHESES.md) sections 2 and 4;
  [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) (aggregate `electron-45.0.0-20261024T151511.707Z.json`, Chrome
  baseline `chrome-155.0.8059.85-20261024T171517.695Z.json`, the H20 aggregates); [matrix.md](../compat/matrix.md);
  [runtime-and-storage.md](../research/runtime-and-storage.md) sections 2 to 4 and 8.

## Facts versus assumptions

- **Facts** (tagged where they appear above): the results table above, H20, the Safari proxy run, the platform and CI
  coverage. One machine; nothing is extrapolated. H7 is unmeasured; the acceptance rests on the owner's decision.
- **Assumptions** (Assumed): Electron will pass H7 on the launcher; WKWebView has no CDP; Tauri would behave like
  Safari; the upgrade policy is affordable; Chrome `--app` is a workable fallback beyond the checks H20 ran.

## Action items

- [ ] Phase 1: re-run H7 on the launcher against Chrome under the condition above, with H8, H9 and the demo frame
  samples; record the runs in `docs/compat/` and the outcome here (agent).
- [ ] When Chrome 156 is installed on the measuring machine, re-check H7 and drop the "version mismatch" label (agent).
- [ ] If Phase 1 ships an Electron version other than 45.0.0, re-run H1 to H7 with H4 on it first (agent).
