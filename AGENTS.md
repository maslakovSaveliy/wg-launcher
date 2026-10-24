# AGENTS.md

Canonical rules for every AI agent and human working in this repository. Cursor reads this file natively; `CLAUDE.md`
imports it. Read [MEMORY.md](MEMORY.md) too: it holds verified facts, decisions and gotchas.

## Purpose

wg-launcher is an open-source desktop library and launcher for web games (JavaScript, WebAssembly, WebGL, WebGPU). The
user pastes an HTTPS link, gets a library card, and the game runs locally in its own window with its own persistent
browser session. For compatible games the launcher can export a snapshot of the saves and restore it elsewhere.
Licensed `AGPL-3.0-or-later`; see [LICENSING.md](LICENSING.md).

It is not cloud streaming, not a reverse-engineering tool and not an automatic converter of games to native code.

## Status

**Phase 0 (foundation): specifications, documentation, rules, tooling and a runtime evaluation. There is no launcher
client code yet, and none may be written in this phase.** The plan is
[docs/plans/2026-10-24-phase-0-foundation.md](docs/plans/2026-10-24-phase-0-foundation.md). Phase 1 (the first
vertical scenario: add URL, play, save progress, export, restore in a clean session) gets its own plan. It is code and
tests only, with no spikes and one review per task (owner decision, 2026-10-25).

Stack: Electron 45 ([ADR-0002](docs/adr/0002-desktop-runtime.md), accepted by the owner on the condition that Phase 1
re-measures H7 frame time on the launcher against Chrome), React with TypeScript, electron-vite and `node:sqlite`
([ADR-0004](docs/adr/0004-toolchain-and-repo-layout.md)). Rust is deferred
([ADR-0003](docs/adr/0003-native-languages.md)). None of it is installed in the pnpm workspace yet.

## Repository map

Exists now:

| Path | Content |
| --- | --- |
| `LICENSE`, `LICENSING.md`, `CLA.md`, `TRADEMARKS.md` | Licensing model, contributor agreement, trademark policy |
| `SECURITY.md`, `CODE_OF_CONDUCT.md` | Vulnerability reporting, community rules |
| `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.cursor/rules/` | Agent rules and shared memory |
| `.github/` | Pull request template, issue forms, CI workflow (`workflows/ci.yml`) |
| `README.md`, `CONTRIBUTING.md` | Project overview and contributor guide |
| `docs/README.md` | Index of all documentation |
| `docs/product/` | PRD (`prd.md`); `sources/` holds the owner's concept document (English translation) |
| `docs/specs/` | Technical specifications: architecture, snapshot format, save transfer, security |
| `docs/adr/` | Architecture decision records `0001` to `0006`, and the template `0000` |
| `docs/research/` | Evidence behind decisions: open-source bases, test games, runtime and save extraction |
| `docs/compat/` | Compatibility matrix (generated from the spike results) and measurement methodology; real runs only |
| `docs/plans/` | Implementation plans |
| `spikes/runtime-compat/` | THROWAWAY runtime experiment, not product code, kept in place as the evidence the ADRs and specs link to: frozen `HYPOTHESES.md`, shared probe pages, spike server and runners, the Electron spike (`electron/`, own npm lockfile), the Chrome, Chrome `--app`, Safari-proxy and demo runners (and a timing runner that was never run: deferred to Phase 1), committed `results/` and `RESULTS.md`; see its `README.md` |
| `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.npmrc`, `.editorconfig` | Repo and toolchain basics |
| `biome.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts` | Lint and format, TypeScript, unit tests |
| `lefthook.yml`, `commitlint.config.mjs`, `.secretlintrc.json`, `.markdownlint-cli2.jsonc` | Git hooks and their checks |
| `scripts/` | Repo tooling; `check-licenses.mjs` enforces the dependency license policy, and `prod-deps-guard.mjs` is the build-time guard (a Vite/Rollup plugin) that fails a build bundling a package outside `dependencies` (both with tests; the guard is wired into the desktop build when it exists) |
| `packages/shared/` | `@wg-launcher/shared`, consumed as TypeScript source: UUIDv7 ids, the `Result` type and every result error code named in the specs (no dependencies yet) |
| `fixtures/test-games/progress-lab/` | Controlled test game with verifiable persisted progress and its Playwright suite; see its `README.md`. Not a real game |

Reserved, **not created yet**. Do not create a directory until the work that needs it exists:

- `apps/desktop` (Electron client), `packages/snapshot`, `packages/exporters`.
- `crates/` (Rust, only if and when the local-packages stage needs it).

## Commands

`nvm use` (reads `.nvmrc`, Node 24) then `pnpm install`. The `packageManager` field pins pnpm; pnpm switches to that
version by itself inside the repo. `pnpm install` also installs the git hooks (the `prepare` script).

