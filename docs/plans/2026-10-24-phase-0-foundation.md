# Phase 0 — Foundation Implementation Plan (specs, docs, dev environment, stack decision)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (owner-chosen). Steps use `- [ ]`.
> Task 1 copies this plan into the repo as `docs/plans/2026-10-24-phase-0-foundation.md`.

**Goal:** Turn an empty folder into a repo with product/technical specs, agent rules, a working quality toolchain
(hooks, Biome, tests, license check, CI file), a controlled test game, and an evidence-based runtime decision —
**no launcher client code** (owner's explicit requirement).

**Architecture (decided here, built in Phase 1):** Own small Electron client (no fork). Main process owns windows,
per-game `persist:game:<id>` sessions, SQLite (`node:sqlite`) and IPC; React UI in a sandboxed renderer; untrusted games
in separate sandboxed windows without preload; save export/restore via isolated-world script in a "quiescent" window;
snapshot codec in TS inside `utilityProcess`. Rust deferred to the local-packages stage.

**Tech stack (re-check with `npm view` at execution):** pnpm (pin 11.7.0 unless 12.15 passes a quick check) · Node 24
(`.nvmrc`) · TypeScript 7.0 behind a gate (fallback 6.0.3) · Electron 45 · electron-vite 6 · Vite 8 · React 19.3 · zod 4 ·
Vitest 5 · Playwright 1.64 · Biome 2.6 · lefthook 2 (devDependency) · commitlint 21 · secretlint 13 · markdownlint-cli2.

**Spec:** concept `docs/product/sources/concept-v1.0.ru.md` (verbatim) + owner brief (not committed — public repo; distilled into PRD/AGENTS), decisions below.

## Context
The repository root has only `browser_games_concept.md` (concept v1.0, RU), an empty
`lancedb/` (likely created by the local-rag MCP server → gitignored, not deleted) and an empty GSD auto-checkpoint
`.planning/HANDOFF.json` (nothing to resume; left untouched, gitignored). Not a git repo. Phase 1 (vertical scenario: add URL →
card → game window → progress → close/reopen → export → restore in clean session → same progress; edit title/cover,
delete, fullscreen, window memory, shortcut, playtime, honest badges) gets its own plan via `superpowers:writing-plans` after this.

## Owner decisions (2026-10-24)
- **Rust deferred** to "local packages" (multi-GB download/verify/unpack). MVP snapshot codec in TS; language-neutral spec +
  golden vectors so a later Rust impl passes the same vectors. No empty crate.
- **Throwaway compatibility spike** Electron vs Tauri 2 vs Chrome on this Mac before ADR-0002 is accepted.
- **English everywhere** (docs, rules, code, commits). Chat with owner in Russian.
- Execution: subagent-driven-development; TDD where there is code.
- **Go not adopted** in MVP: same niche as Rust (sidecar), a 2nd native language isn't justified; Rust wins on napi-rs /
  Tauri / mobile reuse. Revisit triggers (ADR-0003): reuse itch **butler/wharf** (Go, MIT) for delta patching at the
  packages stage; measured backend perf need (backend starts as NestJS).
- **Public GitHub repo `maslakovSaveliy/wg-launcher`**, fully open source, created in Task 1 (gh account `maslakovSaveliy`,
  scopes repo+workflow verified).
- **License model (Bitwarden-style, verified in bitwarden/server LICENSE.txt):** default **AGPL-3.0-or-later** for the whole
  repo; closed/proprietary use by separate agreement (dual licensing) → external contributors sign a **CLA** (owner keeps
  relicensing rights); future paid features only in a dedicated directory under a source-available license (not created
  now — no empty dirs); **trademark policy** protects name/logo; core (library, launch, saves, progress) stays free forever
  (stated in LICENSING.md). Not legal advice — owner should have a lawyer review CLA/LICENSING before accepting outside PRs.

## My calls (owner can override)
- Own client, not fork. `package.json`: `"private": true` (no npm publish), `"license": "AGPL-3.0-or-later"`.
- Dependency policy (keeps dual licensing possible): shipped/prod deps permissive only — MIT, ISC, BSD-2/3-Clause,
  Apache-2.0, 0BSD, BlueOak-1.0.0, MPL-2.0 (file-level, unmodified); no GPL/AGPL/LGPL third-party code in the product;
  dev-only deps reported, not blocking. GPL games only as external test URLs, never vendored.
- Repo is public → the concept doc goes in as `docs/product/sources/concept-v1.0.ru.md` (verbatim RU, only non-English
  file, markdownlint-exempt); the owner's AI brief is **not** committed (its requirements are distilled into PRD/AGENTS).
- Codename `wg-launcher`, deep-link scheme `wglauncher`; display name TBD.
- `git init -b main`; first commit (LICENSE, LICENSING, README stub, .gitignore) pushed to the new public repo; work then
  continues on branch `phase-0-foundation` (one commit per task, pushed); draft PR opened after Task 2 so GitHub CI runs
  (status read via ccd_pr tools, no polling); merge to `main` only on owner OK.
- Enable on the new repo (free for public repos): Dependabot alerts, secret scanning + push protection, private
  vulnerability reporting. Branch protection on `main` — suggested only, not set.
- Electron 45.x (fallback 44.9.x if spike finds a blocker). `node:sqlite` instead of better-sqlite3 (spike verifies).
- Packaging tool chosen in ADR-0004 after the spike packages once (leaning electron-builder: pairs with electron-vite).

## Evidence (verified 2026-10-24) — full source list in Appendix A
- **OSS bases** (`gh api`): itchio/itch MIT @f5a18100 (Electron ^44.5.1; per-game `persist:gamesession_${id}`, custom
  `itch-cave://` via `session.protocol.handle`; but `sandbox:false`/`webSecurity:false`; fork drags Redux + butler (Go, MIT) +
  itch.io API). Flashpoint launcher MIT own code + LGPL 7zip @e5f45fc1 (Electron 19, no per-game partitions). pixens-launcher
  MIT @8a52abbb (Electron 33, one shared session, Supabase). lutris/web-runner GPL-3.0 @15bb58c2 (Electron 4). Ferdium
  Apache-2.0 uses `persist:service-${id}`. None has save export/import (code search; inferred).
- **Runtime:** Electron 45.0.0 (2026-10-21; Chromium 156, Node 24.22; supported 43–45). BrowserView deprecated →
  WebContentsView. Electron grants all permissions by default. `webContents.debugger`, `executeJavaScriptInIsolatedWorld`,
  `utilityProcess`, fuses exist. Electron 41 macOS COOP/COEP regression (fix merged 2026-04-30) → re-verify. WebGPU in
  Electron: unverified. Tauri 2.12.5: WKWebView (WebGPU macOS 26+), `data_store_identifier` macOS 14+ only, no CDP, engine
  differs per OS. Tauri 3 + CEF alpha.5 (2026-10-14) → not a candidate. iOS: WebKit mandatory (alt engines EU/Japan only) →
  desktop Chromium code never reaches iOS; Android WebView is Chromium.
- **Saves:** CDP IndexedDB = read/delete only; isolated world uses the origin's real storage with structured clone.
  Emscripten IDBFS: store `FILE_DATA`, v21, key = abs path, `{timestamp: Date, mode, contents: Uint8Array}`; in-memory FS is
  truth while running. Third-party iframe storage partitioned by top-level site. Node 24 zlib has zstd (host-checked).
- **Test games:** 2048 (MIT, localStorage), A Dark Room (MPL-2.0, localStorage), OpenTTD web (GPL-2.0, IDBFS, external only),
  three.js / Babylon / webgpu-samples (MIT / Apache-2.0 / BSD-3) for GPU.
- **Machine:** macOS 27.0.1 arm64 M3 (Metal 4); Node 24.13 via nvm; pnpm 11.7; Rust 1.98.1; a global biome in the pnpm home dir
  and Homebrew lefthook 2.1.15 (hooks must use `pnpm exec`); Chrome + Xcode. Windows/Linux: **not available → unverified**.

## Design decisions the specs must encode
- GameId = UUIDv7, independent of URL; partition `persist:game:<gameId>`; one window per game (2nd launch focuses it).
- Game window: no preload; sandbox + contextIsolation; no nodeIntegration; webSecurity on; permission request/check
  handlers on every game session — allow `fullscreen`, `pointerLock`, `keyboardLock`; deny the rest (logged);
  `will-navigate` same-site only (URL parser, not prefix match); `setWindowOpenHandler` deny → confirm → system browser
  (http/https only); downloads denied in MVP.
- Launcher UI via privileged `app://` scheme, strict CSP, typed preload bridge, invoke-only IPC, zod validation, sender-frame
  check; game windows have no IPC.
- Export/restore = isolated-world script in a hidden **quiescent window** of the same partition; `ses.protocol.handle`
  serves an empty doc at the game origin (no game code runs; service workers bypassed); cross-site iframe games recreate the
  top-level/iframe pair. Export/restore require the game window closed (per-game lock). Restore before game start. CDP only
  for storage key / wipe / read-only cross-check. Data = localStorage + IndexedDB (incl. DB version, keyPath, autoIncrement,
  indexes); excluded = cookies, HTTP cache, Cache Storage, service workers, shader cache. Unsupported values → explicit error.
- Snapshot `.wgsnap`: tar + zstd, `manifest.json` (format, formatVersion=1, gameId, revisionId, parentRevisionId, createdAt,
  deviceId, exporter{id,version}, adapter{id,version}|null, gameVersion|null, storageKeys[], entries[{path,size,sha256}],
  contentHash) + records + `blobs/<sha256>`. Record encoding decided in the spec: deterministic CBOR (RFC 8949 §4.2) vs
  tagged JSONL — must handle Date, Blob, typed arrays, binary keys, -0, NaN; spec defines exactly what contentHash covers.
  Limits: no abs paths/`..`/links/devices, max entries, max bytes, max ratio. Golden vector manifest format frozen now.
- Restore protocol: validate → lock → pre-import backup → wipe storage keys → import → re-export & compare contentHash →
  commit; any failure → wipe + restore backup + verify. Backups never auto-deleted silently.
- SQLite `node:sqlite` in main (single writer), WAL, raw SQL + `PRAGMA user_version` migrations.
- Playtime: accrues while game window is visible AND focused; stops on blur/minimize/suspend/lock; sessions < 10 s dropped.
- Badges from real state only: "By link", "Needs internet", "Local data" (usage > 0), "Export verified" (roundtrip passed),
  "Compatibility not verified" (default). No fake install/sync/FPS/download indicators.
- Distinct actions: remove from library (keeps snapshots) · clear cache (cache/shader/SW) · delete local saves (backup first).
- Shortcuts: Windows `.lnk` via `shell.writeShortcutLink` (`--launch-game=<id>`); macOS `wglauncher://launch/<id>` (Info.plist)
  + `.webloc`/`.command` options; single-instance lock + `second-instance`.

## Skills per task (owner-requested)
subagent-driven-development (all) · test-driven-development (2, 4) · playwright-best-practices (4, 5, 6) ·
electron-development + security-best-practices (5, 8) · rust-best-practices (6 Tauri, 7 ADR-0003) · engineering:architecture /
system-design (7, 8) · context7 for every library config · systematic-debugging on any failure · caveman only in chat, never in docs.

## Global Constraints
- No launcher client code in Phase 0 (`apps/`, `packages/` are documented, not created).
- No fake/empty artifacts (no empty crates, placeholder packages, scoped rules for non-existent folders).
- Every factual claim in docs tagged `Verified (YYYY-MM-DD, source)`, `Assumed`, or `Unverified`. Unsupported OS never "verified".
- Repo is public: every commit is published. No secrets, tokens, personal data or machine paths in commits/logs;
  secretlint runs before the first push. Only the GitHub repo is created/pushed — nothing else published or sent.
- Spikes live in `spikes/` with their own lockfiles, outside the pnpm workspace, ignored by Biome/CI; labeled THROWAWAY.

## Review Focus
1. pnpm 10+/11 skips dependency build scripts → Electron binary/esbuild/lefthook missing ("Electron failed to install") →
   build allowlist in `pnpm-workspace.yaml` (verify key name for the pinned pnpm); Task 2 checks `pnpm exec electron --version` in the spike.
2. Windows checkout CRLF/paths break format checks → `.gitattributes` `* text=auto eol=lf`, Biome `lineEnding: "lf"`, scripts use `node:path`.
3. Hooks invoke the global biome/lefthook (version drift) → hooks call `pnpm exec`, lefthook `min_version`, `prepare: lefthook install`.
4. Quiescent window runs game code via a registered service worker → fixture registers an SW; Task 5 asserts the game script never runs in the export window.
5. Snapshot ambiguity (hash coverage, IDB autoIncrement key generator, -0/NaN, binary keys) → Task 8 spec defines each; golden vector list covers each.

---

### Task 1: Bootstrap repo, licensing, public GitHub repo, agent rules v1
**Files:** create `.gitignore` (`.DS_Store`, `node_modules/`, `out/`, `dist/`, `test-results/`, `playwright-report/`,
`target/`, `lancedb/`, `.planning/`, `spikes/**/node_modules`, `spikes/**/target`), `.gitattributes`, `.editorconfig`, `.nvmrc`
(`24`), `.npmrc`, `package.json` (private, `AGPL-3.0-or-later`, `packageManager`, `engines.node >=24`), `pnpm-workspace.yaml`
(`packages: [fixtures/*]` for now + build allowlist), `LICENSE` (canonical AGPL-3.0 text from gnu.org/licenses/agpl-3.0.txt,
unmodified), `LICENSING.md` (default AGPL; commercial license by agreement; future paid-feature directory rule; core-free
commitment; trademark note), `TRADEMARKS.md`, `CLA.md` (individual CLA adapted from the Harmony HA-CLA-I template,
outbound "any license"; flagged for lawyer review; CLA Assistant app setup = owner action later), `SECURITY.md`,
`CODE_OF_CONDUCT.md` (Contributor Covenant), `.github/pull_request_template.md` (DoD checklist),
`.github/ISSUE_TEMPLATE/{bug.yml,compat-report.yml}` (compat report: game URL, OS, runtime, launch/input/save/restore),
`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.cursor/rules/core.mdc`, `.cursor/rules/docs.mdc`,
`docs/plans/2026-10-24-phase-0-foundation.md`; `git mv browser_games_concept.md docs/product/sources/concept-v1.0.ru.md`.
- [ ] `git init -b main`; commit LICENSE + LICENSING.md + README stub + .gitignore (`chore: initial commit with AGPL-3.0 license`);
  `pnpm dlx secretlint "**/*"` clean; `gh repo create maslakovSaveliy/wg-launcher --public --source . --remote origin --push
  --description "<one line>"`; enable Dependabot alerts, secret scanning + push protection, private vulnerability reporting
  via `gh api`; `git switch -c phase-0-foundation`.
- [ ] Pin pnpm: try 12.15.0 (`pnpm -v` inside repo auto-switches; `pnpm install` works; check `minimumReleaseAge` doesn't block
  Electron 45); else pin 11.7.0. Record result in MEMORY.md.
- [ ] AGENTS.md v1 (canonical; Cursor reads it natively): purpose, repo map (current + reserved), commands, hard rules
  (security invariants, data-safety invariants, honest-status rule, claim tagging, English, no fake artifacts), workflow
  (TDD, conventional commits, verify-before-claim), DoD. CLAUDE.md: `@AGENTS.md`, `@MEMORY.md` + Claude specifics (skills
  flow, context7 for library docs, plans in `docs/plans/`, never push/publish without ask). MEMORY.md: dated sections
  Decisions / Verified facts (seed from Evidence above) / Gotchas / Open questions. `core.mdc` alwaysApply → points to
  AGENTS.md; `docs.mdc` globs `docs/**/*.md` → claim tags, ADR format. Scoped Electron/TS rules added in Phase 1.
- [ ] Verify: `pnpm install` OK; `pnpm -v` matches pin; `test ! -e browser_games_concept.md`; `gh repo view
  maslakovSaveliy/wg-launcher --json visibility,licenseInfo` → PUBLIC + AGPL-3.0; `git log --oneline` shows commits.
- [ ] Commit `chore: bootstrap repository and agent rules`, push branch. Write Claude user-memory entries (owner profile,
  language prefs, license model, repo URL).

### Task 2: Quality toolchain + CI
**Files:** `biome.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `commitlint.config.mjs`, `lefthook.yml`,
`.secretlintrc.json`, `.markdownlint-cli2.jsonc`, `scripts/check-licenses.mjs`, `scripts/check-licenses.test.ts`, `.github/workflows/ci.yml`; root `package.json` scripts.
- [ ] Biome 2.6: lint+format JS/TS/JSON/CSS, `lineEnding: "lf"`, VCS-aware, ignores `spikes/**`, `docs/product/sources/**`.
- [ ] TS gate: strict base (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`); run
  `pnpm exec tsc -b` with TS 7.0.2; if TS 7 breaks any tool, fall back to 6.0.3; record in MEMORY.md.
- [ ] TDD `scripts/check-licenses.mjs` (reads `pnpm licenses list --json`; prod deps strict against the allowlist, dev deps
  report-only; exits 1 listing offenders): tests `rejects GPL-3.0 prod package`, `rejects LGPL-2.1 prod package`,
  `reports but allows GPL dev-only package`, `accepts MIT/Apache-2.0/BlueOak-1.0.0` with fixture JSON first → fail → implement → pass.
- [ ] lefthook (devDependency, `prepare: lefthook install`, `min_version`): pre-commit parallel — `pnpm exec biome check
  --write --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}` (`stage_fixed: true`), secretlint on staged,
  markdownlint-cli2 on staged `*.md`; commit-msg — commitlint (conventional); pre-push — `pnpm typecheck && pnpm test`.
- [ ] Scripts: `lint`, `format`, `typecheck`, `test`, `licenses:check`, `docs:lint`, `check` (all).
- [ ] CI: ubuntu job (lint, typecheck, licenses, docs:lint) + matrix macos-latest/windows-latest (install, test); `node-version-file: .nvmrc`; pinned action SHAs; `permissions: contents: read`.
- [ ] Verify: `pnpm check` passes; negative checks — `git commit -m "bad"` rejected; staged fake AWS key rejected; badly
  formatted staged `.ts` auto-fixed and re-staged; license script test with GPL fixture fails; `pnpm exec lefthook run pre-push` passes.
- [ ] Commit `chore: add quality toolchain, hooks and CI`, push, open **draft PR** `phase-0-foundation → main`; CI green on
  ubuntu/macOS/Windows read via ccd_pr tools (this is the only real Windows evidence: install + unit tests, not games).

### Task 3: Research docs, PRD, spike hypotheses (docs only; controller writes research docs — it holds the source reports)
**Files:** `docs/research/foundations.md` (OSS bases + license table with SHAs + test games), `docs/research/runtime-and-storage.md`
(Electron/Tauri/iOS facts + save extraction facts), `docs/product/prd.md`, `spikes/runtime-compat/HYPOTHESES.md`.
- [ ] PRD (English, from sources): problem, users, vertical scenario, MVP features, honest badges, playtime rule, delete
  semantics, non-goals/anti-goals, acceptance criteria (each mapped to a future test), out-of-scope list.
- [ ] HYPOTHESES.md written **before** running anything, with pass/fail thresholds. Electron fatal if: partition leak; lost
  persistence after restart; `crossOriginIsolated` false on 45 and 44 with correct headers; WebGPU adapter null where Chrome
  has one (also after `enable-unsafe-webgpu`); p95 frame time > 15% worse than Chrome on the same scene. Tauri wins only by
  passing a criterion Electron fails. If Electron fails GPU/perf but Chrome passes → reconsider architecture (Chrome `--app` + CDP).
- [ ] Verify: `pnpm docs:lint`; `grep -rnE "TODO|TBD" docs` empty outside "Open questions"; claims tagged. Commit `docs: add research, PRD and spike hypotheses`.

### Task 4: Controlled test game `fixtures/test-games/progress-lab` (TDD)
**Files:** `fixtures/test-games/progress-lab/{package.json, public/index.html, public/game.js, public/sw.js, public/iframe-host.html, server.mjs, playwright.config.ts, tests/progress.spec.ts}`.
- Game: buttons "Play step" / "Reset"; state = level, coins, inventory; persisted to localStorage (JSON), IndexedDB DB
  `progress-lab` (stores with keyPath, autoIncrement, index; values incl. Date, ArrayBuffer, Uint8Array, Blob) and an
  Emscripten-IDBFS-shaped DB (`/home/web_user`, store `FILE_DATA`, v21, `{timestamp, mode, contents}`). Shows
  `progressHash` (SHA-256 of canonical state) in `#progress-hash`. `?ephemeral=1` wipes storage on load. Registers `sw.js`
  (precaches game assets). `server.mjs` (no deps): serves `public/`, optional COOP/COEP via `/coi/` prefix, binds both
  `localhost` and `127.0.0.1` so `iframe-host.html` on one embeds the game cross-site on the other.
- [ ] Tests first (Playwright, bundled Chromium + `channel: chrome` project): `persists progress across reload`,
  `ephemeral mode loses progress` (proves test can fail), `binary values roundtrip byte-equal and Date type preserved`,
  `cross-site iframe storage is partitioned`. Run → fail → implement → pass.
- [ ] Commit `test: add progress-lab controlled test game`.

### Task 5: Electron spike (THROWAWAY, `spikes/runtime-compat/electron/`, own lockfile)
- Shared `spikes/runtime-compat/probe/` page POSTs JSON to the spike server: WebGL2 + `UNMASKED_RENDERER` (SwiftShader ⇒
  run invalid), WebGPU adapter info/features, `crossOriginIsolated` + SAB, wasm-feature-detect set, storage
  estimate/persist, OPFS write/read, IndexedDB Blob roundtrip, AudioContext; frame-time sampler (20 s fixed WebGL2 scene,
  p50/p95, long frames > 2× vsync, 3 runs, median); cold start to first frame. Results validated by `results.schema.json`.
- [ ] Electron 45 checks: two partitions isolation + restart persistence; COI from server headers and injected via
  `onHeadersReceived`; deny-by-default permission handler; trusted-input fullscreen + pointer lock (`sendInputEvent`);
  `node:sqlite` in main and `utilityProcess`; Playwright `_electron.launch` works (fallback `connectOverCDP`); quiescent
  export → clean partition restore of progress-lab, `progressHash` equal, incl. SW variant (assert game script never runs
  in export window) and cross-site iframe variant; package once (arm64, ad-hoc signed) and `open 'wgspike://launch?id=x'` →
  `second-instance`; `app.getAppMetrics()` memory.
- [ ] Verify: `node run.mjs --runtime=electron` writes schema-valid JSON; each hypothesis marked pass/fail/N/A with evidence. Commit `spike: electron runtime compatibility`.

### Task 6: Tauri + Chrome spike, compat matrix (timebox Tauri ≈ half a day)
- [ ] Tauri 2.12 minimal app: two webviews with distinct `data_store_identifier`, probe page via external URL, isolation + persistence + probe/frame-time.
- [ ] Chrome 156 baseline (Playwright `channel: chrome`, headed) and Chrome `--app=URL --user-data-dir=<per-game>` manual run.
- [ ] Public demos (webgpu-samples, three.js examples) in Electron and Chrome: load, console errors, frame-time sampler. Gamepad = N/A (no hardware).
- [ ] Optional `workflow_dispatch` job running the Electron spike's non-GPU checks (partition isolation, restart persistence,
  COI, `node:sqlite`, quiescent export/restore) on `windows-latest` → recorded as "Windows (CI runner, no GPU)" — never as game compatibility.
- [ ] `docs/compat/matrix.md` (generated from results: game/build, URL/version, date, OS, runtime, launch, input, save,
  restore, notes) + `docs/compat/methodology.md` (cold/warm, same scene/machine, no extrapolation). Regeneration is idempotent.
- [ ] Commit `spike: tauri and chrome baselines, compat matrix`.

### Task 7: ADRs `docs/adr/0000-template.md` … `0006`
0001 own client not fork · 0002 desktop runtime (Accepted/changed per spike evidence) · 0003 native languages: Rust
deferred, Go not adopted (triggers incl. butler/wharf reuse, first Rust op, stdio JSON-lines protocol sketch) · 0004
toolchain & repo layout (incl. packaging tool) · 0005 save transfer mechanism (isolated world + quiescent window) ·
0006 licensing model (AGPL-3.0-or-later + CLA + dual licensing + future source-available paid dir + trademark). Format: engineering:architecture ADR template; options table; facts vs assumptions.
- [ ] Verify docs:lint + claim tags; commit `docs: add architecture decision records`.

### Task 8: Specs `docs/specs/`
- `architecture.md`: processes & trust boundaries (mermaid), module map (`apps/desktop`, `packages/shared|snapshot|exporters`),
  on-disk layout, game-session lifecycle & policies, IPC contract, SQLite schema v1, shortcuts/deep links, playtime, badges,
  delete semantics, performance rules; "Future" sections: sync (revision DAG, keep both branches, `SyncBackend` interface,
  NestJS+PG+S3 sketch) and Rust core.
- `snapshot-format.md`: container, manifest schema, record encoding decision, canonicalization & contentHash coverage,
  limits, versioning/migration, golden vector manifest + list (`valid-*`, `invalid-*` incl. traversal, symlink, oversize, bad hash, unknown version).
- `save-transfer.md`: exporter interface & versioning, generic localStorage+IndexedDB exporter, Emscripten/Unity notes,
  origins/partitioning, declarative adapter schema (no code), restore protocol + failure matrix.
- `security.md`: assets, trust boundaries, threat table (game content, snapshot files, deep-link args, launcher UI),
  Electron checklist mapping, fuses, CSP, logging redaction, archive safety, permissions.
- [ ] Verify docs:lint + claim tags; commit `docs: add technical specifications`.

### Task 9: README, CONTRIBUTING, finalize rules, builder check
- [ ] `README.md` (what/status/commands/architecture/limitations/verified vs unverified platforms), `CONTRIBUTING.md`
  (setup, workflow, DoD, commits, dependency policy), `docs/README.md` index; finalize AGENTS.md/MEMORY.md with spike facts.
- [ ] Builder check: fresh subagent with brainstorming's `builder-check-prompt.md` reads PRD+specs as a Phase-1 implementer;
  fix gaps or list them as Phase-1 open questions; one round of owner questions if any.
- [ ] Final `pnpm check`; commit `docs: add readme, contributing and finalize agent rules`; push; mark PR ready; owner
  review; merge to `main` only on owner OK.

## Verification (end-to-end for Phase 0)
`pnpm install --frozen-lockfile && pnpm check` green locally and in GitHub CI (ubuntu/macOS/Windows); repo public with
AGPL-3.0 detected by GitHub; hooks negative checks rejected; progress-lab Playwright suite green;
spike JSON schema-valid and every hypothesis marked; `docs/compat/matrix.md` lists only real runs (macOS arm64; Windows/Linux
"not tested"); ADR-0002 status reflects evidence; no `apps/` or `packages/` code exists.

## Appendix A — Sources (for research docs)
Electron: releases.electronjs.org/release/v45.0.0 · electronjs.org/docs/latest/tutorial/electron-timelines · …/api/session ·
…/api/protocol · …/api/app · …/api/utility-process · …/tutorial/fuses · …/tutorial/security · …/api/browser-view ·
…/tutorial/tutorial-packaging · github.com/electron/electron issues #50242 (PR #50789), #49754, #45989, #54625, #54553.
Tauri: v2.tauri.app/reference/webview-versions · docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html ·
v2.tauri.app/reference/config · github.com/tauri-apps/tauri/issues/6381, /14963, releases. GPU: github.com/gpuweb/gpuweb/wiki/Implementation-Status.
Apple: developer.apple.com/app-store/review/guidelines (2.5.6, 4.7). CDP: ChromeDevTools/devtools-protocol pdl IndexedDB,
DOMStorage, Storage. electronjs.org/docs/latest/api/web-frame · developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies ·
developer.chrome.com/docs/privacy-sandbox/storage-partitioning · emscripten-core/emscripten src/lib/libidbfs.js ·
docs.unity3d.com/ScriptReference/PlayerPrefs.html · dexie-export-import README (Apache-2.0). Biome: biomejs.dev/internals/language-support,
biomejs.dev/blog/biome-v2. playwright.dev/docs/api/class-electron · nodejs.org/api/sqlite.html · cursor.com/docs/context/rules.
Repos: itchio/itch, itchio/butler, FlashpointProject/launcher, arhitekt86/pixens-launcher, lutris/web-runner, ferdium/ferdium-app,
tw93/Pake, gabrielecirulli/2048, doublespeakgames/adarkroom, OpenTTD/OpenTTD, mrdoob/three.js, BabylonJS/Babylon.js, webgpu/webgpu-samples.
