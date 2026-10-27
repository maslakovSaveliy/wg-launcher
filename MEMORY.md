# MEMORY.md

Shared memory for all agents and contributors. Append dated entries; fix or remove stale ones (see `AGENTS.md`).
Tags: `[V]` Verified (date, source), `[A]` Assumed (reasoned, not checked), `[U]` Unverified (reported, not checked).
All entries below are dated 2026-10-24 unless they say otherwise. Keep here decisions, gotchas, open questions and facts
recorded nowhere else; anything a committed document holds is a pointer to its section (owner decision, 2026-10-28).

## Decisions

- Phase 0 plan [docs/plans/2026-10-24-phase-0-foundation.md](docs/plans/2026-10-24-phase-0-foundation.md) (specs, docs,
  rules, tooling, runtime spike; no client code) is merged to `main` at d5a4812 (Phase 1 plan "Context"). ADRs in
  [docs/adr/](docs/adr/), index [docs/README.md](docs/README.md): 0001 own small client (Accepted); 0002 Electron 45.0.0
  (Accepted 2026-10-25 under the H7 condition below); 0003 Rust deferred, Go not adopted (Accepted); 0004 toolchain and
  layout (Accepted; Electron rows reopen with 0002); 0005 quiescent-window save transfer (Accepted, same condition);
  0006 licensing model (Accepted; awaits a lawyer).
- Own small Electron client, not a fork of itch, Flashpoint, Pixens or web-runner; their code is not reused (patterns
  only). The runtime is Electron 45.0.0 (ADR-0002); the spike supplied the evidence, on one machine (macOS arm64).