| Command | What it does |
| --- | --- |
| `pnpm lint` | Biome lint, format check and import order for JS, TS, JSON and CSS (not Markdown) |
| `pnpm format` | Biome formatter, writing changes |
| `pnpm typecheck` | `tsc -b` with the strict base config, for the root project and the fixture's TypeScript (config and tests) |
| `pnpm test` | Vitest unit tests (fast; also run by the pre-push hook) |
| `pnpm test:e2e` | Playwright suite of the `progress-lab` fixture in bundled Chromium and, locally, installed Chrome (`--project=chromium` for Chromium only, as CI does). Needs `pnpm --filter @wg-launcher/fixture-progress-lab exec playwright install chromium` once. Not part of `pnpm test` or `pnpm check` |
| `pnpm licenses:check` | Production dependencies must use allowed licenses; dev-only ones only warn |
| `pnpm docs:lint` | markdownlint-cli2 on all Markdown except verbatim upstream or source texts |
| `pnpm check` | Runs lint, typecheck, test, licenses:check and docs:lint (not `test:e2e`) |

Always invoke tools through `pnpm` or `pnpm exec`, never a globally installed copy.

Git hooks (lefthook) run for you: pre-commit formats staged files with Biome (and re-stages them), scans them with
secretlint and lints staged Markdown; commit-msg enforces Conventional Commits; pre-push runs `pnpm typecheck` and
`pnpm test`. CI (`.github/workflows/ci.yml`) repeats the checks on every pull request and also runs the fixture's
Playwright suite (`pnpm test:e2e --project=chromium`) on Ubuntu and macOS.

## Hard rules

### Security invariants for game sessions

A game is untrusted third-party content. It must never get Node.js, arbitrary filesystem access or administrative IPC.

1. Game windows: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, **no preload script and no IPC**.
   Never disable `webSecurity`. No `<webview>`, no experimental Blink features.
2. One persistent session per game, `persist:game:<gameId>`. The `gameId` is a UUIDv7 that does not depend on the URL.
   The launcher UI never shares a session with a game.
3. Install permission request and check handlers on every game session. Electron grants every permission by default, so
   deny by default (and log the denial); allow only `fullscreen`, `pointerLock` and `keyboardLock`.
4. Limit navigation: `will-navigate` allows the same site only, decided with a URL parser (never a string prefix).
   `setWindowOpenHandler` denies by default; an opener may be sent to the system browser after confirmation, http and
   https only. Downloads are denied in the MVP.
5. Never pass an untrusted URL to `shell.openExternal` unless it is a validated http or https URL. Never open other
   schemes.
6. Launcher UI: privileged `app://` scheme, strict CSP, typed preload bridge, invoke-only IPC. Every handler checks the
   sender frame and validates arguments with zod.
7. Prefer declarative adapters to loading arbitrary code. Never execute code taken from a game, snapshot or deep link in
   the main process.
8. Never put secrets in the renderer, in logs or in snapshots.
9. Do not start every game ahead of time. Do not block the main thread; limit background work while a game runs.

Details live in [docs/specs/security.md](docs/specs/security.md).

### Data-safety invariants

1. Never copy or read the files of a live Chromium profile (LevelDB, IndexedDB files). Read saves through browser APIs
   while the game window is closed.
2. Never export or sync a whole profile, cookies, tokens or credentials. A snapshot holds only declared game data.
   Keep game data and asset cache apart.
3. Back up the current state before every import. Any failure restores that backup and verifies it. A failure must never
   destroy existing saves.
4. Closing a window does not prove a game has flushed its storage (for example Emscripten IDBFS). Record a snapshot's
   flush as confirmed only when a known flush hook reported completion; otherwise label it "flush unconfirmed" in the
   manifest and the UI, and never present it as a guaranteed save point.
5. Snapshots are versioned and carry a content hash. Reject unknown versions explicitly. A value type that cannot be
   exported is an explicit error, never silently dropped.
6. Treat archives as hostile: reject absolute paths, `..`, symlinks, hardlinks and device entries, too many entries,
   oversize content and bad compression ratios, and verify hashes before restoring anything.
7. Cloud sync comes only after local export and import are proven. Conflicts are resolved by revisions, not only device
   clocks. If two machines changed the same snapshot, keep both branches and never discard one silently.
8. Deleting is explicit and distinct: remove from library (keeps snapshots), clear cache, delete local saves (backup
   first).
9. One layer owns writes to the local database (the main process). Do not push large archives through JSON IPC.

### Honesty rules

1. Show only real state. No fake install, sync, FPS or download indicators or progress bars. Library badges ("By link",
   "Needs internet", "Local data", "Export verified", "Compatibility not verified") come from recorded state only.
2. Do not present completion percentage or achievements as automatically available. Playtime follows the documented
   rule only.
3. A game, runtime or OS is "verified" only after a real recorded run on that OS (date, version, machine) in
   `docs/compat/`. An unsupported or untested OS is never "verified". The dev machine is macOS on arm64; a CI runner
   proves install and unit tests only, not game compatibility.
4. The completeness of heavy fan-made web ports of major commercial games, the existence of a free market for them, and
   universal compatibility are all **unproven**. Do not state them as fact.
5. No speed-up numbers without measurement. Measure cold and warm start separately, compare with Chrome on the same
   machine and scene.
6. Out of scope for version 1: store, payments, chat, friends, achievements, mobile client, own reverse engineering,
   a universal site downloader. No account is needed for the local library. Offline play exists only for prepared
   compatible packages.

