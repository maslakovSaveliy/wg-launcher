# WGLauncher

WGLauncher is an open-source desktop library and launcher for web games (JavaScript, WebAssembly, WebGL, WebGPU). You
paste an HTTPS link and get a library card. The game runs locally in its own window with its own persistent browser
session, and for compatible games the launcher can export a snapshot of the saves and restore it somewhere else.

It is not cloud streaming, not a reverse-engineering tool and not an automatic converter of games to native code.
The product name is **WGLauncher** (owner decision, 2026-10-25); `wg-launcher` stays the repository and package
codename, and `wglauncher://` the deep-link scheme.

## Status

**Phase 1, the launcher MVP, is done and merged to `main` (2026-11-02); there is no release.** You can build the app
from source and package an ad-hoc-signed macOS arm64 build locally; there is no installer, no signed or notarized build
and no auto-update. Phase 0 (specifications, decision records, rules, tooling and a runtime evaluation) and Phase 1
([its plan](docs/plans/2026-10-25-phase-1-launcher.md)) are done: add an HTTPS link, play the game in its own window,
export a snapshot of its saves and restore it in another entry with the same progress. The next phase has no plan yet.

| Exists | Does not exist yet |
| --- | --- |
| `apps/desktop`, the Electron 45 launcher: library cards (add by link, edit title and cover, remove), one sandboxed window per game on its own persistent session, window size, position and fullscreen remembered, playtime, deep links and desktop shortcuts | Installers, releases, code signing, notarization, auto-update |
| Snapshots: export of localStorage and IndexedDB to a versioned, hashed `.wgsnap` file while the game is closed, verify, restore into the same or another entry with a backup and rollback, storage-key mapping, delete local saves, clear cache | Cloud sync, accounts, a game catalog |
| Product requirements ([PRD](docs/product/prd.md)) with 25 acceptance criteria and their Phase 1 state | Any real game verified to work: only the controlled test game `progress-lab` and six public demos have recorded runs |
| Specifications for [architecture](docs/specs/architecture.md), the [snapshot format](docs/specs/snapshot-format.md), [save transfer](docs/specs/save-transfer.md) and [security](docs/specs/security.md); six [architecture decision records](docs/adr/) | Windows and Linux builds: the code has Windows paths (shortcuts, deep links) but neither platform is packaged or tested |
| `packages/shared`, `packages/snapshot` (the `.wgsnap` codec with golden vectors) and `packages/exporters` (the browser-side exporter and importer) | OPFS, cookies, service workers and caches in snapshots (version 1 exports localStorage and IndexedDB only) |
| Quality tooling: Biome, strict TypeScript, Vitest, Playwright suites for the desktop app, the exporters and the fixture, a license gate, a release check of the packaged app, Markdown lint, git hooks and CI | |
| A throwaway runtime spike whose results the decisions cite ([RESULTS.md](spikes/runtime-compat/RESULTS.md)), including the frame-time comparison of the launcher with Chrome (H7) | |

## Quick start for contributors

Prerequisites: Git, Node 24.22.1 (the version in `.nvmrc`; `nvm install` once, then `nvm use` selects it) and pnpm. The `packageManager` field in
`package.json` pins the pnpm version, and pnpm switches to it by itself inside the repository.

```sh
git clone https://github.com/maslakovSaveliy/wg-launcher.git
cd wg-launcher
nvm use
pnpm install     # also installs the git hooks (lefthook)
pnpm check       # lint, typecheck, unit tests, license gate, path and bundle checks, Markdown lint
```

| Command | What it does |
| --- | --- |
| `pnpm lint` | Biome lint, format check and import order for JS, TS, JSON and CSS (not Markdown) |
| `pnpm format` | Biome formatter, writing changes |
| `pnpm typecheck` | `tsc -b` with the strict base config, for every TypeScript project in the workspace |
| `pnpm test` | Vitest unit tests |
| `pnpm test:e2e` | The desktop app's Playwright `_electron` suite (opens real windows), then the exporters' browser tests, then the `progress-lab` fixture's suite (extra arguments such as `--project=chromium` reach the fixture only; it needs `pnpm --filter @wg-launcher/fixture-progress-lab exec playwright install chromium` once). Not part of `pnpm check` |
| `pnpm licenses:check` | Production dependencies must use allowed licenses; dev-only ones only warn |
| `pnpm docs:lint` | markdownlint-cli2 on all Markdown except verbatim upstream or source texts |
| `pnpm paths:check` | No machine-specific paths (home directories, temporary roots) in tracked text files |
| `pnpm bundle:check` | Builds the desktop app's prod and test flavors; the test hooks must not be in prod |
| `pnpm check` | Runs lint, typecheck, test, licenses:check, paths:check, bundle:check and docs:lint |
| `pnpm --filter @wg-launcher/desktop package:mac` | Packages an ad-hoc-signed macOS arm64 app into `apps/desktop/dist/` (not notarized) |
| `pnpm --filter @wg-launcher/desktop release:check` | Reads the packaged app back: fuses, `Info.plist`, app.asar |

The workflow, commit rules, Definition of Done and dependency policy are in [CONTRIBUTING.md](CONTRIBUTING.md). The rules
every contributor and AI agent follows are in [AGENTS.md](AGENTS.md).

## Architecture in short

The runtime is Electron 45.0.0 ([ADR-0002](docs/adr/0002-desktop-runtime.md)). The owner accepted it on 2026-10-25 on
one condition: Phase 1 must measure frame time on the launcher against Chrome (hypothesis H7). It did: H7 passed on
2026-11-02 on one Mac, with the limits recorded in [RESULTS.md](spikes/runtime-compat/RESULTS.md) ("Phase 1"). The full design is in
[docs/specs/architecture.md](docs/specs/architecture.md); the main points:

