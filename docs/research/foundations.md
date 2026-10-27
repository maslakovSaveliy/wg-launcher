# Research: open-source bases, comparable projects and test games

Evidence for ADR-0001 (own client, not a fork), ADR-0006 (licensing model) and the choice of test games. Collected on
2026-10-24. The runtime and save-extraction evidence is in [runtime-and-storage.md](runtime-and-storage.md).

## Reading this document

- Every factual statement ends with a tag from [AGENTS.md](../../AGENTS.md#documentation-rules): `Verified (date,
  source)` means it was read from the cited source on that date, `Assumed` means reasoned and not checked, `Unverified`
  means reported and not checked. A tag at the end of a bullet or a table row covers that whole bullet or row, unless a
  second tag inside it says otherwise.
- `gh api` is the GitHub REST API, called on 2026-10-24 for repository metadata, commits, `LICENSE` files and file
  contents. Licenses below come from the `LICENSE` file at the checked commit, not from GitHub's automatic
  classification. Verified (2026-10-24, `gh api repos/<owner>/<repo>/contents/LICENSE`).
- Limit: the evidence is `gh api` reads and documentation. No fork candidate was built or run. Verified (2026-10-24,
  method of this research: `gh api` reads only).

## 1. Verdict

Build a small own Electron client. Take ideas (per-game session naming, custom protocol per session) from itch and
Ferdium; copy no code from any base. Assumed (reasoning from sections 2 to 4; ADR-0001 records the decision).

## 2. The four priority bases

### 2.1 Comparison

| Base | License of own code | Checked commit (date) | Activity | Electron | Build and UI stack | Tag |
| --- | --- | --- | --- | --- | --- | --- |
| [itchio/itch](https://github.com/itchio/itch) | MIT | f5a18100 (2026-10-08) | Very active: 100+ commits in 3 months | ^44.5.1 | esbuild plus custom scripts, tsc, React 18 | Verified (2026-10-24, `gh api repos/itchio/itch`) |
| [FlashpointProject/launcher](https://github.com/FlashpointProject/launcher) | MIT; the `LICENSE` also lists bundled third-party code, including 7zip under LGPL (GitHub reports `NOASSERTION`) | e5f45fc1 (2026-09-28) | Moderate: 12 commits in 3 months | 19.1.9 | gulp, swc, esbuild, electron-builder 24, React 17, Redux | Verified (2026-10-24, `gh api repos/FlashpointProject/launcher`) |
| [arhitekt86/pixens-launcher](https://github.com/arhitekt86/pixens-launcher) | MIT | 8a52abbb (2026-05-21) | 2 commits in total, 0 stars | ^33.2.0 | electron-vite 2, Vite 5, electron-builder 25, React 18 | Verified (2026-10-24, `gh api repos/arhitekt86/pixens-launcher`) |
| [lutris/web-runner](https://github.com/lutris/web-runner) | GPL-3.0 | 15bb58c2 (2026-02-24) | Almost dormant: 2 commits since 2022 | 4.2.12, pinned in the Makefile | electron-packager plus Make, plain JS | Verified (2026-10-24, `gh api repos/lutris/web-runner`) |

- Rough size (byte-based estimates): itch about 690 files and 1.6 MB of TS and JS in `src`; Flashpoint about 430 files
  and 1.8 MB plus an extension system; Pixens about 60 files and 200 KB (the UI is mostly one large JSX file);
  web-runner about 10 KB of JS in 3 files. Verified (2026-10-24, `gh api repos/itchio/itch` and the three other
  repositories listed above).
- Flashpoint's Electron 19.1.9 is far outside the supported window (Electron 43 to 45 are supported on 2026-10-24).
  Verified (2026-10-24, `gh api repos/FlashpointProject/launcher`;
  <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>).

### 2.2 How each base opens web games

- itch opens a game in its own `BrowserWindow` on a per-game persistent session named `persist:gamesession_${game.id}`,
  created with `session.fromPartition(..., {cache:false})`. Verified (2026-10-24, `gh api
  repos/itchio/itch/contents/src/common/util/partition-for-user.ts`).
- itch keeps `contextIsolation` on and `nodeIntegration` off, but sets `sandbox:false` and `webSecurity:false` on the
  game window. It serves downloaded game files through the custom protocol `itch-cave://`, registered with
  `gameSession.protocol.handle`, strips "Electron" from the user agent, sends popups to the system browser and handles
  F11 and Esc for fullscreen. Verified (2026-10-24, `gh api
  repos/itchio/itch/contents/src/main/reactors/launch/perform-html-launch.ts` and `.../itch-cave-protocol.ts`).
