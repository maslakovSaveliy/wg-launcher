# Research: runtime, platforms and save extraction

Evidence for ADR-0002 (desktop runtime), ADR-0003 (native languages), ADR-0005 (save transfer) and the save-transfer
spec. Collected on 2026-10-24. Open-source bases and test games are in [foundations.md](foundations.md). The planned
runtime experiment is `spikes/runtime-compat/HYPOTHESES.md`.

## Reading this document

- Every factual statement ends with a tag from [AGENTS.md](../../AGENTS.md#documentation-rules): `Verified (date,
  source)` means it was read from the cited source on that date, `Assumed` means reasoned and not checked, `Unverified`
  means reported and not checked. A tag at the end of a bullet or a table row covers that whole bullet or row, unless a
  second tag inside it says otherwise.
- `H<n>` refers to a hypothesis in `spikes/runtime-compat/HYPOTHESES.md`. Section 9 lists every Unverified item and what
  can settle it.

## 1. Where this leaves the runtime choice

- Electron 45 is the planned runtime, provisional until the spike has run. Assumed (the owner's preliminary choice, see
  [MEMORY.md](../../MEMORY.md); no spike result exists yet).
- Tauri 2 is the only alternative worth measuring. Tauri 3 with a CEF runtime is alpha and not a candidate (section 3).
  Assumed (reasoning from section 3).
- A Chrome `--app` mode with a per-game profile is the fallback architecture if Electron fails the GPU or performance
  criteria while Chrome passes (H20). Assumed (decision rule in the hypotheses file).

## 2. Electron

### 2.1 Versions and support

| Item | Value | Tag |
| --- | --- | --- |
| Latest stable | Electron 45.0.0, npm `latest`, published 2026-10-21: Chromium 156.0.8078.48, Node 24.22.0, V8 15.6 | Verified (2026-10-24, <https://releases.electronjs.org/release/v45.0.0>, `npm view electron`) |
| Next major | 46.0.0-alpha.1 published 2026-10-23 (Chromium M160); stable planned 2027-01-05 | Verified (2026-10-24, <https://releases.electronjs.org/schedule>) |
| Support policy | The latest 3 stable majors, latest minor of each; a new major every 8 weeks | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>) |
| Supported now | 45, 44 (Chromium M152), 43 (M150); 42 reached end of life on 2026-10-20 | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>) |
| End of life of 45 | Tentatively 2027-04-27 | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>) |
| Fallback line | 44.9.3 published 2026-10-21; 44.0.0 published 2026-08-25; 43.0.0 published 2026-06-30 | Verified (2026-10-24, `npm view electron time`) |

- Consequence: a major every 8 weeks and a support window of about six months mean a recurring upgrade task for the
  project. Assumed (reasoning from the table).

### 2.2 Changes in Electron 45 that matter

- Display, window and tab capture permission requests now arrive as `display-capture`. Verified (2026-10-24,
  <https://releases.electronjs.org/release/v45.0.0>).
- Sandboxed preloads lost `Buffer`, `events`, `timers` and `url`, so the launcher's typed preload bridge must not rely on
  them. Verified (2026-10-24, <https://releases.electronjs.org/release/v45.0.0>) for the removal; the consequence for the
  bridge is Assumed.
- 32-bit builds are gone; only x64 and arm64 remain. Verified (2026-10-24, <https://releases.electronjs.org/release/v45.0.0>).
- `protocol.registerSource()` is new and experimental, and `protocol.handle` rejects scheme names that are invalid under
  RFC 3986. Verified (2026-10-24, <https://releases.electronjs.org/release/v45.0.0>,
  <https://www.electronjs.org/docs/latest/api/protocol>).

### 2.3 APIs we rely on

| Need | API and facts | Tag |
| --- | --- | --- |
| One persistent session per game | `session.fromPartition('persist:x')` is persistent; without the `persist:` prefix it is in memory; `session.fromPath(absPath)` exists | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/api/session>) |
| Wiping or clearing data | `ses.clearStorageData({origin, storages})` with kinds cookies, filesystem, indexdb, localstorage, shadercache, serviceworkers, cachestorage; `ses.clearData` supports `origins` and `excludeOrigins` | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/api/session>) |
| Permissions | `setPermissionRequestHandler(wc, permission, cb, details)` also covers pointerLock, fullscreen, keyboardLock and display-capture; `setPermissionCheckHandler` and `setDevicePermissionHandler` exist; Electron approves every permission request by default | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/api/session>) |
| Embedding a view | `BrowserView` is deprecated since 29.0.0; use `WebContentsView` | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/api/browser-view>) |
| Custom protocol per session | `protocol.handle` replaced the register and intercept APIs in 25.0.0; handlers are per session (`ses.protocol.handle`); `registerSchemesAsPrivileged` must run before `ready`, once | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/api/protocol>) |
| Deep links and single instance | On macOS `setAsDefaultProtocolClient` works only for schemes declared in `Info.plist` at build time; `requestSingleInstanceLock(additionalData)` plus `second-instance(event, argv, workingDirectory, additionalData)`; on macOS and Linux messages over 32 MB are dropped; register `open-url` before `ready` | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/api/app>) |
| Debugger and isolated worlds | `webContents.debugger` and `contents.executeJavaScriptInIsolatedWorld` are documented | Verified (2026-10-24, <https://github.com/electron/electron/blob/main/docs/api/web-contents.md>) |
| Background worker | `utilityProcess.fork(modulePath, args, {serviceName, stdio, execArgv, ...})`, callable after `ready`, with `postMessage` and `MessagePortMain` | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/api/utility-process>) |
| Packaging | The official tutorial recommends Electron Forge (8.0.0 published 2026-09-29, now 8.0.1); electron-builder 26.18.0 published 2026-10-24; electron-vite 6.0.0 published 2026-10-14 with peer `vite` ^6 or ^7 or ^8 | Verified (2026-10-24, <https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging>, `npm view`) |
| End-to-end tests | Playwright's Electron support is labelled experimental and needs Electron v21 or later | Verified (2026-10-24, <https://playwright.dev/docs/api/class-electron>) |

### 2.4 Security checklist highlights and fuses

- The security tutorial has 20 items. Highlights we map to our rules: context isolation is the default since Electron
  12 and the sandbox since 20; never give remote content Node; keep `webSecurity`; no `enableBlinkFeatures` or
  `experimentalFeatures`; check `will-navigate` with a proper URL parser; deny new windows by default through
  `setWindowOpenHandler`; never pass untrusted URLs to `shell.openExternal`; validate the IPC sender; prefer custom
  protocols over `file://`. Verified (2026-10-24, <https://www.electronjs.org/docs/latest/tutorial/security>).
