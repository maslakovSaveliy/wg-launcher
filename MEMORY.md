# MEMORY.md

Shared memory for all agents and contributors. Append dated entries; fix or remove stale ones (see `AGENTS.md`).
Tags: `[V]` Verified (date, source), `[A]` Assumed (reasoned, not checked), `[U]` Unverified (reported, not checked).
All entries below are dated 2026-10-24 unless they say otherwise.

## Decisions

- 2026-10-24 Phase 0 plan: [docs/plans/2026-10-24-phase-0-foundation.md](docs/plans/2026-10-24-phase-0-foundation.md).
  Decisions are formalized as ADRs in `docs/adr/` later in Phase 0; until then this plan is the record.
- Phase 0 produces specs, docs, rules and tooling only. No launcher client code until Phase 1, which gets its own plan.
- Own small Electron client, not a fork of itch, Flashpoint, Pixens or web-runner. Their code is not reused (patterns
  only). The runtime choice stays provisional until a throwaway Electron / Tauri 2 / Chrome compatibility spike runs.
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
- Execution style: subagent-driven development; test-first where code exists.
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
  secretlint 13.0.7, markdownlint-cli2 0.24.0, pnpm 12.15.0 (latest).
- [V] Biome 2.6 covers JS/TS/JSX/TSX/JSON/CSS; it has no Markdown support.
  <https://biomejs.dev/internals/language-support/>
- [V] `node:sqlite` is release candidate since Node 25.7 and needs no flag since 22.13. [U] Its stability label in
  Node 24.22. <https://nodejs.org/api/sqlite.html>
- [V] `pnpm licenses list --json` exists in pnpm 12.15.0 (prints `{}` with no dependencies). [U] Its JSON shape with
  real dependencies.
- [U] Compatibility of the toolchain with TypeScript 7.

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
  `fixtures/*/*`. [V, 2026-10-24, tested with pnpm 12.15.0; change the glob when the first fixture package is added]
- `spike` is not a Conventional Commits type in `@commitlint/config-conventional`; the commitlint config must add it.
  [A]

## Open questions

- Final product display name (codename is `wg-launcher`).
- Lawyer review of `CLA.md`, `LICENSING.md` and `TRADEMARKS.md`; jurisdiction and legal-name placeholders in the CLA;
  setting up the CLA Assistant app (owner action).
- Is `node:sqlite` stable enough in Electron 45 for the main process? The spike verifies it.
- Does WebGPU work by default in Electron 45 on macOS arm64? The spike verifies it.
- Which Electron versions carry the COOP/COEP regression fix, and does cross-origin isolation work on 44 and 45?
- Snapshot record encoding: deterministic CBOR or tagged JSONL (decided in the snapshot spec).
- Does the toolchain work with TypeScript 7, or must it fall back to 6.0.3?
- Branch protection on `main` (suggested only, owner decision).
- Which packaging tool wins after the spike packages once (electron-builder is the current lean)?