- **Main process** (trusted) owns windows, sessions, IPC, the SQLite library (`node:sqlite`, single writer) and the locks
  around save jobs.
- **Launcher UI** is a React renderer on a privileged `app://` scheme with a strict CSP and a typed, invoke-only preload
  bridge. It never shares a session with a game.
- **Each game** runs in its own window on its own persistent session, `persist:game:<gameId>`, with `sandbox: true`,
  context isolation, no Node.js, no preload and no IPC. Permissions and navigation are deny-by-default.
- **Saves** (localStorage and IndexedDB) are exported and restored with browser APIs while the game window is closed, in a
  hidden "quiescent" window on the game's own partition ([ADR-0005](docs/adr/0005-save-transfer-mechanism.md)). The
  `.wgsnap` snapshot format is versioned, hashed and treated as hostile input
  ([snapshot-format.md](docs/specs/snapshot-format.md)). Live Chromium profile files are never copied.
- **Rust** is deferred to a later local-packages stage ([ADR-0003](docs/adr/0003-native-languages.md)); the first snapshot
  codec is TypeScript.

## Which platforms are verified

"Verified" means a real recorded run with a date, a version and a machine, listed in
[docs/compat/matrix.md](docs/compat/matrix.md). A CI runner proves install and tests only, never game compatibility.

| Platform | Status |
| --- | --- |
| macOS arm64 | Tested on one machine (MacBook Air, Apple M3, macOS 27.0.1): the runtime spike (2026-10-24), the launcher's e2e suite on the controlled test game, the manual checks of the packaged app (2026-10-30) and the frame-time comparison with Chrome 156 (H7 PASS, 2026-11-02). No real game is verified. Verified ([matrix.md](docs/compat/matrix.md), [manual checks](docs/compat/manual-checks/2026-10-30-macos-arm64.md), [RESULTS.md](spikes/runtime-compat/RESULTS.md)) |
| Windows | Not tested. CI on `windows-latest` runs install and unit tests, packages an unpacked x64 build with its release check, and runs the desktop e2e suite as a non-blocking job; no real Windows machine has run the app. Verified (2026-11-03, [ci.yml](.github/workflows/ci.yml)) |
| Linux | Not tested. CI on Ubuntu runs lint, typecheck, license and docs checks, the fixture's and the exporters' Chromium tests, the desktop e2e suite under Xvfb and an unpacked x64 build with its release check, which proves the build and tests, not compatibility. Verified (2026-11-03, [ci.yml](.github/workflows/ci.yml)) |
| iOS, Android | Not tested and out of scope for version 1. An iOS client would need WebKit and a separate design. Assumed |

## Limitations

- There is no release: the app is built from source, and the local macOS package is signed ad hoc only. The interface is
  functional, not designed.
- Export and restore have run in a packaged build only in the test flavor (with the release fuses but the Node inspector
  on, on the controlled test game); the production build has not yet taken a snapshot of a real https game.
- All runtime evidence comes from one fanless MacBook Air. It says nothing about other Macs, Windows, Linux or other GPUs.
- The only speed and memory numbers are the spike's measurements on that machine (RESULTS.md, "Phase 1"), each with its
  method and limits; no speed-up is claimed.
- Whether heavy fan-made web ports of major commercial games are complete, whether a free market for them exists, and
  whether every web game will work are all unproven. The product does not claim any of them.
- A game added by link needs its site to be online. A browser cache is not an installation.
- Version 1 exports localStorage and IndexedDB only. OPFS, cookies, service workers and caches are not exported, and a
  game that keeps progress only on its own server or in process memory is out of reach.
- Closing a window does not prove a game flushed its storage. Snapshots without a confirmed flush are labeled "flush
  unconfirmed" and are never presented as a guaranteed save point.
- Downloads from games are denied in the MVP, and games get no camera, microphone, location, notifications or screen
  capture.
- The save-transfer mechanism depends on Electron and the Chrome DevTools Protocol. A WebKit-based client (Tauri on macOS,
  iOS) would need another one. Assumed (reasoning, not tested).
- Out of scope for version 1: store, payments, chat, friends, achievements, a mobile client, reverse engineering of games
  and a universal site downloader.

## License

`AGPL-3.0-or-later`; the full text is in [LICENSE](LICENSE). In short:

- Commercial use on other terms is possible only by a separate written agreement with the copyright holder. There is no
  standard offer yet.
- Outside contributors will sign a Contributor License Agreement ([CLA.md](CLA.md)) so the project can keep that option.
  The CLA is a draft that a lawyer has not reviewed, and the signing app is not set up, so outside code contributions are
  not accepted yet.
- There are no paid features. If any appear, they will live only in one separate source-available directory, and the
  details will be decided in a future ADR.
- The core stays free and AGPL-licensed: the game library, launching games, local saves and snapshots (export and
  restore), and progress tracking.
- The AGPL grants no right to the project name or logo: [TRADEMARKS.md](TRADEMARKS.md).

[LICENSING.md](LICENSING.md) has the plain-language summary. It is not legal advice.

## Where to read more

- [docs/README.md](docs/README.md): index of all documentation.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute. [AGENTS.md](AGENTS.md): the rules.
  [MEMORY.md](MEMORY.md): verified facts, decisions and gotchas.
- [SECURITY.md](SECURITY.md): how to report a vulnerability, privately.
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): community rules.