- Fuses (`@electron/fuses` 2.1.3): turn off `runAsNode`, `nodeOptions`, `nodeCliInspect` and
  `grantFileProtocolExtraPrivileges`; turn on `cookieEncryption`, `embeddedAsarIntegrityValidation` (macOS and Windows)
  and `onlyLoadAppFromAsar`. Verified (2026-10-24, <https://www.electronjs.org/docs/latest/tutorial/fuses>).
- Our hard rules in [AGENTS.md](../../AGENTS.md#hard-rules) are intended to satisfy the checklist; the mapping belongs to
  `docs/specs/security.md`. Assumed.

### 2.5 GPU, cross-origin isolation and known issues

| Topic | Fact | Tag |
| --- | --- | --- |
| WebGPU in Electron | No Electron documentation states that WebGPU is on by default (H5 settles it on macOS arm64) | Unverified (2026-10-24, no Electron doc found) |
| WebGPU in Chromium | Chromium ships WebGPU on Windows x64 and macOS since version 113, behind a flag on Windows ARM64 and most Linux; Electron issues #43567 and #46613 show apps using it | Unverified (reported by <https://github.com/gpuweb/gpuweb/wiki/Implementation-Status>, edited 2026-10-02, not tested here) |
| Cross-origin isolation regression | Electron 41 on macOS left COOP/COEP pages not cross-origin isolated (issue #50242); PR #50789 fixing it was merged on 2026-04-30 | Verified (2026-10-24, <https://github.com/electron/electron/issues/50242>) |
| Where the fix landed | Which Electron versions carry the backport of that fix | Unverified (not checked; H3 and H4 test 45.0.0 and 44.9.x) |
| Pointer lock on Wayland | Issue #49754 was fixed in 2026-02; #47073 was closed as not planned | Verified (2026-10-24, <https://github.com/electron/electron/issues/49754>, <https://github.com/electron/electron/issues/47073>) |
| Gamepad with Steam Input | Issue #45989 was closed as completed in 2025-09 | Verified (2026-10-24, <https://github.com/electron/electron/issues/45989>) |
| Fullscreen | The only open fullscreen issue found is the Linux and Wayland display pick (#54625) | Verified (2026-10-24, <https://github.com/electron/electron/issues/54625>) |
| Offscreen rendering on Linux | A Vulkan shared-texture crash (#54553) affects offscreen rendering only; we do not plan offscreen rendering | Verified (2026-10-24, <https://github.com/electron/electron/issues/54553>) for the issue; that it does not affect us is Assumed |

## 3. Tauri

| Topic | Fact | Tag |
| --- | --- | --- |
| Version | Tauri 2 stable is 2.12.5 (crates.io, 2026-10-21); `@tauri-apps/cli` and `@tauri-apps/api` are 2.12.4 (2026-10-21, license `Apache-2.0 OR MIT`); 2.12 was announced on 2026-09-26 | Verified (2026-10-24, <https://v2.tauri.app/blog/>, `cargo search tauri`, `npm view @tauri-apps/cli`) |
| Engines | WebView2 on Windows (evergreen), WKWebView on macOS and iOS (updates with the OS), WebKitGTK on Linux (distribution-provided), system WebView on Android | Verified (2026-10-24, <https://v2.tauri.app/reference/webview-versions/>) |
| Per-webview data | `data_directory` is not supported on WKWebView; `data_store_identifier` needs macOS 14 or iOS 17 and is unsupported on Windows, Linux and Android; `incognito` needs WebView2 101 or later and is not available on Android | Verified (2026-10-24, <https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html>) |
| Several webviews in one window | `Window::add_child` needs the `unstable` feature and works on desktop only | Verified (2026-10-24, <https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html>) |
| COOP and COEP | Can be set through the security `headers` configuration | Verified (2026-10-24, <https://v2.tauri.app/reference/config/>) |
| WebGPU in WKWebView | Works out of the box on macOS and iOS 26 or later according to a maintainer (2025-11-24); one user saw a failure only in a dev build | Verified (2026-10-24, <https://github.com/tauri-apps/tauri/issues/6381>) |
| Tauri 3 and CEF | Alpha only: `tauri-v3.0.0-alpha.5` and `tauri-runtime-cef-v3.0.0-alpha.6` were released on 2026-10-14; the v3 site still shows the v2 landing page; open bugs include Linux keyboard and focus (#16251, #16351) and Linux WebGPU falling back to SwiftShader (#16203) | Verified (2026-10-24, <https://github.com/tauri-apps/tauri/releases>, <https://github.com/tauri-apps/tauri/issues/14963>) |
| Mobile | iOS and Android are part of Tauri since 2.0 stable (2024-10-02) | Verified (2026-10-24, <https://v2.tauri.app/blog/>) |
| WebKitGTK WebGPU; custom-protocol COOP and COEP | Behavior of WebGPU in WebKitGTK, and of COOP and COEP on custom protocols on every OS, was not checked | Unverified (2026-10-24, not tested) |

- The engine differs per OS and its version follows the OS or the distribution, so every game would need a per-OS and
  per-engine compatibility record, and we could not pin the engine. Assumed (reasoning from the engines row).
- WKWebView does not speak the Chrome DevTools Protocol, so save extraction in Tauri would need different means than the
  Electron plan. Assumed (reasoning; not tested, see section 9).

## 4. iOS and Android

- App Store guideline 2.5.6 requires apps that browse the web to use the appropriate WebKit framework; alternative
  engines need an entitlement available only in the EU and Japan. Guideline 4.7 allows HTML5 mini games under
  moderation, indexing and age-rating rules. Verified (2026-10-24,
  <https://developer.apple.com/app-store/review/guidelines/>).
- Desktop Chromium and Electron code cannot be shipped on iOS; an iOS client would use WKWebView (iOS 17 for per-game
  data stores, iOS 26 for WebGPU) and behave differently from desktop Chromium. Assumed (reasoning from the guideline
  and the Tauri facts in section 3).
- Android's system WebView is Chromium-based. Assumed (general knowledge, not checked in this research).
- Consequence: the snapshot format must not depend on Chromium internals, so that a later WebKit or WebView client can
  read and write the same snapshots. Assumed.

## 5. Save extraction

### 5.1 Chrome DevTools Protocol domains

| Domain (all experimental) | Can | Cannot | Tag |
| --- | --- | --- | --- |
| IndexedDB | `requestDatabaseNames`, `requestDatabase`, `requestData` (paged), `getMetadata`, `clearObjectStore`, `deleteObjectStoreEntries` (key range), `deleteDatabase`; commands accept `storageKey` and `storageBucket` | No put or add: it can read and delete but cannot restore. Records come back as `RemoteObject` references | Verified (2026-10-24, <https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/IndexedDB.pdl>) |
| DOMStorage | Get, set, remove and clear items by `storageId` (`securityOrigin` or `storageKey`, plus `isLocalStorage`); values are strings | Nothing beyond strings | Verified (2026-10-24, <https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOMStorage.pdl>) |
| Storage | `getStorageKey({frameId?})` (replaces the deprecated `getStorageKeyForFrame`); `clearDataForOrigin` and `clearDataForStorageKey` with a comma list (indexeddb, local_storage, file_systems, cache_storage, service_workers, storage_buckets, all) | Does not read or write values | Verified (2026-10-24, <https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Storage.pdl>) |

- How binary values in `RemoteObject` records are fetched through CDP was not checked. Unverified (2026-10-24, not
  tested).

### 5.2 Isolated worlds

- `webFrame.executeJavaScriptInIsolatedWorld(worldId, scripts)`: world 0 is the page, world 999 is Electron's context
  isolation world; if the script throws, the promise resolves with `undefined`, so an exporter must catch its own
  errors and return an explicit error object. Verified (2026-10-24, <https://www.electronjs.org/docs/latest/api/web-frame>)
  for the API; the exporter rule is Assumed.
- Chrome documents that storage calls from content scripts (isolated worlds) reach the host page's own data. Verified
  (2026-10-24, <https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies>).
- Applying that to Electron, an isolated-world exporter can use the real IndexedDB API with full structured clone. Assumed
  (extension of the Chrome documentation to Electron; H14 tests it).

### 5.3 Emscripten IDBFS layout and flush semantics

- IDBFS uses the object store `FILE_DATA` in a database of version 21 with an index `timestamp`. The key is the absolute
  path and the value is `{timestamp: Date, mode, contents: Uint8Array}`, or `{timestamp, mode, link}` for a link.
  Verified (2026-10-24, <https://raw.githubusercontent.com/emscripten-core/emscripten/main/src/lib/libidbfs.js>).
- The in-memory file system is the truth while the program runs. `syncfs(true)` loads IndexedDB into MEMFS,
  `syncfs(false)` writes back, and `autoPersist` saves on close. Verified (2026-10-24,
  <https://raw.githubusercontent.com/emscripten-core/emscripten/main/src/lib/libidbfs.js>).
- So closing a window does not prove the game flushed: export only after a confirmed flush, and restore before the
  startup `syncfs(true)`. Assumed (reasoning from the two points above).

### 5.4 Unity WebGL

- Unity states that it stores up to 1 MB of PlayerPrefs in the browser's IndexedDB. Verified (2026-10-24,
  <https://docs.unity3d.com/ScriptReference/PlayerPrefs.html>).
- Its path under `/idbfs/<build-hash>/PlayerPrefs` changes with each build (community report), and a Unity 6000.0
  `autoSyncPersistentDataPath` fix was mentioned. Unverified (2026-10-24,
  <https://itch.io/t/140214/persistent-data-in-updatable-webgl-games>; the issue page for the fix did not load).

### 5.5 Storage keys and partitioning

- Since Chrome 115, third-party iframe storage is keyed by the iframe's origin plus the top-level site. A snapshot must
  therefore record the full storage key, and a restore under a different top-level site lands in a different partition.
  Verified (2026-10-24, <https://developer.chrome.com/docs/privacy-sandbox/storage-partitioning>).
- Changing scheme, host or port also changes the origin and so the visible storage. Assumed (standard origin rules, not
  re-checked here; the concept document raises the same point).

### 5.6 OPFS

- OPFS has no CDP domain, so reading it needs an in-page script. Unverified (2026-10-24, not checked against the full
  list of CDP domains).

### 5.7 Export libraries and compression

- dexie-export-import 4.4.2 (Apache-2.0, published 2026-10-23) handles Date, ArrayBuffer, Blob and similar types
  through typeson `$types`, not CryptoKey; it can export databases that are not Dexie databases and streams in chunks.
  Verified (2026-10-24,
  <https://raw.githubusercontent.com/dexie/Dexie.js/master/addons/dexie-export-import/README.md>). Whether it inlines
  Blobs as base64 is Unverified (not checked).
- indexeddb-export-import 2.2.0 (MIT) handles JSON strings only, no binary data, so it is unsuitable. Verified
  (2026-10-24, `npm view indexeddb-export-import`, package README).
- Node 24.13 on the dev machine has `zlib.zstdCompressSync`, and Electron 45 ships Node 24.22. Verified (2026-10-24,
  run locally: `node -e "console.log(typeof require('zlib').zstdCompressSync)"`; Electron's Node version from
  <https://releases.electronjs.org/release/v45.0.0>). That Electron's own Node exposes zstd is Assumed (H10 checks it).

### 5.8 Design consequences

- One uniform export and restore mechanism, an isolated-world script in a quiescent window of the same partition,
  because CDP cannot write IndexedDB. Assumed (H14 tests it).
- CDP is used only to discover the storage key, wipe, and cross-check by reading. Assumed.
- Value types that need explicit handling: Date, Blob, typed arrays, binary keys, `-0` and `NaN`; an unsupported type is
  an explicit error. Assumed (design rule from [AGENTS.md](../../AGENTS.md#data-safety-invariants)).

## 6. Go and Rust

- Go 1.27.1 (darwin/arm64) and Rust 1.98.1 are installed on the dev machine. Verified (2026-10-24, run locally:
  `go version`, `rustc --version`).
- itch's butler is MIT-licensed Go. Verified (2026-10-24, `gh api repos/itchio/butler`). GitHub reports the license of
  `klauspost/compress` as `NOASSERTION` (mixed BSD and Apache files); the exact terms are Unverified (not read).
- Rust is deferred to the local-packages stage; the MVP snapshot codec is TypeScript, with a language-neutral spec and
  golden vectors so a later Rust version can pass the same vectors. Go is not adopted in the MVP. Verified (2026-10-24,
  [MEMORY.md](../../MEMORY.md) Decisions, owner decisions).
- Reasons for Go not being adopted: it fills the same sidecar niche as Rust, and Rust is better placed for reuse through
  napi-rs, Tauri and mobile. Revisit triggers: reusing butler and wharf for delta patching at the packages stage, or a
  measured backend performance need (the backend would start as NestJS). Assumed.
- Rust does not raise the frame rate of a web game; rendering, shader compilation and game logic stay in the browser
  engine. Rust suits large files, streaming downloads and unpacking, hashing, compression and background queues.
  Assumed (reasoning; concept document section 8).

## 7. Tooling version snapshot

The living list is in [MEMORY.md](../../MEMORY.md) (Tooling versions). This table keeps only versions that matter for
the runtime and storage decisions.

| Package | Version and note | Tag |
| --- | --- | --- |
| electron | 45.0.0 | Verified (2026-10-24, `npm view electron version`) |
| electron-vite | 6.0.0 | Verified (2026-10-24, `npm view electron-vite version`) |
| @electron-forge/cli | 8.0.1 | Verified (2026-10-24, `npm view @electron-forge/cli version`) |
| electron-builder | 26.18.0 | Verified (2026-10-24, `npm view electron-builder version`) |
| vite, react | 8.3.5, 19.3.1 | Verified (2026-10-24, `npm view vite version`, `npm view react version`) |
| typescript | 7.0.2 is `latest` (native build); 6.0.3 is the last 6.x; it works with our whole toolchain | Verified (2026-10-24, `npm view typescript version`; local run recorded in [MEMORY.md](../../MEMORY.md)) |
| @playwright/test | 1.64.1 | Verified (2026-10-24, `npm view @playwright/test version`) |
| zod, uuid | 4.6.7, 14.0.3 | Verified (2026-10-24, `npm view zod version`, `npm view uuid version`) |
| better-sqlite3 | 13.0.3 (native addon, Node 22 or later); not chosen, `node:sqlite` is preferred | Verified (2026-10-24, `npm view better-sqlite3 version`) |
| node:sqlite | Release candidate (stability 1.2) since Node 25.7; no flag needed since 22.13; its stability label in Node 24.22 is Unverified | Verified (2026-10-24, <https://nodejs.org/api/sqlite.html>) |
| dexie-export-import | 4.4.2 (Apache-2.0) | Verified (2026-10-24, `npm view dexie-export-import version`) |
| tar, tar-stream | 7.5.22 (BlueOak-1.0.0), 3.2.2 (MIT) | Verified (2026-10-24, `npm view tar version`, `npm view tar-stream version`) |
| wasm-feature-detect | 1.9.0 (Apache-2.0) | Verified (2026-10-24, `npm view wasm-feature-detect version`) |
| @napi-rs/cli | 3.10.9 | Verified (2026-10-24, `npm view @napi-rs/cli version`) |
| Rust crates | tauri 2.12.5 stable (3.0.0-alpha.5 is the newest published), tauri-runtime-cef 3.0.0-alpha.6, wry 0.57.1, tokio 1.54.1, serde 1.0.229, serde_json 1.0.154, blake3 1.8.7, zstd 0.14.3, tar 0.4.46, zip 9.1.0, tempfile 3.27.0, thiserror 2.0.21, anyhow 1.0.104, clap 4.6.7, cargo-deny 0.20.2 | Verified (2026-10-24, `cargo search <crate>`) |

- Biome 2.6.2 also formats Markdown and YAML by default, contrary to an earlier note in this research. Verified
  (2026-10-24, run locally: `biome check .` rewrote tables in `AGENTS.md`; recorded in [MEMORY.md](../../MEMORY.md)).

## 8. Dev machine and platform coverage

- The dev machine runs macOS 27.0.1 on arm64 (Apple M3, Metal 4) with Node 24.13.0 (via nvm), Google Chrome and Xcode.
  Verified (2026-10-24, run locally: `sw_vers`, `uname -m`, `node -v`).
- No Windows or Linux machine is available, so those platforms are unverified until CI or a real run says otherwise. A
  CI runner proves install and unit tests only. Verified (2026-10-24, [MEMORY.md](../../MEMORY.md) Dev machine, owner
  statement); that a runner proves no game compatibility is Assumed (no GPU, no interactive session).
- Results from one machine do not transfer to other machines or OS versions. Assumed (reasoning; concept document
  section 14 says the same).

## 9. Open questions

Every Unverified item above (and the key Assumed ones), and what can settle it.

| Item | State | Settled by |
| --- | --- | --- |
| WebGPU on by default in Electron 45 on macOS arm64 | Unverified | H5 (adapter and device), H19 (Chrome reference) |
| Which Electron versions carry the COOP and COEP fix | Unverified | H3 and H4 on 45.0.0, then on 44.9.x if needed |
| Chromium WebGPU availability per OS (reported by the gpuweb wiki) | Unverified | macOS arm64 by H5 and H19; Windows ARM64 and Linux are not settleable here (no such machine, and a CI runner without GPU is not evidence) |
| WebGPU in WebKitGTK; COOP and COEP on custom protocols on every OS | Unverified | Only macOS is testable (H18); the rest waits for Windows and Linux machines |
| How a Tauri (WKWebView) app would extract saves without CDP | Unverified | Not settled by the spike, which tests isolation, not extraction; needs its own investigation if Tauri survives the decision rules |
| An isolated-world exporter in Electron reaches the origin's real IndexedDB with full structured clone | Assumed | H14 |
| `node:sqlite` stability label in Node 24.22 inside Electron 45; zstd in Electron's Node | Unverified | H10 |
| Binary values from CDP `IndexedDB.requestData` | Unverified | Not needed for restore (H14 uses an isolated world); check only if a CDP read-only cross-check is kept |
| OPFS has no CDP domain | Unverified | Read the full CDP domain list; H1 and H2 only probe per-partition OPFS persistence, not extraction |
| Whether dexie-export-import inlines Blobs as base64 | Unverified | Snapshot format spec (record encoding decision), not the spike |
| Unity PlayerPrefs path per build and the Unity 6000.0 fix | Unverified | Needs a real Unity WebGL build; later |
| Exact license of `klauspost/compress` | Unverified | Only if Go is ever adopted |
| Real Emscripten `syncfs` flush behavior | Unverified | Needs a small own Emscripten fixture; `progress-lab` only imitates the IDBFS layout |
