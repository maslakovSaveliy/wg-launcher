# WGLauncher

WGLauncher is an open-source desktop library and launcher for web games (JavaScript, WebAssembly, WebGL, WebGPU). You
paste an HTTPS link and get a library card. The game runs locally in its own window with its own persistent browser
session, and for compatible games the launcher can export a snapshot of the saves and restore it somewhere else.

It is not cloud streaming, not a reverse-engineering tool and not an automatic converter of games to native code.
The product name is **WGLauncher** (owner decision, 2026-10-25); `wg-launcher` stays the repository and package
codename, and `wglauncher://` the deep-link scheme.

## Status

**Phase 1 is in progress; nothing here can be installed or played yet.** Phase 0 (specifications, decision records,
rules, tooling and a runtime evaluation) is done. Phase 1 builds the first vertical scenario (add a URL, play, change
progress, export a snapshot, restore it in a clean session and see the same progress), following
[its plan](docs/plans/2026-10-25-phase-1-launcher.md). It is code and tests only, with no new spikes.

| Exists | Does not exist yet |
| --- | --- |
| Product requirements ([PRD](docs/product/prd.md)) with 25 acceptance criteria | A usable launcher: `apps/desktop` starts and shows its window, but has no library yet |
| Specifications for [architecture](docs/specs/architecture.md), the [snapshot format](docs/specs/snapshot-format.md), [save transfer](docs/specs/save-transfer.md) and [security](docs/specs/security.md) | Library UI, game windows, export and restore as software |
| Six [architecture decision records](docs/adr/), including the runtime choice (Electron 45) | Installers, releases, code signing |
| Quality tooling: Biome, strict TypeScript, Vitest, a dependency license gate, Markdown lint, git hooks and CI | Cloud sync, accounts, a game catalog |
| `progress-lab`, a controlled test game with verifiable saves, and its Playwright suite | Any game verified to work: the compatibility matrix lists only spike runs |
| A throwaway runtime spike whose results the decisions cite ([RESULTS.md](spikes/runtime-compat/RESULTS.md)) | Frame-time comparison with Chrome: deferred to Phase 1 |
| `packages/shared` (ids, error codes) and `packages/snapshot` (the `.wgsnap` codec with golden vectors) | |
| `apps/desktop`: the Electron app skeleton (strict `app://launcher` protocol and CSP, launcher window, redacted log) and its Playwright e2e suite | |

## Quick start for contributors

Prerequisites: Git, Node 24 (the version in `.nvmrc`; `nvm use` selects it) and pnpm. The `packageManager` field in
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
| `pnpm test:e2e` | The desktop app's Playwright `_electron` suite (opens real windows), then the `progress-lab` fixture's suite (extra arguments such as `--project=chromium` reach the fixture only; it needs `pnpm --filter @wg-launcher/fixture-progress-lab exec playwright install chromium` once). Not part of `pnpm check` |
| `pnpm licenses:check` | Production dependencies must use allowed licenses; dev-only ones only warn |
| `pnpm docs:lint` | markdownlint-cli2 on all Markdown except verbatim upstream or source texts |
| `pnpm paths:check` | No machine-specific paths (home directories, temporary roots) in tracked text files |
| `pnpm bundle:check` | Builds the desktop app's prod and test flavors; the test hooks must not be in prod |
| `pnpm check` | Runs lint, typecheck, test, licenses:check, paths:check, bundle:check and docs:lint |

The workflow, commit rules, Definition of Done and dependency policy are in [CONTRIBUTING.md](CONTRIBUTING.md). The rules
every contributor and AI agent follows are in [AGENTS.md](AGENTS.md).

## Architecture in short

The runtime is Electron 45.0.0 ([ADR-0002](docs/adr/0002-desktop-runtime.md)). The owner accepted it on 2026-10-25 on
one condition: Phase 1 must measure frame time on the launcher against Chrome (hypothesis H7), because that measurement
was deferred out of Phase 0. A failure there reopens ADR-0002 and ADR-0005. The full design is in
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
| macOS arm64 | Tested in the runtime spike on one machine (MacBook Air, Apple M3, macOS 27.0.1). Electron 45.0.0 passed the isolation, persistence, cross-origin isolation, WebGPU, WebGL2 and save-transfer checks on the controlled test game; frame time is not measured. No real game is verified, because the launcher does not exist. Verified (2026-10-24, [RESULTS.md](spikes/runtime-compat/RESULTS.md)) |
| Windows | Not tested. CI runs install and unit tests on `windows-latest`; the fixture's browser tests do not run there. Verified (2026-10-25, [ci.yml](.github/workflows/ci.yml)) |
| Linux | Not tested. CI on Ubuntu runs lint, typecheck, license and docs checks and the fixture's Chromium tests. Verified (2026-10-25, [ci.yml](.github/workflows/ci.yml)) |
| iOS, Android | Not tested and out of scope for version 1. An iOS client would need WebKit and a separate design. Assumed |

## Limitations

- There is no usable client yet. `apps/desktop` starts and shows an empty launcher window; the library, game windows,
  export and restore are specified and planned, not yet software.
- All runtime evidence comes from one fanless MacBook Air. It says nothing about other Macs, Windows, Linux or other GPUs.
- Electron's frame time against Chrome is unmeasured. No speed or memory number is claimed anywhere.
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