### Documentation rules

- Every factual claim in docs carries a tag: `Verified (YYYY-MM-DD, source)` with a URL, command or commit as the
  source, `Assumed` (reasoned, not checked) or `Unverified` (reported, not checked). In `MEMORY.md` the short forms
  `[V]`, `[A]` and `[U]` are allowed, with a date and a source.
- Keep facts and assumptions visibly separate.
- Everything is in English: docs, rules, code, comments, commits, issues. There are no exceptions.
- This repository is public. Never commit secrets, tokens, personal data, local usernames, absolute home paths or other
  machine-specific paths. Private owner notes and local tool state are never committed or quoted.

### No fake or empty artifacts (YAGNI)

No empty packages or crates, placeholder files, rules for folders that do not exist, abstractions for hypothetical
options, tests that merely restate the implementation, or UI that does not reflect real state. Prefer a few meaningful
tests of security and data-safety boundaries (malformed snapshot, import refused without losing the original, illegal
paths, game isolation).

### Dependency and license policy

- Dependencies shipped in the product must be permissive: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD,
  BlueOak-1.0.0, or MPL-2.0 (file-level, unmodified). No GPL, AGPL or LGPL third-party code among the resolved npm and
  crate dependencies; `pnpm licenses:check` enforces this for npm.
- The Electron and Chromium runtime brings its own bundled components and notices (for example FFmpeg, which Chromium
  bundles under the LGPL; Assumed, not checked here). They are not covered by the gate above and are handled when the
  app is packaged (third-party notices).
- Dev-only dependencies are reported, not blocking. The gate trusts the split in `package.json`, so everything bundled
  into or packaged with the app MUST be declared in `dependencies` (prod); `devDependencies` hold build and test
  tooling only. The Phase 1 desktop package config must follow this (electron-vite externalization and bundling
  settings checked accordingly); see [ADR-0004](docs/adr/0004-toolchain-and-repo-layout.md#dependency-declaration).
- GPL games are used only as external test URLs and are never vendored. Never copy code from GPL projects; other open
  projects are a source of ideas only.
- Before adding a dependency check its license, maintenance, size and whether it is needed at all. Install exact
  versions. Allow dependency build scripts only deliberately (`allowBuilds` in `pnpm-workspace.yaml`).
- Check the current version and API in the official docs (or via context7) before using a library.

### Autonomy and external actions

- Decide routine, reversible matters yourself and record the decision. If a decision that belongs to the owner is
  missing, ask one concrete question and continue with independent work.
- Never push, publish, or change external accounts/settings unless the owner approved it (an approved plan counts).
  Never send messages on the owner's behalf. Never force-push or commit directly to `main`.

## Workflow

1. Non-trivial work starts with a short design and a written plan in `docs/plans/`. Where code exists, follow
   test-driven development: write a failing test, watch it fail for the right reason, write the minimal code, watch it
   pass.
2. Make small, logical commits using Conventional Commits: `type(scope): subject`, with types `feat`, `fix`, `docs`,
   `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `spike`. Commits made with AI help end with a blank line and a
   `Co-Authored-By:` trailer naming the model.
3. Verify before you claim. Run the command, read the real output, and only then say it works. Paste the output in the
   pull request.
4. When something fails, debug systematically: reproduce, find the root cause, test one hypothesis at a time. No
   guess-and-retry loops.
5. Spikes are throwaway: they live in `spikes/`, are labeled THROWAWAY, keep their own lockfiles and stay outside the
   pnpm workspace. Biome, the TypeScript project and Vitest ignore `spikes/`; only Markdown linting covers its documents.
   Phase 1 starts no new spikes.

## Definition of Done

A change is done only when all of these hold:

- Verification was run and its real output is recorded (tests, `pnpm check`, manual steps for UI).
- Behavior changes have tests that were written first.
- Docs are updated, claims are tagged, and `MEMORY.md` reflects new verified facts, decisions and gotchas.
- No secrets, personal data or machine paths are in the diff.
- Security and data-safety invariants above are respected.
- No fake or empty artifacts were added; dependencies follow the policy.
- Commit messages are conventional.

## Where documentation lives

The full index is [docs/README.md](docs/README.md).

| Folder | Content |
| --- | --- |
| `docs/product/` | PRD and product sources (`sources/` holds the original concept) |
| `docs/specs/` | Technical specifications: architecture, snapshot format, save transfer, security |
| `docs/adr/` | Architecture decision records, numbered `NNNN-title.md` |
| `docs/research/` | Evidence behind decisions, with sources and dates |
| `docs/compat/` | Compatibility matrix and measurement methodology (real runs only) |
| `docs/plans/` | Dated implementation plans |

## Keeping MEMORY.md current

`MEMORY.md` is the shared memory of the project. When you learn a verified fact, make a decision or hit a gotcha, append
a short dated entry with its source. When an entry turns out to be stale or wrong, fix or remove it in the same change.
Keep it concise; long reasoning belongs in an ADR or a research document. Never store secrets, personal data or
machine paths there.