- itch does not load remote HTTPS URLs as games. Verified (2026-10-24, `gh api repos/itchio/itch` code reading of the
  launch reactors).
- Flashpoint's browser mode (`BrowserMode.ts`) uses one `BrowserWindow` on the default session with `plugins:true`
  (Flash) and proxies through Flashpoint's local game server. It has no per-game partitions and mostly launches
  external programs from a Node backend. Verified (2026-10-24, `gh api repos/FlashpointProject/launcher`).
- Pixens shares one session, `persist:pixens`, between launcher and game windows, enables `webviewTag` and hardcodes
  pixens.io URLs. Verified (2026-10-24, `gh api repos/arhitekt86/pixens-launcher`).
- web-runner uses one `BrowserWindow` on the default session, takes CLI flags (`--set-cookie`, `--execjs`,
  `--injectcss`) and relies on the removed `new-window` API. Verified (2026-10-24, `gh api
  repos/lutris/web-runner`).

### 2.3 External dependencies

- itch needs [butler](https://github.com/itchio/butler) (Go, MIT, checked commit 73d0b7f1 from 2026-10-19) through
  `@itchio/butlerd` (MIT), the itch.io API and download servers. butler uses `crawshaw.io/sqlite` (ISC). Verified
  (2026-10-24, `gh api repos/itchio/butler`).
- Flashpoint needs a Flashpoint data folder, 7zip and a Rust library reached through `@fparchive/flashpoint-archive`
  (MIT, Node binding). Verified (2026-10-24, `gh api repos/FlashpointProject/launcher`).
- Pixens depends on Supabase authentication and an `electron-updater` feed hosted at pixens.io. Verified (2026-10-24,
  `gh api repos/arhitekt86/pixens-launcher`).

### 2.4 Reuse verdict per base

| Base | Verdict | What is worth borrowing as an idea | What blocks reuse | Tag |
| --- | --- | --- | --- | --- |
| itch | Pattern only, no fork | One persistent session per game; `session.protocol.handle` on that session | `sandbox:false` and `webSecurity:false` contradict our game-window rules; Redux, butler and the itch.io API come along; the codebase is far larger than a URL launcher needs | Assumed (reasoning from 2.1 to 2.3 and the security rules in AGENTS.md) |
| Flashpoint | Pattern only | Idea of packages and extensions for the later local-packages stage | Electron 19, shared default session, launches external programs, bundles LGPL 7zip (our policy forbids LGPL in the product) | Assumed (reasoning from 2.1 to 2.3 and the dependency policy in AGENTS.md) |
| Pixens | Not reused | None | One shared session, hard-wired to one site and Supabase, 2 commits in total | Assumed (reasoning from 2.1 to 2.3) |
| web-runner | No code may be copied | None beyond "a launcher can be tiny" | GPL-3.0, Electron 4, removed API | Assumed (reasoning from 2.1 and the dependency policy in AGENTS.md) |

## 3. Other comparable projects

| Project | License | Relevant facts | Relevance | Tag |
| --- | --- | --- | --- | --- |
| [Ferdium](https://github.com/ferdium/ferdium-app) | Apache-2.0 | Electron 44.2, active; uses `persist:service-${id}` per service in `src/models/Service.ts` | Closest pattern to one session per library card | Verified (2026-10-24, `gh api repos/ferdium/ferdium-app`) |
| [Pake](https://github.com/tw93/Pake) | GPL-3.0 with an exception for generated apps | Tauri 2.10; one site becomes one app on the system webview | Not a launcher; a per-game bundle, which we reject | Verified (2026-10-24, `gh api repos/tw93/Pake`) |
| Nativefier | MIT | Archived and unmaintained | Same per-site bundle idea | Verified (2026-10-24, GitHub repository metadata via `gh api`) |
| Heroic Games Launcher | GPL-3.0 | Electron; launcher for GOG and Epic games | Not web games | Verified (2026-10-24, GitHub repository metadata via `gh api`) |
| Rambox CE | GPL-3.0 | Archived in 2022 | Multi-service wrapper, not a game library | Verified (2026-10-24, GitHub repository metadata via `gh api`) |
| Franz | Apache-2.0 | Multi-service wrapper | Same | Verified (2026-10-24, GitHub repository metadata via `gh api`) |

- The concept document names the itch app as the closest confirmed analog (library, install and launch of HTML5 games
  from its own catalog), plus Xsolla Launcher for publishers and Flashpoint for web-content archiving. It says that an
  exact analog of "arbitrary URL plus modern ports plus cloud saves" was not confirmed in an earlier search, and that
  this does not prove no competitor exists. Unverified (reported in
  [concept-v1.0.md](../product/sources/concept-v1.0.md) section 13, discussion of 2026-10-23, not re-checked).
- None of the four priority bases has save backup, export or import; this was inferred from a GitHub code search for
  "backup". Unverified (inference from a GitHub code search, 2026-10-24, not re-checked by reading the code).

## 4. Why an own client

Facts that matter:

- Only itch uses a per-game session plus a custom protocol, and it launches games from its own catalog, not from
  arbitrary HTTPS links. Verified (2026-10-24, `gh api repos/itchio/itch`).
- itch's game window disables the sandbox and web security, and the other bases share one or the default session.
  Our rules require `sandbox: true`, `webSecurity` on and one session per game ([AGENTS.md](../../AGENTS.md#hard-rules)).
  Verified (2026-10-24, `gh api repos/itchio/itch` and the three other repositories listed in 2.1).
- Three of the four bases run Electron versions outside the supported window; only itch (^44.5.1) is inside it.
  Verified (2026-10-24, `gh api` as in 2.1; <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>).

Assumptions:

- Removing itch's catalog, install, update and Redux logic costs more than writing the small launcher core we need.
  Assumed (size evidence in 2.1; no trial build, see "Reading this document").
- A small codebase is easier for one owner to keep secure and current than a fork. Assumed.
- Revisit triggers: the local-packages stage needs patching and downloads at scale (then study itch's butler and
  wharf, Go, MIT), or the Phase 1 client turns out to need most of itch's library infrastructure. Assumed (ADR-0003
  holds the Go decision).

## 5. Test-game candidates

Policy: GPL games are used only as external test URLs and are never vendored. Verified (2026-10-24,
[AGENTS.md](../../AGENTS.md#dependency-and-license-policy), repository rule). The controlled game `progress-lab` carries
the automated tests; public games are cross-checks. Assumed.

| Candidate | License | Storage used | Role | Tag |
| --- | --- | --- | --- | --- |
| `progress-lab` (own, built in Phase 0 task 4) | AGPL-3.0-or-later like the rest of the repository | localStorage JSON, IndexedDB with Date, ArrayBuffer, Uint8Array and Blob values, and an IDBFS-shaped database; exact shapes in the [fixture README](../../fixtures/test-games/progress-lab/README.md#storage-shapes) | Primary fixture in the repository | Verified (2026-10-25, [fixture README](../../fixtures/test-games/progress-lab/README.md), [LICENSING.md](../../LICENSING.md) for the license) |
| [2048](https://github.com/gabrielecirulli/2048) | MIT | localStorage keys `bestScore` and `gameState` | External URL cross-check; permissive, so it could be vendored, but `progress-lab` already covers localStorage | Verified (2026-10-24, `gh api repos/gabrielecirulli/2048`) |
| [A Dark Room](https://github.com/doublespeakgames/adarkroom) | MPL-2.0 | `localStorage.gameState` JSON, plus a built-in base64 export | External URL; its own export can be compared with ours | Verified (2026-10-24, `gh api repos/doublespeakgames/adarkroom`) |
| [OpenTTD web](https://github.com/OpenTTD/OpenTTD) (`os/emscripten/pre.js`) | GPL-2.0 | IDBFS at `/home/web_user/.openttd`, loaded at startup and saved on save or exit | External test URL only, never vendored; a real IDBFS case | Verified (2026-10-24, `gh api repos/OpenTTD/OpenTTD`) |
| doom-wasm | GPL-2.0 | No IDBFS save found | Weak candidate; external only if ever used | Unverified (research notes of 2026-10-24, not re-checked) |
| Sandspiel | MIT | Only localStorage (`js/components/ui.js`) | Weak candidate, adds nothing over `progress-lab` | Unverified (research notes of 2026-10-24, not re-checked) |
| [three.js](https://github.com/mrdoob/three.js) | MIT | None | Public demos as external URLs for GPU and frame-time checks | Verified (2026-10-24, `gh api repos/mrdoob/three.js`) |
| [Babylon.js](https://github.com/BabylonJS/Babylon.js) | Apache-2.0 | None | Same | Verified (2026-10-24, `gh api repos/BabylonJS/Babylon.js`) |
| [webgpu-samples](https://github.com/webgpu/webgpu-samples) | BSD-3-Clause | None | Same, for WebGPU | Verified (2026-10-24, `gh api repos/webgpu/webgpu-samples`) |
| Own small Emscripten program (later) | Emscripten is MIT and NCSA; our program would be AGPL | Real IDBFS with `syncfs` | Judged the most reliable IDBFS fixture because its behavior is controlled; not built in Phase 0 | Assumed (reasoning) |

- OpenTTD probably needs extra graphics assets (OpenGFX) before it is playable. Unverified (research notes of
  2026-10-24, not re-checked).
- No Unity WebGL test build is available, so Unity PlayerPrefs storage is untested. Assumed (nothing in the research
  found a licensed Unity build to use).

## 6. Licensing precedent (context for ADR-0006)

- bitwarden/server states in its `LICENSE.txt` that the default license across the repository is AGPL v3.0, that code
  under the separate Bitwarden License v1.0 lives only in the `/bitwarden_license` directory, and it grants no trademark
  rights (a separate trademark guidelines file exists). Verified (2026-10-24, `gh api
  repos/bitwarden/server/contents/LICENSE.txt`).
- wg-launcher copies the structure: `AGPL-3.0-or-later` as the default, a commercial license only by separate
  agreement, a CLA for outside contributors so the owner can relicense, one named directory for any future paid
  features under a source-available license (none exists), a trademark policy, and core features free for good. See
  [LICENSING.md](../../LICENSING.md). Verified (2026-10-24, [LICENSING.md](../../LICENSING.md)); that this structure fits
  the project is Assumed.
- The dependency policy (shipped dependencies permissive only) exists so that dual licensing stays possible: third-party
  copyleft code inside the product would limit what the owner may relicense. Assumed (reasoning, not legal advice).
- The CLA is adapted from the Harmony HA-CLA-I template, published under CC BY 3.0. Verified (2026-10-24,
  <https://www.harmonyagreements.org/>). The code of conduct is Contributor Covenant 3.0, licensed CC BY-SA 4.0.
  Verified (2026-10-24, <https://www.contributor-covenant.org/version/3/0/>).
- None of this is legal advice; a lawyer should review `CLA.md`, `LICENSING.md` and `TRADEMARKS.md` before outside
  contributions are accepted. Assumed.

## 7. Open questions

Unverified items that can be settled without the runtime spike:

| Question | State | How to settle |
| --- | --- | --- |
| Does any priority base offer save backup, export or import? | Unverified | Read the save and backup code paths of itch and Flashpoint; update section 3 |
| Does doom-wasm persist saves in IDBFS? Does Sandspiel use anything beyond localStorage? Does OpenTTD web need OpenGFX? | Unverified | Read the sources and try the public builds before picking an external IDBFS test URL |