- 2026-10-25 Owner: ADR-0002 and ADR-0005 are Accepted on one condition: Phase 1 re-runs H7 (p95 frame time at most
  Chrome's p95 x 1.15) on the launcher with the frozen method. The hands-off timing runs (H7, Chrome side of H8, H9
  rerun, H20-6, demo frame samples) are "deferred" to Phase 1, not N/A or INVALID. A Phase 1 H7 FAIL reopens both ADRs
  ([A] the fallback, Chrome `--app` with CDP, has no preload, `ses.protocol.handle` or `webContents.debugger`, so
  ADR-0005's mechanism would not carry over). Source: ADR-0002 "Decision", ADR-0005 "Status", RESULTS.md header.
- 2026-10-25 Owner: the Tauri build was dropped (H17, H18 N/A) and Safari is only a labeled WebKit proxy; Phase 1 is code
  and tests only (no spikes, one review per task); exports without a confirmed in-game flush are allowed and labeled
  "flush unconfirmed" (ADR-0005 decision 7). The owner keeps their own git identity in commits.
- 2026-10-25 Owner: CLA counterparty is Savelii Maslakov as an individual (passport spelling), governing law the Russian
  Federation, both in `CLA.md`. The CLA stays inactive, and no outside contribution is accepted, until a lawyer has
  reviewed it and the CLA Assistant app is set up.
- 2026-10-25 Decided in the specs (Assumed; the owner can override): record encoding is deterministic CBOR
  (snapshot-format.md section 6.1); packaging is electron-builder (ADR-0004, option P1); PRD OQ-2 (a removed game's data
  stays orphaned until deleted) and OQ-3 (plain `http://localhost` and `http://127.0.0.1` only in development and test
  builds) are decided as proposed (architecture.md section 12).
- 2026-10-25 `spikes/runtime-compat/` stays in place, labeled THROWAWAY: ADRs and specs link to its results and the
  Phase 1 H7 re-run uses its method; it is deleted or archived only after the H7 outcome is recorded. Routine, Assumed.
- Rust is deferred to the local-packages stage. The MVP snapshot codec is TypeScript; a language-neutral spec with
  golden vectors lets a later Rust version pass the same vectors. Go is not adopted in the MVP.
- English everywhere in the repo, no exception. Product name **WGLauncher** (owner, 2026-10-25); codename and repo
  `wg-launcher`, deep-link scheme `wglauncher`. 2026-10-25 Owner: the Russian concept was replaced by its English
  translation `docs/product/sources/concept-v1.0.md`; the language exception and its lint ignores are gone.
- 2026-10-25 Owner: the Phase 1 plan [docs/plans/2026-10-25-phase-1-launcher.md](docs/plans/2026-10-25-phase-1-launcher.md)
  is approved; each task starts only on the owner's word; Phase 1 UI is functional only (design and UX later).
  Final-review rulings M5 (a launch cancels a background storage check, user tasks still give `GAME_BUSY`), M6, M7
  (manifest top level not strict, IPC strict), M8, M11 and M13 are recorded there.
- License model: `AGPL-3.0-or-later` by default, commercial use by separate agreement, CLA for outside contributors,
  future paid features only in one named source-available directory (none exists), trademark policy, core features
  always free: `LICENSING.md`, ADR-0006. Not legal advice. Dependency policy: shipped dependencies permissive only
  (`AGENTS.md`).
- `pnpm@12.15.0` pinned in `packageManager`: in the repo `pnpm -v` switches to it, `pnpm install` and
  `--frozen-lockfile` succeed, the default `minimumReleaseAge` does not block Electron 45.0.0. Fallback: `pnpm@11.7.0`.
  [V, 2026-10-24, run locally]
- Quality toolchain (Phase 0 Task 2): Biome for JS, TS, JSON and CSS only; markdownlint-cli2 for Markdown, no
  line-length rule; secretlint on staged files; commitlint with Conventional Commits plus `spike`; lefthook (pre-commit,
  commit-msg, pre-push = typecheck + unit tests); `pnpm test` is Vitest only, `pnpm test:e2e` is the fixture's
  Playwright suite. License gate: production dependencies strict against the allowlist (SPDX `OR`/`AND` understood),
  dev-only ones warn. Execution style: subagent-driven development, test-first where code exists.
- 2026-10-28 Owner: "no machine-specific paths" is enforced by `scripts/check-machine-paths.mjs` (`pnpm paths:check`,
  in `pnpm check`, pre-commit on staged files, CI on all tracked text files); what it flags and the one allowed path
  `/home/web_user`: AGENTS.md "Commands" and the script header. The user-name needle is off on CI (`CI=true`), because a
  runner's generic user name would match ordinary words.
- 2026-10-25 Phase 1 Task 3 (`.wgsnap` container, Assumed): rulings R10 (Node-only entry
  `@wg-launcher/snapshot/container`), R11 (exact `compressedSize`, ratio bound), R12 (a decompressor error is always
  `SNAP_ZSTD_INVALID`), chunking-independent codes and count limits: snapshot-format.md sections 2, 4 and 8 and plan
  Task 3. The container entry is never re-exported from `src/index.ts` (`src/web-only.test.ts` walks its import graph); zod 4.6.7 (MIT)
  is a production dependency of `packages/snapshot`.
- 2026-10-28 Phase 1 Task 4 (golden vectors, Assumed unless noted): layout, the 31 vectors plus `invalid-truncated-tar`
  (M6), `--overwrite` and freezing: snapshot-format.md section 10, plan Task 4. `VECTOR_FIELDS` in
  `scripts/generate-vectors.ts` (UUIDv7s at 2026-01-01, `createdAt` `2026-01-01T00:00:00.000Z`, exporter
  `generic-web-storage` 1.0.0) make generation deterministic: two runs gave byte-identical files, zstd included [V,
  2026-10-28, Node 24.13.0, run locally]. `v1/` is excluded from Biome so the JSON stays byte-identical to the
  generator's `JSON.stringify(value, null, 2)`.
- Controlled test game `fixtures/test-games/progress-lab` (Phase 0 Task 4), not a real game: contract, storage shapes,
  hash and tests in its [README](fixtures/test-games/progress-lab/README.md); `pnpm test:e2e` and CI in AGENTS.md
  "Commands". Its server logs each request to stdout because H14 (variant b) reads a request log.
- Spike hypotheses `spikes/runtime-compat/HYPOTHESES.md` (H1 to H21, thresholds, decision rules in section 4) were
  frozen on 2026-10-24 before any run and change only through its dated "Amendments". Outcomes: RESULTS.md "Summary".
- PRD (`docs/product/prd.md`) marks each requirement `Owner`, `Concept` or `Assumed`; AC-1 to AC-25 each name a test type.
- Public repo <https://github.com/maslakovSaveliy/wg-launcher>. Work on branches; merge to `main` only on the owner's
  approval.

## Verified facts

### Where the evidence lives

- Open-source bases (itch, Flashpoint, Pixens, web-runner; Ferdium's per-service session), the [U] "none has save
  export" inference and the [A] "none worth forking" verdict: [foundations.md](docs/research/foundations.md) sections 1
  to 4; test games and licenses: section 5; licensing precedent (bitwarden, Harmony CLA CC BY 3.0, Contributor Covenant
  CC BY-SA 4.0): section 6. [V, 2026-10-24, `gh api`]
- Electron 45 versions and support, its changes, the APIs we rely on, security checklist, fuses, packaging, Playwright's
  experimental Electron support, known issues: [runtime-and-storage.md](docs/research/runtime-and-storage.md) section 2;
  Tauri section 3; iOS and Android section 4; save extraction (CDP, isolated worlds, IDBFS, Unity, partitioning, OPFS,
  export libraries, Node zstd) section 5; packaging and crate versions section 7. [V, 2026-10-24]
- Runtime spike, Electron 45 (H1 to H16), Chrome (H19), Chrome `--app` (H20), Safari proxy, demos (H21), the Windows CI
  job not added: [RESULTS.md](spikes/runtime-compat/RESULTS.md) "Summary" and per-hypothesis sections, machine under
  "Run"; matrix [docs/compat/matrix.md](docs/compat/matrix.md). [V, 2026-10-24, run locally, one machine] In short:
  WebGPU without a switch on this Mac (H5; Electron 24 features, Chrome 155 and bundled Chromium 23; [U] on other OSes
  and GPUs: runtime-and-storage.md section 2.5); H12 environment-dependent; H9 and H13 INVALID; H16 FAIL (the closed
  window's renderer exited 27.8 s after the close, when the service worker stopped; cause Assumed); H2b: SIGKILL 5 s
  after the writes lost a persistent cookie, while localStorage, IndexedDB, Cache Storage and OPFS survived.

### Tooling versions (`npm view`, 2026-10-24; the living list runtime-and-storage.md section 7 points to)

- [V] electron 45.0.0, electron-vite 6.0.0, vite 8.3.5, react 19.3.1, typescript 7.0.2 (6.0.3 is the last 6.x),
  @biomejs/biome 2.6.2, vitest 5.0.5, @playwright/test 1.64.1, zod 4.6.7, lefthook 2.2.2, @commitlint/cli 21.2.4,
  secretlint 13.0.7, markdownlint-cli2 0.24.0, @types/node 24.19.2 (24.x line), pnpm 12.15.0; installed exactly so.
- [V, 2026-10-24, run locally] TypeScript 7.0.2 works with the whole toolchain, no fallback to 6.0.3: `tsc -b` checks `.ts` and
  checked `.mjs` (`allowJs`, `checkJs`) with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `verbatimModuleSyntax`, and fails on a deliberate type error; Vitest, Biome, commitlint (`.mjs` config), secretlint and
  markdownlint-cli2 run on Node 24.13. TS 7 is a native binary (optional `@typescript/typescript-<platform>` package).
- [V, 2026-10-24, run locally] Biome 2.6.2 also formats Markdown and YAML by default (`biome check .` rewrote `AGENTS.md` tables; its
  schema has `markdown`, `yaml`, `html`, `graphql`), so `biome.json` whitelists JS, TS, JSON and CSS in `files.includes`.
- [V] `node:sqlite` is release candidate since Node 25.7, needs no flag since 22.13
  (<https://nodejs.org/api/sqlite.html>), and runs in Electron 45 main and `utilityProcess` without a warning on this Mac
  (RESULTS.md H10). [U] Its stability label in Node 24.22 (Open questions).

### Test fixture and record layer

- [V, 2026-10-24, run locally] The 14 fixture tests pass three times in a row in both Playwright projects (84 runs):
  bundled Chromium 156.0.8078.4 and installed Chrome 155.0.8059.85. `localhost` and `127.0.0.1` are different sites
  for partitioning in both (fixture README "Server"); `clear()` does not reset an `autoIncrement` key generator, deleting
  the database does (README "Storage shapes", snapshot-format.md section 7.5).
- [V, 2026-10-25, Node 24.13.0, `node -e`] Node 24 has `DataView` `setFloat16`/`getFloat16`, `Float16Array`,
  `Math.f16round` (V8 `--js-float16array`, on by default) and `String.prototype.isWellFormed`; `Blob`, `File`,
  `crypto.subtle` are globals. TypeScript 7.0.2 types Float16 only with lib `ES2025.Float16` (added in
  `packages/snapshot/tsconfig.json`). [A] Chromium 156 has them too (Float16 shipped in Chrome 135; not run in Electron).
- [V, 2026-10-25, Node 24.13.0, `node -e`; basis of snapshot-format.md section 6.3] V8 enumerates array indexes
  (canonical decimal up to 2^32 − 2, `"4294967294"`) first, ascending, then other keys in insertion order
  (`"4294967295"`, `"01"` are ordinary keys); `Map`/`Set` store `-0` as `+0`; `new RegExp("a/b").source` is `a\/b`,
  `new RegExp("").source` `(?:)`, `/a/gimsuyd.flags` `dgimsuy`; `Blob` lowercases `type` and empties one outside
  printable ASCII; `new File(["x"], "\ud800").name` is U+FFFD; `lastModified: -0` stays `-0`, `2 ** 60` stays unsafe
  (value.test.ts); `Object.prototype.toString` of a class instance is `[object Object]`, so error details never name
  the class.
- Record-layer decisions (Assumed): depth counting, keys and values at depth 1, `keyGenerator` 2^53 as `fa 5a000000`,
  view plus buffer as `EXP_SHARED_REFERENCE`, and controller rulings R7 and R9 (RegExp source never canonicalized, flags
  checked, a non-compiling source is `SNAP_RECORD_INVALID`; File `lastModified` `-0` or above 2^53 − 1 is
  `EXP_UNSUPPORTED_VALUE`): snapshot-format.md sections 6.2, 6.3 and 7. API choices (`onBlob` once per value, caller
  deduplicates; `encodeLocalStorage` gives `null` for no items; `encode*` sort and throw `TypeError` on duplicates or a
  schema the reader would refuse) are in the comments of `src/record/value.ts` and `src/record/data-files.ts`.
- [V, 2026-10-25, pnpm 12.15.0, scratch workspace and this repository] `pnpm licenses list --prod --recursive --json`
  lists neither our `AGPL-3.0-or-later` workspace packages nor hides their dependencies, so `pnpm licenses:check` passes;
  [A] a later pnpm may list them, so the gate exempts a member only while its license is exactly `AGPL-3.0-or-later`
  (unit-tested). Full record: ADR-0004 "Action items".

### Cursor rules and dev machine

- [V] Project rules are `.cursor/rules/*.mdc` with frontmatter `description`, `globs`, `alwaysApply`; Cursor reads
  `AGENTS.md` natively. <https://cursor.com/docs/context/rules>
- [V] Dev machine: macOS 27.0.1 on arm64 (MacBook Air M3 `Mac15,12`, fanless, Metal 4, 60 Hz display); Node 24.13.0 via
  nvm; Rust 1.98.1; Go 1.27.1; git 2.56.0; gh 2.102.0; Google Chrome 155 and Xcode; a global Biome and a Homebrew
  lefthook 2.1.15. No Windows or Linux machine: those platforms are **unverified** until CI or a real run says otherwise.

## Gotchas

### pnpm and the toolchain

- pnpm 11+ skips dependency build scripts unless listed in `allowBuilds` in `pnpm-workspace.yaml` (`strictDepBuilds`:
  `ERR_PNPM_IGNORED_BUILDS`); Electron's binary download and lefthook need entries (`allowBuilds: {lefthook: true}` works
  in 12.15.0; without it `pnpm add` fails and writes no placeholder). Vitest 5 uses rolldown, so esbuild needs no entry.
  [V, 2026-10-24, pnpm 12.11 docs and a 12.15.0 run]
- pnpm 11+ reads only auth and registry settings from `.npmrc`; others go in `pnpm-workspace.yaml` in camelCase. [V,
  2026-10-24: `save-exact` in `.npmrc` ignored, `saveExact` in the YAML worked]
- pnpm 11+ defaults `minimumReleaseAge` to 1440 minutes: a version younger than a day cannot be installed. pnpm switches
  itself to `packageManager`'s version inside the repo (`pnpm -v` 11.7.0 outside, 12.15.0 inside) and records it in
  `pnpm-lock.yaml`. [V, 2026-10-24]
- The `packages` glob `fixtures/*` matches one level only; `fixtures/test-games/<name>` needs `fixtures/*/*` or the
  explicit `fixtures/test-games/*` (used). [V, 2026-10-24, pnpm 12.15.0]
- pnpm JSON output carries absolute machine paths: read names only, never print paths. [V, 2026-10-24 and 2026-10-25,
  pnpm 12.15.0, scratch workspaces] `pnpm licenses list --json` gives `{"<license string>": [{name, versions[], paths[],
  license, author, homepage, description}]}`, `--prod`/`--dev` pick the scope, strings can be SPDX expressions such as
  `(MIT OR CC0-1.0)`, and without `--recursive` only the root importer is reported (`{}`), so `check-licenses.mjs` passes
  `--recursive`. `pnpm ls -r --depth -1 --json` lists the root project too (`wg-launcher`). `pnpm ls --prod --depth
  Infinity --json` lists projects whose `dependencies` map names to `{from, version, resolved?, path, dependencies?}`
  (plus `optionalDependencies`), workspace dependencies as `link:...`, no dev-only packages. [U] What pnpm prints for a
  package without a license field (the script treats missing, empty and `Unknown` alike).
- A new workspace package without dependencies adds nothing to `pnpm-lock.yaml`; `pnpm install` says "Already up to
  date". [V, 2026-10-25, pnpm 12.15.0]
- Call tools through `pnpm exec` in hooks and scripts: a global Biome and a Homebrew lefthook on the dev machine drift.
  lefthook's postinstall writes a commented-out `lefthook.yml` if none exists and installs hooks that prefer a `lefthook`
  on `PATH`, so git runs Homebrew 2.1.15 here, not 2.2.2; `min_version` is `2.1.15` (tested with both). [V, 2026-10-24]
- lefthook `stage_fixed` re-stages whole files, so a partially staged file (`git add -p`) gets fully staged by the Biome
  fix. [U] not tested here
- nvm reads `.nvmrc` (`nvm use`); `24` resolves to the newest installed Node 24.
- `tsc -b` with `references` needs `composite: true` and refuses `noEmit` (TS6306, TS6310), which the base config sets,
  so the root `typecheck` script lists the projects (`tsc -b . <dirs>`): add every new `tsconfig.json` there. [V,
  2026-10-24, TypeScript 7.0.2]
- `packages/shared` is consumed as TypeScript source (`exports` → `src/index.ts`); under `NodeNext` relative imports need
  `.js` (`./ids.js`), which Vitest and Vite map to `.ts`. [V, 2026-10-25, `pnpm typecheck`, `pnpm test`]
- Plain `node` (24.13.0) cannot run this repo's TypeScript: strip-only mode refuses parameter properties
  (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, `src/container/inflate.ts`) and `.js` specifiers do not map to `.ts`
  (`ERR_MODULE_NOT_FOUND`). `scripts/generate-vectors.ts` runs with `--experimental-transform-types` (prints an
  ExperimentalWarning) and a `module.registerHooks` `.js` → `.ts` resolve fallback before dynamic imports; no dependency.
  [V, 2026-10-28, run locally]
- Biome 2.6: `linter.rules.recommended` is deprecated, use `linter.rules.preset: "recommended"`;
  `usePlaywrightValidDescribeCallback` flags any function named `describe`, even a local helper; `biome check --write`
  reformats JSON test vectors (line breaks only, hex kept). [V, 2026-10-24 and 2026-10-25, Biome 2.6.2]
- markdownlint-cli2 appends config `globs` to command-line globs, so `.markdownlint-cli2.jsonc` has none (`docs:lint`
  passes `"**/*.md"`, pre-commit the staged files); `gitignore: true` skips `.superpowers/` and the like. MD013 off; MD041
  off only for the PR template; MD004, MD022, MD032 off only under `docs/plans/`. [V, 2026-10-24]
- `spike` is not a type in `@commitlint/config-conventional`; `commitlint.config.mjs` adds it. [V, 2026-10-24: `spike:`
  accepted, `wip:` and `Spike:` rejected]
- License gate versus bundling: the gate fails only on production dependencies, but electron-vite bundles renderer
  `dependencies` and recommends renderer-only packages as `devDependencies`, which would escape it. Everything bundled or
  packaged goes in `dependencies`; `scripts/prod-deps-guard.mjs` enforces it in the desktop build (ADR-0004 "Dependency
  declaration"). Open in Phase 1: the electron-vite settings, and [A] that the guard's `load` hook sees every bundled
  module in a real build (unit-tested with fake ids only until Task 5).
- Repo files: `LICENSE` stays the unmodified AGPL text or GitHub stops detecting it; `.gitattributes` forces LF so format
  checks match on Windows; Contributor Covenant 3.0 is CC BY-SA 4.0 (not CC BY 4.0), as `CODE_OF_CONDUCT.md` says.
- A `workflow_dispatch` workflow runs only when its file is on the default branch, so it cannot be tried from a feature
  branch. [V, 2026-10-25, GitHub Actions events reference; RESULTS.md "Windows CI job"]

### Node, zstd and the snapshot codec

- Node's zstd does not report truncation: a checksummed frame cut by 6 bytes decompressed without error through
  `zstdDecompressSync` and `createZstdDecompress`. The `.wgsnap` reader detects it itself (plan M6, `ZstdFrameWalker` in
  `packages/snapshot/src/container/zstd-frame.ts`). [V, 2026-10-25, Node 24.13.0, `node -e`]
- Node's streaming zstd compressor can append a second, empty frame (`28b52ffd 24 00 01 00 00` plus checksum):
  `lib/zlib.js` gives `ZSTD_e_end` to a chunk still queued at `end()`, then `_flush` finishes again. Three chunks piped from
  `Readable.from` gave two frames; awaiting each `write()` callback before `end()` (what the writer does) gave one. [V,
  2026-10-25, Node 24.13.0, scratch script and `lib/zlib.js` `_flush`, `_transform`]
- A wrong content checksum fails with `ZSTD_error_checksum_wrong` (errno 22, "Restored data doesn't match checksum") in
  both Node APIs. `zstdCompressSync` writes a single-segment frame with the content size (descriptor `0xa4` for 300 000
  bytes with checksum); the streaming compressor writes a window descriptor (`0x04`, window byte `0x58`, 2^21). [V,
  2026-10-25, Node 24.13.0, scratch script]
- `TextDecoder` drops a leading U+FEFF unless built with `ignoreBOM: true` (`ef bb bf 61` gave one character, two with
  it); the CBOR decoder uses `{fatal: true, ignoreBOM: true}` because text is never altered (snapshot-format.md section
  6.2 rule 4). [V, 2026-10-25, Node 24.13.0, `node -e`]

### Electron, Chromium and the spike

- Electron approves every permission request unless a handler denies it. CDP IndexedDB can read and delete but has no
  put or add, so restore cannot use CDP. [V, 2026-10-24, Electron session docs and `IndexedDB.pdl`; runtime-and-storage.md
  sections 2.3 and 5.1]
- Playwright 1.64.1 (also `_electron.launch`) disables `ThirdPartyStoragePartitioning` (issue 32230): a cross-site
  iframe shares storage with the top level. `--enable-features=...` changes nothing; a later `--disable-features` list
  without that entry restores partitioning (last switch wins), as `playwright.config.ts` does and the app must
  (architecture.md section 5). [V, 2026-10-24, Chromium 156, Chrome 155, Electron 45; fixture README "Tests", RESULTS.md H11]
- `ses.clearStorageData({origin})` does not clear a partitioned iframe's storage (key
  `http://127.0.0.1:4417/^0http://localhost`); CDP `Storage.clearDataForStorageKey` does; `ses.clearStorageData()`
  without options clears everything. [V, 2026-10-24, RESULTS.md H14 wipe probes]
- Main-process `WebFrameMain` has no isolated-world execution: for a subframe use a preload (`nodeIntegrationInSubFrames`)
  calling `webFrame.executeJavaScriptInIsolatedWorld`. A registered service worker controls a top-level stub navigation
  unless CDP `Network.setBypassServiceWorker` is on ([A] that the bypass also covers subframes: no iframe control was
  run); export after the game's worker stopped. [V, 2026-10-24, RESULTS.md H14, "Deviations" 2 and 3]
- `requestPointerLock()` right after `requestFullscreen()` in one handler fails ("A user gesture is required"); call it
  alone or first. `navigator.keyboard.lock()` needs no gesture. [V, 2026-10-24, RESULTS.md H13; [A] fullscreen consumes
  the transient activation]
- `webContents.debugger` commands (even `Network.enable`) hang on a window that never navigated: load `about:blank` first.
  `app.getGPUFeatureStatus()` right after `ready` reports everything disabled until `app.getGPUInfo("complete")` or a
  first render. [V, 2026-10-24, RESULTS.md "Findings and gotchas"]
- Frame timing on the dev Mac needs an unlocked screen (else `loginwindow` keeps focus); uncapped runs queue 15 to 41 s of
  GPU work and degrade interleaved capped runs: keep cooldowns, never interleave. [V, 2026-10-24, RESULTS.md "Findings
  and gotchas" and "Deviations" 6, with the numbers; [A] the cause]
- macOS TCC attributes the dev Electron process to the app that launched it (`com.anthropic.claude-code` for agent runs),
  and a microphone request stalls before the permission handler while OS access is undecided: rerun media checks on the
  packaged app. [V, 2026-10-24, RESULTS.md H12; security.md section 5]
- The prebuilt Electron 45.0.0 `Info.plist` ships camera, microphone, audio-capture and two Bluetooth usage descriptions;
  the packaged launcher must not (security.md section 5), and electron-vite's example `electron-builder.yml` adds camera
  and microphone ones, so do not copy it. [V, 2026-10-25, `plutil -p` of `electron@45.0.0`; ADR-0004]
- `app.setAsDefaultProtocolClient` leaves a LaunchServices `LSHandlers` entry that outlives `lsregister -u` and the
  deleted app; location and removal recipe: RESULTS.md H15. [V, 2026-10-24, Electron 45 spike]
- Chrome `--app` keeps the browser process alive after its last window closes (a launcher must quit it), and a fresh
  profile shows a Google Translate bubble in the app window. [V, 2026-10-24, RESULTS.md H20]
- CDP `IndexedDB.requestData` fails with "Could not get index" for an empty `indexName`: omit it to read the store
  (Chrome 155). A stale `DevToolsActivePort` in a reused user-data directory names a dead port: delete it before
  relaunching with `--remote-debugging-port=0`. [V, 2026-10-24, Task 6 spike]
- Playwright launches Chrome headed, but an exact 1280 x 720 CSS-pixel viewport at native scale needs `viewport: null`
  plus CDP `Browser.setWindowBounds`; `Page.bringToFront` is enough for focus. [V, 2026-10-24]
- Safari's AppleScript can close its own tabs, but `tabs of window` indexes shift: iterate backwards. [V, 2026-10-24]
- `@playwright/test` `webServer.port` is deprecated, use `url`; `pnpm test:e2e --project=chromium` forwards arguments to
  Playwright; `node:http` sends `..` paths byte for byte while `fetch` and `new URL` collapse them, so traversal tests
  use `node:http`. [V, 2026-10-24]
- zsh: `log` is a builtin, call the macOS unified log as `/usr/bin/log`; an unmatched glob aborts the whole command
  (`rm -f a-* b-*` removed nothing when `b-*` matched nothing). [V, 2026-10-24]

## Open questions

- Lawyer review of `CLA.md`, `LICENSING.md` and `TRADEMARKS.md` (party and governing law are filled in; whether the
  Harmony wording, such as the UN Convention exclusion in section 6.1, and the moral-rights waiver fit Russian law is for
  the lawyer), and setting up the CLA Assistant app (owner action). Does the CLA need a postal address or another
  contact beyond the GitHub account? Default: the lawyer decides.
- Does Electron pass H7 on the launcher (condition of ADR-0002 and ADR-0005)? Chrome 156 is not installed on the dev machine, so a result
  against Chrome 155 carries "version mismatch". Default until measured: Electron stays the runtime.
- Spike leftovers (RESULTS.md): the `node:sqlite` stability label in Node 24.22 (H10); why Electron reports one extra
  WebGPU feature, `texture-compression-unaligned` (H19); Electron 44.x cross-origin isolation, untested because 45.0.0
  passed (H3, H4); H12 on the packaged app and the H13 real-click run ("Open items for the owner").
- Esc in launcher-set fullscreen (PRD OQ-8, architecture.md section 9): default is Esc held for 1.5 s exits and short
  presses reach the game, so the launcher never takes Esc from a game; "every Esc exits" is a one-line policy change.
- Branch protection on `main` (suggested only, owner decision).
