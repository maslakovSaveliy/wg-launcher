# MEMORY.md

Shared memory for all agents and contributors. Append dated entries; fix or remove stale ones (see `AGENTS.md`).
Tags: `[V]` Verified (date, source), `[A]` Assumed (reasoned, not checked), `[U]` Unverified (reported, not checked).
All entries below are dated 2026-10-24 unless they say otherwise.

## Decisions

- 2026-10-24 Phase 0 plan: [docs/plans/2026-10-24-phase-0-foundation.md](docs/plans/2026-10-24-phase-0-foundation.md).
  Decisions are recorded as ADRs in [docs/adr/](docs/adr/) (index: [docs/README.md](docs/README.md)):
  ADR-0001 own small client, not a fork (Accepted); ADR-0002 desktop runtime, Electron 45.0.0 (Accepted by the owner on
  2026-10-25 under the Phase 1 H7 condition below); ADR-0003 native languages, Rust deferred and Go not adopted
  (Accepted); ADR-0004 toolchain and repository layout (Accepted; its Electron-specific rows are reopened with ADR-0002);
  ADR-0005 save transfer mechanism, the quiescent window (Accepted with ADR-0002, same condition); ADR-0006 licensing
  model (Accepted; awaits a lawyer's review).
- Phase 0 produces specs, docs, rules and tooling only. No launcher client code until Phase 1, which gets its own plan.
- Own small Electron client, not a fork of itch, Flashpoint, Pixens or web-runner. Their code is not reused (patterns
  only). The runtime is Electron 45.0.0 (ADR-0002); the compatibility spike supplied the evidence, on one machine
  (macOS arm64).
- 2026-10-25 Owner: ADR-0002 (Electron) and ADR-0005 (save transfer) are Accepted on one condition: Phase 1 re-runs
  H7 (p95 frame time at most Chrome's p95 x 1.15) on the launcher, with the frozen method, because the hands-off timing
  runs (H7, the Chrome side of H8, the H9 rerun, H20-6 and the demo frame samples) were deferred out of Phase 0. A
  Phase 1 H7 FAIL reopens both ADRs ([A] the fallback, Chrome `--app` with CDP, has no preload, `ses.protocol.handle` or
  `webContents.debugger`, so ADR-0005's mechanism would not carry over). Source: ADR-0002 "Decision", ADR-0005 "Status".
- 2026-10-25 Owner: the Tauri build was dropped (hypotheses H17 and H18 are N/A) and Safari is used only as a labeled
  WebKit proxy; Phase 1 is code and tests only (no spikes, one review per task); exports without a confirmed in-game
  flush are allowed and labeled "flush unconfirmed" (ADR-0005 decision 7). The owner keeps their own git identity in
  commits.
- 2026-10-25 Owner: CLA counterparty is Savelii Maslakov as an individual (passport spelling), governing law is the
  Russian Federation; both are now written into `CLA.md`. The CLA stays inactive, and no outside contribution is
  accepted, until a lawyer has reviewed it and the CLA Assistant app is set up.
- 2026-10-25 Decided in the specs (Assumed; the owner can override): the snapshot record encoding is deterministic CBOR
  (snapshot-format.md section 6.1); packaging is electron-builder (ADR-0004, option P1); PRD OQ-2 (removing a game keeps
  its data as orphaned until deleted) and OQ-3 (plain `http://localhost` and `http://127.0.0.1` only in development and
  test builds) are decided as proposed (architecture.md section 12).
- 2026-10-25 `spikes/runtime-compat/` stays where it is, labeled THROWAWAY: the ADRs and specs link to its results, and
  Phase 1's H7 re-run uses its method. It is deleted or archived only after the Phase 1 H7 outcome is recorded.
  Routine decision, Assumed.
- Rust is deferred to the local-packages stage. The MVP snapshot codec is TypeScript; a language-neutral spec with
  golden vectors lets a later Rust version pass the same vectors. Go is not adopted in the MVP.
- English everywhere in the repo. Codename `wg-launcher`, deep-link scheme `wglauncher`; display name is open.
- License model: `AGPL-3.0-or-later` by default, commercial use by separate agreement, CLA for outside contributors,
  future paid features only in one named source-available directory (none exists), trademark policy, core features
  always free. See `LICENSING.md`. Not legal advice; a lawyer should review before outside contributions.
- Dependency policy: shipped dependencies permissive only; see `AGENTS.md`.
- Package manager pinned to `pnpm@12.15.0` (`packageManager` field). Why: in the repo `pnpm -v` switches to 12.15.0 by
  itself, `pnpm install` and `pnpm install --frozen-lockfile` succeed, and the default `minimumReleaseAge` does not
  block Electron 45.0.0. Fallback if it misbehaves later: `pnpm@11.7.0`. [V, 2026-10-24, run locally]
- Quality toolchain (Task 2): Biome for JS, TS, JSON and CSS only; markdownlint-cli2 for Markdown with no line-length
  rule; secretlint on staged files; commitlint with Conventional Commits plus `spike`; lefthook hooks (pre-commit,
  commit-msg, pre-push = typecheck + unit tests); `pnpm test` is Vitest only, and the Playwright suite will be a
  separate `test:e2e` script added with the test game. License gate: production dependencies strict against the
  AGENTS.md allowlist (SPDX `OR`/`AND` understood), dev-only dependencies warn.
- Execution style: subagent-driven development; test-first where code exists.
- 2026-10-25 Phase 0 close-out (Task 9): `README.md`, `CONTRIBUTING.md` and the docs index `docs/README.md` exist, and
  the branch `phase-0-foundation` waits for the owner's review before any merge to `main`.
- Controlled test game (Task 4): `fixtures/test-games/progress-lab`, a pnpm workspace package
  (`@wg-launcher/fixture-progress-lab`, private) with its own Playwright suite. The interface the spike depends on
  (server, element ids, `?ephemeral=1`, `/coi/`, `iframe-host.html`, `sw.js`, storage shapes, hash) is in its
  `README.md`. All timestamps and binary values are synthetic and deterministic, so the hash depends only on the number
  of steps. `pnpm test:e2e` is separate from `pnpm test` and `pnpm check`; CI runs it on Ubuntu and macOS in bundled
  Chromium only, the `chrome` project is local only. The server logs each request to stdout because hypothesis H14
  (variant b) reads a request log.
- Spike hypotheses are frozen: `spikes/runtime-compat/HYPOTHESES.md` (H1 to H21, thresholds, decision rules) was written
  on 2026-10-24 before any spike ran. After the first run it changes only through its dated "Amendments" section.
  Electron is fatal on H1, H2, H3 (both 45 and 44.9.x), H5 (no adapter even with the switch), a persistent H6 failure
  (software renderer) and H7 (p95 > Chrome x 1.15); Tauri must beat a criterion Electron fails; Electron failing a GPU
  or performance comparison against a valid Chrome baseline means reconsidering Chrome `--app` + CDP. H1 to H6 were
  measured on Electron 45.0.0; H7 was not, and ADR-0002 was accepted on 2026-10-25 with H7 as a Phase 1 condition (see
  above).
- PRD (`docs/product/prd.md`) marks each requirement `Owner`, `Concept` or `Assumed`; acceptance criteria AC-1 to AC-25
  each name a test type.
- Public GitHub repo: <https://github.com/maslakovSaveliy/wg-launcher>. Work happens on branches; merge to `main` only
  on the owner's approval.

## Verified facts

### Open-source bases (checked via `gh api`)

- [V] itchio/itch: MIT, f5a18100 (2026-10-08), very active, Electron ^44.5.1. Per-game session
  `persist:gamesession_${game.id}`, custom `itch-cave://` protocol, but `sandbox:false` and `webSecurity:false`; needs
  butler (Go, MIT) and the itch.io API. <https://github.com/itchio/itch>
- [V] FlashpointProject/launcher: MIT own code plus bundled third-party (7zip under LGPL), e5f45fc1 (2026-09-28),
  Electron 19.1.9, no per-game partitions. <https://github.com/FlashpointProject/launcher>
- [V] arhitekt86/pixens-launcher: MIT, 8a52abbb (2026-05-21), 2 commits total, Electron ^33, one shared session,
  hard-wired to pixens.io and Supabase. <https://github.com/arhitekt86/pixens-launcher>
- [V] lutris/web-runner: GPL-3.0 (copy no code), 15bb58c2 (2026-02-24), nearly dormant, Electron 4.2.12.
  <https://github.com/lutris/web-runner>
- [V] Ferdium (Apache-2.0, Electron 44.2) uses `persist:service-${id}` per service: the closest pattern to per-card
  sessions. <https://github.com/ferdium/ferdium-app>
- [U] None of these has save backup/export/import (inferred from GitHub code search for "backup").
- [A] Verdict: none is worth forking; reuse ideas only.

### Electron

- [V] Electron 45.0.0 is npm latest, published 2026-10-21 (Chromium 156.0.8078.48, Node 24.22.0, V8 15.6).
  46.0.0-alpha.1 on 2026-10-23, stable planned 2027-01-05. <https://releases.electronjs.org/release/v45.0.0>,
  <https://releases.electronjs.org/schedule>
- [V] Support covers the latest 3 stable majors (now 45, 44, 43); 42 reached end of life on 2026-10-20; 45 is
  tentatively supported until 2027-04-27. <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>
- [V] Electron 45 changes that matter: display/window/tab capture permission requests arrive as `display-capture`;
  sandboxed preloads lost `Buffer`, `events`, `timers`, `url`; 32-bit builds are gone (x64 and arm64 only).
- [V] `session.fromPartition('persist:x')` is persistent; without the prefix it is in-memory. `ses.clearStorageData` and
  `ses.clearData` can target origins and storage kinds. <https://www.electronjs.org/docs/latest/api/session>
- [V] `setPermissionRequestHandler` also covers pointerLock, fullscreen, keyboardLock and display-capture;
  `setPermissionCheckHandler` and `setDevicePermissionHandler` exist.
- [V] BrowserView is deprecated since Electron 29; use WebContentsView.
- [V] `protocol.handle` replaced the old register/intercept APIs in 25.0.0 and is per session;
  `registerSchemesAsPrivileged` must run before `ready`, once. <https://www.electronjs.org/docs/latest/api/protocol>
- [V] macOS `setAsDefaultProtocolClient` works only for schemes declared in Info.plist at build time;
  `requestSingleInstanceLock(additionalData)` plus `second-instance` exist; register `open-url` before `ready`.
  <https://www.electronjs.org/docs/latest/api/app>
- [V] `utilityProcess.fork` exists (after ready), with message ports. `webContents.debugger` and
  `executeJavaScriptInIsolatedWorld` are documented.
- [V] Fuses (@electron/fuses 2.1.3): turn off runAsNode, nodeOptions, nodeCliInspect, grantFileProtocolExtraPrivileges;
  turn on cookieEncryption, embeddedAsarIntegrityValidation (macOS, Windows), onlyLoadAppFromAsar.
  <https://www.electronjs.org/docs/latest/tutorial/fuses>
- [V] Security checklist: contextIsolation default since 12, sandbox default since 20; no Node for remote content; keep
  webSecurity; deny new windows via `setWindowOpenHandler`; never pass untrusted URLs to `shell.openExternal`; validate
  IPC senders. <https://www.electronjs.org/docs/latest/tutorial/security>
- [V] Packaging: Electron Forge 8.0.1, electron-builder 26.18.0, electron-vite 6.0.0 (peer vite 6, 7 or 8).
  <https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging>
- [V] Playwright's Electron support is experimental. <https://playwright.dev/docs/api/class-electron>
- [U] WebGPU is on by default in Electron: no Electron doc says so (Chromium ships it on Windows x64 and macOS since
  113).
- [V] Known issues: Electron 41 on macOS broke COOP/COEP cross-origin isolation (#50242), fix merged in PR #50789 on
  2026-04-30; [U] which versions got the backport. Pointer lock on Wayland #49754 fixed 2026-02. Gamepad with Steam
  Input #45989 closed. <https://github.com/electron/electron/issues>

### Tauri

- [V] Tauri 2 stable 2.12.5 (crates.io, 2026-10-21). <https://v2.tauri.app/blog/>
- [V] It uses system webviews: WebView2 (Windows), WKWebView (macOS, iOS), WebKitGTK (Linux), system WebView (Android).
  <https://v2.tauri.app/reference/webview-versions/>
- [V] Per-webview data: `data_directory` is unsupported on WKWebView; `data_store_identifier` needs macOS 14 or iOS 17
  and is unsupported on Windows, Linux and Android.
  <https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html>
- [V] Several webviews per window need the `unstable` feature (desktop only).
- [V] WebGPU in WKWebView works on macOS and iOS 26+ per a maintainer (2025-11-24).
  <https://github.com/tauri-apps/tauri/issues/6381>
- [V] Tauri 3 with a CEF runtime is alpha only (tauri-v3.0.0-alpha.5, 2026-10-14), with open Linux keyboard and WebGPU
  issues. Not a candidate. <https://github.com/tauri-apps/tauri/releases>
- [U] WebGPU in WebKitGTK; COOP/COEP behavior of custom protocols on every OS.

### iOS and Android

- [V] App Store guideline 2.5.6: apps that browse the web must use WebKit; alternative engines only under an entitlement
  available in the EU and Japan. Guideline 4.7 allows HTML5 mini games under conditions.
  <https://developer.apple.com/app-store/review/guidelines/>
- [A] Desktop Chromium code cannot reach iOS; an iOS client would use WKWebView and behave differently. Android
  WebView is Chromium-based.

### Save extraction

- [V] The CDP IndexedDB domain (experimental) can read and delete but has no put/add: it cannot restore data.
  <https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/IndexedDB.pdl>
- [V] CDP DOMStorage can get/set/remove/clear localStorage items as strings; the CDP Storage domain can return the
  storage key and clear data per origin or storage key. (Same repository, `DOMStorage.pdl`, `Storage.pdl`.)
- [V] `webFrame.executeJavaScriptInIsolatedWorld(worldId, scripts)`: world 0 is the page, 999 is Electron's context
  isolation world; if the script throws, the promise resolves with `undefined`.
  <https://www.electronjs.org/docs/latest/api/web-frame>
- [V] Storage calls from an isolated world hit the host page's data, so an isolated-world exporter can use the real
  IndexedDB API with full structured clone.
  <https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies>
- [V] Emscripten IDBFS: object store `FILE_DATA`, DB version 21, key is the absolute path, value
  `{timestamp: Date, mode, contents: Uint8Array}` (or `link`); the in-memory FS is the truth while running,
  `syncfs(false)` writes it back.
  <https://raw.githubusercontent.com/emscripten-core/emscripten/main/src/lib/libidbfs.js>
- [V] Unity WebGL stores PlayerPrefs (up to 1 MB) in IndexedDB.
  <https://docs.unity3d.com/ScriptReference/PlayerPrefs.html>
  [U] Its path contains the build hash and changes per build (community report).
- [V] Since Chrome 115 third-party iframe storage is keyed by the iframe origin plus the top-level site, so a snapshot
  must record the full storage key. <https://developer.chrome.com/docs/privacy-sandbox/storage-partitioning>
- [U] OPFS has no CDP domain; reading it needs an in-page script.
- [V] dexie-export-import 4.4.2 (Apache-2.0) handles Date, ArrayBuffer, Blob via typeson; indexeddb-export-import 2.2.0
  (MIT) is JSON-only and unsuitable.
- [V] Node 24.13 on the dev machine has `zlib.zstdCompressSync`; Electron 45 ships Node 24.22.

### Test games (licenses via `gh api`)

- [V] 2048 (MIT, localStorage), A Dark Room (MPL-2.0, localStorage with built-in export), OpenTTD web (GPL-2.0, IDBFS:
  external test URL only, never vendored), three.js (MIT), Babylon.js (Apache-2.0), webgpu-samples (BSD-3-Clause) for
  GPU checks.
- [U] doom-wasm has no IDBFS save; Sandspiel uses only localStorage; OpenTTD likely needs extra graphics assets.

### Tooling versions (npm and cargo, 2026-10-24)

- [V] electron 45.0.0, electron-vite 6.0.0, vite 8.3.5, react 19.3.1, typescript 7.0.2 (latest; 6.0.3 is the last 6.x),
  @biomejs/biome 2.6.2, vitest 5.0.5, @playwright/test 1.64.1, zod 4.6.7, lefthook 2.2.2, @commitlint/cli 21.2.4,
  secretlint 13.0.7, markdownlint-cli2 0.24.0, @types/node 24.19.2 (24.x line), pnpm 12.15.0 (latest). All installed
  at exactly these versions in Task 2.
- [V] Biome 2.6.2 also formats Markdown and YAML by default: `biome check .` rewrote the tables in `AGENTS.md`, and
  its config schema has `markdown`, `yaml`, `html` and `graphql` sections (checked 2026-10-24 by running it). An earlier
  note that Biome has no Markdown support was wrong. `biome.json` therefore whitelists JS, TS, JSON and CSS file
  extensions in `files.includes`, and markdownlint-cli2 owns Markdown.
- [V] `node:sqlite` is release candidate since Node 25.7 and needs no flag since 22.13. [U] Its stability label in
  Node 24.22. <https://nodejs.org/api/sqlite.html>
- [V] `pnpm licenses list --json` (pnpm 12.15.0) prints `{"<license string>": [{name, versions[], paths[], license,
  author, homepage, description}]}`; `--prod` and `--dev` select the scope. License strings can be SPDX expressions
  such as `(MIT OR CC0-1.0)` or `MIT OR Apache-2.0`. `paths` are absolute machine paths: never print them. Without
  `--recursive` it reports only the root importer: in a scratch workspace the root gave `{}` while `--recursive` listed
  the member's dependencies. `scripts/check-licenses.mjs` therefore passes `--recursive`. [U] What pnpm prints for a
  package with no license field (the script treats missing, empty and `Unknown` alike). (2026-10-24, run locally)
- [V] TypeScript 7.0.2 works with the whole toolchain, so there is no fallback to 6.0.3: `tsc -b` type-checks `.ts` and
  checked `.mjs` (`allowJs`, `checkJs`) with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `verbatimModuleSyntax` on, and fails on a deliberate type error; vitest 5.0.5, Biome 2.6.2, commitlint 21.2.4
  (`.mjs` config), secretlint 13.0.7 and markdownlint-cli2 0.24.0 run on Node 24.13. TS 7 ships as a native binary (an
  optional `@typescript/typescript-<platform>` package). (2026-10-24, run locally)

### Test fixture (progress-lab, 2026-10-24, run locally)

- [V] Playwright 1.64.1 launches Chromium with `ThirdPartyStoragePartitioning` in `--disable-features`
  (`chromiumSwitches`, linked to playwright issue 32230; the Electron loader lists it too), so a cross-site iframe
  shares storage with the top-level page. Bundled Chromium 156.0.8078.4 and installed Chrome 155.0.8059.85, both
  driven by Playwright, showed exactly that: the iframe on `127.0.0.1` inside a `localhost` page saw the top-level
  progress. Adding `--enable-features=ThirdPartyStoragePartitioning` changed nothing (disable wins); a later
  `--disable-features=Translate` argument replaces Playwright's list (last switch wins) and partitions storage in both
  browsers. [V] `_electron.launch` has the same effect in Electron 45 (cross-site iframe storage shared); a normal
  launch partitions. Re-appending `disable-features` without that entry in the app's main process restores
  partitioning under Playwright (Task 5 spike, `spikes/runtime-compat/RESULTS.md` H11).
- [V] `localhost` and `127.0.0.1` count as different sites for storage partitioning in Chromium 156 and Chrome 155.
- [V] IndexedDB `clear()` on an `autoIncrement` store does not reset its key generator (keys 1, 2, clear, next add is 3 in
  Chromium 156); deleting the database does. A snapshot format has to say how it handles the generator.
- [V] The 14 fixture tests pass three times in a row in both Playwright projects (84 runs): bundled Chromium 156.0.8078.4
  and the installed Google Chrome 155.0.8059.85 (`channel: "chrome"`).

### Runtime spike, Electron 45 (Task 5; run locally, `spikes/runtime-compat/RESULTS.md`)

- [V] Dev machine is a MacBook Air M3 (`Mac15,12`, fanless), built-in display 60 Hz.
- [V] Electron 45.0.0 here: partitions isolated and persistent across `app.quit()` (H1, H2); `crossOriginIsolated`
  with server or `onHeadersReceived` headers (H3, H4); WebGPU adapter, device and compute without switches (H5); WebGL2
  on ANGLE Metal (H6); `node:sqlite` (SQLite 3.53.4) and zstd in main and `utilityProcess` with no warning (H10);
  Playwright `_electron.launch` (H11); quiescent export and restore of progress-lab in four variants (H14); packaged
  ad-hoc-signed deep link with one instance (H15). H7 is deferred to Phase 1 (owner decision 2026-10-25).
- [V] H12 is environment-dependent. Full run: microphone `getUserMedia` stalled 8 s and never reached
  `setPermissionRequestHandler` (FAIL). Rerun after the owner allowed the macOS microphone prompt
  (`getMediaAccessStatus` `granted`): it reached the handler and was denied (PASS). [A] Cause: Chromium touches the
  audio device, and so macOS TCC, before asking the embedder; the TCC log does not prove it. [V] TCC names the app that
  launched the runner (`com.anthropic.claude-code`) as responsible for the dev Electron process.
- [V] H13 INVALID: `navigator.keyboard.lock()` resolves without a gesture; injected mouse and key input grant gestures;
  `requestPointerLock()` right after `requestFullscreen()` in one handler fails ("A user gesture is required") but works
  alone or first. [A] Cause: `requestFullscreen()` consumes the transient activation.
- [V] H16 FAIL: a closed game window's renderer was still alive 5 s after the close and exited 27.8 s after it, at the
  moment the session reported no running service worker; 5 s after the app quit no process of the bundle remained
  (RESULTS.md H16). [A] Cause: the game's service worker keeps that renderer alive until it stops; the coincidence in
  time does not prove it. H9 is INVALID in all three attempts (the window was hidden and unfocused because the machine
  was in use); its rerun is deferred to Phase 1.
- [V] After SIGKILL 5 s after writes, a persistent cookie was lost; localStorage, IndexedDB, Cache Storage and OPFS kept.
- [V] Quiescent export: `ses.protocol.handle("http")` stub at the game origin plus CDP `Network.setBypassServiceWorker`
  keeps a registered service worker out of a top-level stub navigation; without the bypass the worker controls the
  stub (control run). In the cross-site iframe variant the partitioned worker was registered yet the iframe stub had no
  controller and no worker start; [A] that the page-level bypass covers subframes (no no-bypass iframe control was run).
  The fixture request log cannot tell bypass from no bypass (0 requests both ways); the CDP canary can.
- [V] Electron's `WebFrameMain` has no isolated-world execution; for a subframe use a preload
  (`nodeIntegrationInSubFrames`) calling `webFrame.executeJavaScriptInIsolatedWorld`.
- [V] Restoring `autoIncrement` records with explicit keys 1 to 7 advances the key generator: the next `add` gets 8.
- [V] Partitioned iframe storage key `http://127.0.0.1:4417/^0http://localhost`; `ses.clearStorageData({origin})` does
  not clear it, CDP `Storage.clearDataForStorageKey` does; `ses.clearStorageData()` without options clears everything.

### Runtime spike, Chrome, Safari proxy, demos (Task 6, non-timing part; run locally 2026-10-24, `spikes/runtime-compat/RESULTS.md`)

- Owner decision (2026-10-25): the hands-off timing runs (H7 frame time against Chrome, the Chrome side of H8, the H9 rerun,
  H20-6, the demo frame samples) are deferred to Phase 1 and will be measured on the real launcher against Chrome. They are
  "deferred", not N/A or INVALID; the Electron numbers from Task 5 stay as reported. `run-timing.mjs` was wiring-checked only
  and never run for a result.
- Tauri was not built (owner-approved scope change): decision-irrelevant because Tauri can only win by passing a criterion
  Electron fails and cannot replace H7. [A] WKWebView has no CDP, so ADR-0005's save transfer would not work there
  (reasoning in `docs/research/runtime-and-storage.md` section 3; not tested, section 9). H17 and H18 are N/A. A Windows
  CI job was not added: the runner's process accounting is macOS-only and [V, 2026-10-25, GitHub Actions events reference] a
  `workflow_dispatch` file must be on the default branch to run, and merging to `main` was out of scope.
- [V] Installed Chrome is 155.0.8059.85, Electron 45's Chromium is 156.0.8078.48 (version mismatch, Chrome not updated);
  Playwright's bundled Chromium is 156.0.8078.4. All three give hardware WebGL2 (`ANGLE Metal Renderer: Apple M3`), WebGPU
  adapter `apple`/`metal-3`, `crossOriginIsolated` on `/coi/`. WebGPU features: Chrome and bundled Chromium 23, Electron 24 (the
  extra one is `texture-compression-unaligned`; cause not investigated); the 36 adapter limits are identical.
- [V] Safari 27.0.1 (WebKit proxy, not WKWebView): WebGPU adapter `apple`/`apple` with 21 features and a working compute pass,
  WebGL2 `Apple GPU`, `crossOriginIsolated` true on `/coi/`, OPFS `createWritable` works, `AudioContext` stays suspended without a
  gesture. Safari's AppleScript lets a script close its own tabs (`tabs of window` indexes shift: iterate backwards).
- [V] Chrome `--app=<url> --user-data-dir=<dir>`: two profiles are isolated and persistent across `Browser.close` (5 of 5 runs),
  the browser UI is 32 px high in 5 of 5 runs against 87 px for a normal window (one screenshot, read once by the agent, showed a
  title bar only), CDP reads storage but cannot write it. The closed window's renderer exits 3.1 to 5.9 s after the close (the
  Assumed 5 s threshold falls inside the spread: PASS in 2, FAIL in 3 of 5 runs), and the Chrome
  process keeps running after its last window closes, so a launcher must quit it. A fresh profile showed a Google Translate bubble
  in the app window.
- [V] Public demos (webgpu-samples helloTriangle, cubemap, computeBoids; three.js webgl_animation_keyframes, webgl_shadowmap,
  webgpu_compute_birds) load in Electron 45 and Chrome 155 with WebGPU used where the page uses it and no Electron-only failure;
  the only console-error difference is Chrome's `/favicon.ico` 404.

### Licensing precedent

- [V] bitwarden/server uses AGPL-3.0 as the default license and a separate source-available license only for the
  `bitwarden_license` directory, with a separate trademark policy (LICENSE.txt via `gh api`).
- [V] The Harmony HA-CLA-I template is published under CC BY 3.0 (<https://www.harmonyagreements.org/>); Contributor
  Covenant 3.0 is licensed CC BY-SA 4.0 (<https://www.contributor-covenant.org/version/3/0/>).

### Cursor rules

- [V] Project rules live in `.cursor/rules/*.mdc` with frontmatter `description`, `globs`, `alwaysApply`; Cursor reads
  `AGENTS.md` natively. <https://cursor.com/docs/context/rules>

### Dev machine

- [V] macOS 27.0.1 on arm64 (Apple M3, Metal 4); Node 24.13.0 via nvm; Rust 1.98.1; Go 1.27.1; git 2.56.0; gh 2.102.0;
  Google Chrome and Xcode installed. A global Biome and a Homebrew lefthook 2.1.15 also exist.
- [V] No Windows or Linux machine is available, so those platforms are **unverified** until CI or a real run says
  otherwise.

## Gotchas

- pnpm 11+ skips dependency build scripts unless the package is listed in `allowBuilds` in `pnpm-workspace.yaml`
  (`strictDepBuilds` makes it an error, `ERR_PNPM_IGNORED_BUILDS`). Electron's binary download, esbuild and lefthook
  need entries. [V, pnpm 12.11 docs, 2026-10-24]
- pnpm 11+ reads only auth and registry settings from `.npmrc`; other settings go in `pnpm-workspace.yaml` in camelCase.
  [V, 2026-10-24: `save-exact` in `.npmrc` was ignored, `saveExact` in the YAML worked with pnpm 12.15.0]
- pnpm 11+ defaults `minimumReleaseAge` to 1440 minutes, so a version younger than a day cannot be installed. Electron
  45.0.0 (published 2026-10-21) resolved fine. [V, 2026-10-24]
- pnpm switches itself to the version in `packageManager` inside the repo (`pnpm -v` prints 11.7.0 outside it, 12.15.0
  inside) and records it in `pnpm-lock.yaml`. [V, 2026-10-24]
- Hooks and scripts must call tools through `pnpm exec`, because a global Biome and a Homebrew lefthook exist on the dev
  machine and can drift from the project versions.
- nvm reads `.nvmrc` (`nvm use`); `24` resolves to the newest installed Node 24.
- Electron approves every permission request unless a handler denies it.
- CDP IndexedDB is read/delete only, so restore cannot use CDP.
- `LICENSE` must stay the unmodified canonical AGPL text for GitHub to detect the license.
- `.gitattributes` forces LF so format checks behave the same on Windows checkouts.
- Contributor Covenant 3.0 is CC BY-SA 4.0, not CC BY 4.0; `CODE_OF_CONDUCT.md` keeps that attribution.
- The `packages` glob `fixtures/*` matches only one directory level; a package at `fixtures/test-games/<name>` needs
  `fixtures/*/*` or the explicit `fixtures/test-games/*`, which `pnpm-workspace.yaml` now uses. [V, 2026-10-24, tested
  with pnpm 12.15.0]
- `tsc -b` with `references` needs `composite: true` and refuses `noEmit` (TS6306, TS6310), which the base config sets.
  The root `typecheck` script therefore lists the projects instead: `tsc -b . fixtures/test-games/progress-lab`; a new
  `tsconfig.json` outside the root one must be added there. [V, 2026-10-24, TypeScript 7.0.2]
- Biome 2.6's `usePlaywrightValidDescribeCallback` flags any call to a function named `describe`, even a local helper.
  [V, 2026-10-24]
- `@playwright/test` `webServer.port` is deprecated; use `url`. `pnpm test:e2e --project=chromium` forwards the
  arguments to Playwright. `node:http` sends `..` paths byte for byte while `fetch` and `new URL` collapse them, so
  traversal tests use `node:http`. [V, 2026-10-24]
- `spike` is not a Conventional Commits type in `@commitlint/config-conventional`; `commitlint.config.mjs` adds it to
  the preset's list. [V, 2026-10-24: `spike: ...` accepted, `wip: ...` and `Spike: ...` rejected]
- `allowBuilds: {lefthook: true}` in `pnpm-workspace.yaml` is the working build-allowlist key in pnpm 12.15.0. Without
  it `pnpm add` fails with `ERR_PNPM_IGNORED_BUILDS` and no placeholder entry is written. Vitest 5 uses rolldown, so
  esbuild is not installed and needs no entry. [V, 2026-10-24]
- lefthook's postinstall creates a commented-out default `lefthook.yml` when none exists, and installs the hooks. The
  generated hook script prefers a `lefthook` on `PATH` over `node_modules`, so on this machine git runs the Homebrew
  2.1.15, not the project's 2.2.2. `min_version` is therefore `2.1.15` (config tested with both). [V, 2026-10-24]
- markdownlint-cli2 appends the config `globs` to command-line globs, so `.markdownlint-cli2.jsonc` has none: the
  `docs:lint` script passes `"**/*.md"` and the pre-commit hook passes the staged files. `gitignore: true` skips
  ignored paths such as `.superpowers/`. MD013 (line length) is off, MD041 is off only for the pull request template,
  and MD004, MD022 and MD032 are off only under `docs/plans/` (compact plan layout). [V, 2026-10-24]
- Biome 2.6 deprecates `linter.rules.recommended`; use `linter.rules.preset: "recommended"`. [V, 2026-10-24]
- `webContents.debugger` commands (even `Network.enable`) hang on a window that never navigated: load `about:blank`
  first. `app.getGPUFeatureStatus()` right after `ready` says everything is disabled until `app.getGPUInfo("complete")`
  or a first render. [V, 2026-10-24, Electron 45 spike]
- Frame timing on the dev Mac: [V, 2026-10-24, Electron 45 spike, RESULTS.md "Findings and gotchas"] a locked screen puts
  `loginwindow` in front and no window can be focused. With `--disable-gpu-vsync --disable-frame-rate-limit` the uncapped
  launches took 38.5, 37.4 and 63.5 s instead of about 23 s (15 to 41 s of work after the page had finished), and a dev
  run that interleaved uncapped with capped runs gave a capped p95 of 34.2 and 33.3 ms against 18.6 ms with cooldowns and
  no interleaving (those dev runs are not committed). [A] Cause: uncapped Chromium queues GPU work (heat is possible; `pmset -g therm` recorded no
  warning); keep cooldowns and do not interleave.
- The prebuilt Electron 45.0.0 app's `Info.plist` ships five usage descriptions: `NSCameraUsageDescription`,
  `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` and two Bluetooth ones. [V, 2026-10-25, `plutil -p` on
  `Electron.app/Contents/Info.plist` of `electron@45.0.0` in the spike's `node_modules`] The packaged launcher must not
  ship them (security.md section 5). electron-vite's example `electron-builder.yml` adds the camera and microphone
  ones, so do not copy it as is. [V, 2026-10-25, electron-vite docs "Distribution", as recorded in ADR-0004]
- `app.setAsDefaultProtocolClient` leaves a LaunchServices handler preference (an `LSHandlers` entry in
  `~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`) that outlives `lsregister -u`
  and the deleted app. [V, 2026-10-24, Electron 45 spike]
- In zsh, `log` is a shell builtin: call the macOS unified log as `/usr/bin/log`. [V, 2026-10-24]
- lefthook `stage_fixed` re-stages whole files, so a partially staged file (`git add -p`) gets fully staged by the
  Biome fix. [U] not tested here
- CDP `IndexedDB.requestData` fails with "Could not get index" when `indexName` is an empty string; leave the parameter out to
  read the object store (Chrome 155). A stale `DevToolsActivePort` file in a reused user-data directory names a dead port: delete
  it before relaunching Chrome with `--remote-debugging-port=0`. [V, 2026-10-24, Task 6 spike]
- Playwright launches Chrome headed but `viewport: null` plus `Browser.setWindowBounds` over CDP is needed to get an exact
  1280 x 720 CSS-pixel viewport at the native scale factor; `Page.bringToFront` is enough to get focus. [V, 2026-10-24]
- In zsh an unmatched glob aborts the whole command (`rm -f a-* b-*` removed nothing when `b-*` matched nothing). [V, 2026-10-24]

## Open questions

- Final product display name (codename is `wg-launcher`).
- Lawyer review of `CLA.md`, `LICENSING.md` and `TRADEMARKS.md` (the CLA party and governing law are filled in; whether
  the Harmony template wording, such as the UN Convention exclusion in section 6.1, and the waiver of moral rights fit
  Russian law is for the lawyer), and setting up the CLA Assistant app (owner action). Does the CLA need a postal
  address or another contact for the owner beyond the GitHub account? Default: the lawyer decides.
- Does Electron pass H7 on the launcher (Phase 1 condition of ADR-0002 and ADR-0005)? Chrome 156 is not installed on the
  dev machine, so a result against Chrome 155 carries the label "version mismatch". Default until measured: Electron
  stays the runtime.
- `node:sqlite` works in Electron 45 main and `utilityProcess` without a warning (spike H10); its stability label in
  Node 24.22 is still unchecked.
- WebGPU works by default in Electron 45 on this Mac (spike H5); Chrome 155 reports 23 features, Electron 24 (one extra, `texture-compression-unaligned`): cause unknown.
- Cross-origin isolation works on Electron 45.0.0 (spike H3, H4); 44.x was not tested (no retry was needed).
- Esc in launcher-set fullscreen (PRD OQ-8, architecture.md section 9): default is Esc held for 1.5 s exits and short
  presses reach the game, so the launcher never takes Esc from a game; "every Esc exits" is a one-line policy change.
- Branch protection on `main` (suggested only, owner decision).
