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
- 2026-10-28 CI fix 1 (controller rulings, Assumed): R22 pins `.nvmrc` to `24.22.1`, the Node line of Electron 45
  (24.22.0), so CI and local runs match what the snapshot worker runs on; R23 makes the reader's code independent of
  the zstd version (the frame walker's verdict wins over a decompressor error): snapshot-format.md section 2 and the
  "Node, zstd and the snapshot codec" gotcha below.
- 2026-10-25 Phase 1 Task 3 (`.wgsnap` container, Assumed): rulings R10 (Node-only entry
  `@wg-launcher/snapshot/container`), R11 (exact `compressedSize`, ratio bound), R12 (a decompressor error is always
  `SNAP_ZSTD_INVALID`; replaced on 2026-10-28 by R23 above), chunking-independent codes and count limits: snapshot-format.md sections 2, 4 and 8 and plan
  Task 3. The container entry is never re-exported from `src/index.ts` (`src/web-only.test.ts` walks its import graph); zod 4.6.7 (MIT)
  is a production dependency of `packages/snapshot`.
- 2026-10-28 Phase 1 Task 4 (golden vectors, Assumed unless noted): layout, the 31 vectors plus `invalid-truncated-tar`
  (M6), `--overwrite` and freezing: snapshot-format.md section 10, plan Task 4. `VECTOR_FIELDS` in
  `scripts/generate-vectors.ts` (UUIDv7s at 2026-01-01, `createdAt` `2026-01-01T00:00:00.000Z`, exporter
  `generic-web-storage` 1.0.0) make generation deterministic: two runs gave byte-identical files, zstd included [V,
  2026-10-28, Node 24.13.0, run locally]. `v1/` is excluded from Biome so the JSON stays byte-identical to the
  generator's `JSON.stringify(value, null, 2)`.
- 2026-10-28 Phase 1 Task 5 (`apps/desktop` skeleton, Assumed unless noted): build flavors through `__WG_FLAVOR__`
  (`electron-vite build --mode test` = test, `electron-vite build` = prod, `electron-vite dev` = dev); the dev flavor
  uses `WG_USER_DATA` when set, else its own userData `<appData>/WGLauncher Dev`; the test flavor refuses to start
  without an absolute `WG_USER_DATA` and never reads Electron's default userData; the bundling guard has
  `apply: "build"` (the dev server serves Vite's own client from `node_modules`); the launcher session is the in-memory partition `launcher`; covers are named
  `<uuidv7>-<16 lowercase hex>.<png|jpg|webp>` (the protocol's `COVER_NAME`); the preload is CommonJS
  (`out/preload/launcher.cjs`, a sandboxed preload cannot be ESM); the launcher quits when its last window closes, on
  macOS too. `fixPartitioningSwitch` takes Electron's `app.commandLine`, not argv, because Playwright's loader appends
  its switches with `appendSwitch`. `pnpm test:e2e` runs the desktop suite first, so extra arguments reach the fixture
  only; CI runs `test:e2e:fixture --project=chromium` and a separate desktop job. Leaving react, react-dom and scheduler
  out of the packaged `node_modules` moves to Task 16 (no electron-builder config exists yet).
- 2026-10-28 Phase 1 Task 6 (library database, Assumed unless noted): `apps/desktop/src/main/db/`; migrations are `.sql`
  files imported with Vite's `?raw`, the pre-migration copy is made with `VACUUM INTO` into `tmp/` as a `.partial` file and renamed into `backups/` (architecture.md
  section 7);
  `snapshots.revision_id` stays the primary key and `addIfAbsent` adds no row for a stored revision (M8); the 5 ms budget
  is checked by query plans, not by time (R18); repositories take the injected clock, never `Date.now()`; `Db` is a
  union of `WritableDb` and `ReadOnlyDb`, and repositories accept only the writable one. Over 1 000 games, 5 sessions,
  2 storage targets and 3 snapshots each, one call took 1.05 ms for `games.list` (1 000 rows) and 0.002 to 0.015 ms for
  the indexed lookups [V, 2026-10-28, Node 24.13.0, mean of 200 calls, a throwaway script; not a product number].
- 2026-10-28 Phase 1 Task 7a (URL, permission and deep-link policies, Assumed): `apps/desktop/src/main/policy/`
  (`site.ts`, `url-rules.ts`, `permissions.ts`, `deep-link.ts`); `tldts` 7.4.19 (MIT, `tldts-core` MIT) is a
  production dependency of `apps/desktop`. The settled details (raw shapes refused before parsing, literal dev hosts
  only, whole host as the site where no registrable domain exists, two launch arguments are invalid): security.md
  section 5 "Implementation", architecture.md sections 5, 8 and 12.
- 2026-10-28 Phase 1 Task 8 (game windows, Assumed unless noted): files and rules in architecture.md sections 4 and 5
  ("Close procedure details", "Runtime details", "Lock details", "Implementation (Phase 1 Task 8)") and security.md
  section 5 ("Wired in Phase 1 Task 8"). In short: a cancelled background lease not released within 2 s refuses the
  launch with `INTERNAL`; a launch while `closing` returns `{window: "closing"}`; a window not painted after 15 s is
  shown anyway; after a Cancel of "Open in browser?" that window is not asked again for 10 s (fix round 1, R26); the
  unload step waits at most 2 s; a
  `will-prevent-unload` is answered by cancelling, asking, then reloading `about:blank` with the trap ignored. The test
  flavor records `shell.openExternal` calls (`externalOpened`) instead of opening; e2e pages are served by
  `apps/desktop/e2e/test-pages.ts` on `127.0.0.1`.
- 2026-10-28 Phase 1 Task 9 (IPC contract and library UI, Assumed unless noted): the settled details are in
  architecture.md section 6 ("Implementation (Phase 1 Task 9)"), section 7 ("What the user sees") and section 12
  ("Implementation (Phase 1 Task 9)"). In short: new result code `LIBRARY_READ_ONLY` for every channel but
  `settings:get` while the database is read-only; a refused sender gets `INVALID_ARGUMENT` "Refused." and one
  `IPC_FORBIDDEN_SENDER` record per call; the same URL twice is confirmed in a native dialog by main (Cancel is
  `CANCELLED`); `games.cover_path` holds the cover's file name, not a path; settings have an empty allowlist; the
  bridge is `window.wg` (version 2) without `onTaskProgress` until Task 13; "Export verified" cannot appear yet
  because no exporter version exists in this build; a corrupt `library.db` shows a native error dialog, then exit 1
  (the test flavor records it in `<userData>/test-error-dialogs.jsonl`).
- 2026-10-28 Phase 1 Task 10 (window state, fullscreen, playtime, Assumed unless noted): Ruling R21 (a saved size
  without a position keeps its size, clamped and centered on the primary display); the F-6 "UI control" is the View
  menu item with role `togglefullscreen` (`app-menu.ts`), because section 6 has no fullscreen channel and a game window
  has no UI; saved flags are applied on the first `show`; step 1 of the close procedure feeds playtime `hide`; details
  in architecture.md sections 9 and 10 ("Implementation (Phase 1 Task 10)").
- 2026-10-28 Phase 1 Task 11 (launch input and shortcuts, Assumed unless noted): `second-instance` and `open-url` are
  registered right after the single-instance lock and queued until the runtime and the launcher page are up
  (`launch-input.ts`); malformed, unknown and refused launches are native notices (`Dialogs.notify`) over the
  library, no renderer event; `shortcut:create` is macOS and Windows only; `setAsDefaultProtocolClient` only in the
  packaged prod build: architecture.md section 8 ("Implementation (Phase 1 Task 11)"). Fix round 1 (Ruling R30):
  notices no longer block the launch queue, both are bounded, a closed launcher is opened again to show the library,
  "Create shortcut" is hidden where unsupported, and a page's own fullscreen is saved as not fullscreen.
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
  nvm (the nvm default) and, since 2026-10-28, Node 24.22.1 via nvm, the version `.nvmrc` pins (R22); Rust 1.98.1; Go 1.27.1; git 2.56.0; gh 2.102.0; Google Chrome 155 and Xcode; a global Biome and a Homebrew
  lefthook 2.1.15. No Windows or Linux machine: those platforms are **unverified** until CI or a real run says otherwise.

## Gotchas

### pnpm and the toolchain

- pnpm 11+ skips dependency build scripts unless listed in `allowBuilds` in `pnpm-workspace.yaml` (`strictDepBuilds`:
  `ERR_PNPM_IGNORED_BUILDS`); lefthook needs an entry (`allowBuilds: {lefthook: true}` works in 12.15.0; without it
  `pnpm add` fails and writes no placeholder). Vitest 5 uses rolldown, so esbuild needs no entry. [V, 2026-10-24, pnpm
  12.11 docs and a 12.15.0 run]
- Electron 45 creates the userData directory as soon as anything reads `app.getPath("userData")` (and
  `app.getPath("crashDumps")` creates `<userData>/Crashpad`), even before `app.setPath("userData", ...)`; when nothing
  reads them first, `setPath` before `ready` leaves the default directory uncreated and `sessionData` and `crashDumps`
  follow the new userData. An early test-flavor build read the default and left an empty `WGLauncher` directory in the
  real Application Support (removed with `rmdir`); the e2e harness now fails a run that creates or changes the real
  `WGLauncher` or `WGLauncher Dev` directory. [V, 2026-10-28, a probe app on Electron 45.0.0, macOS arm64; desktop e2e
  RED before the fix, GREEN after]
- Under `vite serve`, plugin `transform` hooks also see Vite's client (`node_modules/vite/dist/client/client.mjs`), so a
  bundling check must be `apply: "build"`. A reload of the launcher during its first `loadURL` rejects that call with
  `ERR_ABORTED`, which `start()` treats as a start-up failure (exit 1); in a CDP check, wait for the first load before
  reloading. CDP `Runtime.evaluate` defaults to `allowUnsafeEvalBlockedByCSP: true`, so an `eval` control needs it
  false; CSP violations arrive as `Log.entryAdded` with source `security`. [V, 2026-10-28, reviewer's Vite 8.3.5 check
  and the dev-flavor run]
- `electron@45.0.0` has no install script, so it needs no `allowBuilds` entry (the older note that its binary download
  needs one was wrong for 45): `pnpm add -D electron@45.0.0` ran no script, and the binary is downloaded on the first
  `require("electron")` (which prints "Downloading Electron binary...") or by its `install-electron` bin, which CI calls.
  electron-vite builds without the binary (it reads only `electron/package.json`). [V, 2026-10-28, pnpm 12.15.0, the
  package's `package.json`, `index.js` and `install.js`]
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
- nvm reads `.nvmrc` (`nvm use`). Since 2026-10-28 it pins `24.22.1` (Ruling R22), so a machine without that version
  needs `nvm install` once; neither command changes the nvm default alias. Before, `24` resolved to the newest
  installed Node 24, and CI's `actions/setup-node` read the same `24` as the newest 24.x (24.22.1 in run 40591493314)
  while the dev machine ran 24.13.0. [V, 2026-10-28, `nvm install 24.22.1`; `gh run view 40591493314 --log`: "node: v24.22.1"]
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
- secretlint's recommended preset (BasicAuth rule) rejects a staged file containing a URL with `user:pass@`, even a
  fake one in a test; such a test input carries `// secretlint-disable-next-line` above it
  (`apps/desktop/src/main/policy/url-rules.test.ts`). [V, 2026-10-28, secretlint 13.0.7, pre-commit hook]
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

- Node's zstd reports truncation on some versions only. Node 24.13.0: a checksummed frame cut by 6 bytes decompressed
  without error through `zstdDecompressSync` and `createZstdDecompress` [V, 2026-10-25, Node 24.13.0, `node -e`].
  Node 24.22.1: the same cut (and a cut at half, and the `invalid-truncated` vector) fails in both APIs with code
  `Z_BUF_ERROR`, errno -5, message "unexpected end of file", raised by `end()` after the decodable output was emitted;
  a frame without the checksum flag still decompresses, and `flush()` on a cut frame does not fail on either version
  [V, 2026-10-28, Node 24.13.0 and 24.22.1: `nvm exec <v> node -e` with
  `const z=require("node:zlib");const f=z.zstdCompressSync(Buffer.alloc(300000).map((_,i)=>i*7919%251),{params:{[z.constants.ZSTD_c_checksumFlag]:1}});try{console.log("out",z.zstdDecompressSync(f.subarray(0,f.length-6)).length)}catch(e){console.log(e.code,e.errno,e.message)}`
  printed `out 262144` on 24.13.0 and `Z_BUF_ERROR -5 unexpected end of file` on 24.22.1]. The `.wgsnap` reader therefore detects truncation itself
  (plan M6, `ZstdFrameWalker` in `packages/snapshot/src/container/zstd-frame.ts`), never ends the decompressor on a
  frame the walker stopped, and lets the walker's verdict win over a decompressor error (Ruling R23,
  snapshot-format.md section 2). Ending instead of flushing lost buffered output on 24.22.1, so a tar defect before the
  cut was missed [V, 2026-10-28: with `decompressor.end()` in place of the flush in `inflate.ts`, `nvm exec 24.22.1
  pnpm exec vitest run packages/snapshot` failed "reports a defect inside the frame before a later container defect,
  for chunks of 64 bytes" while 24.13.0 passed; the fake-decompressor test in `src/container/inflate.test.ts` fails
  under the same mutation on 24.13.0].
- `inflate.ts` ends the readable side of a flushed decompressor with `decompressor.push(null)` from outside the
  Transform. That is off-contract (Node reserves `push` for stream implementers) but safe there: the `flush()` write
  callback fires only after the Transform pushed all output of the bytes written before it, no write follows, and the
  `finally` destroys both streams. [V, 2026-10-28, Node 24.13.0 and 24.22.1: `nvm exec <v> node -e` with the frame `f`
  above and
  `const d=z.createZstdDecompress();let n=0;d.on("data",c=>n+=c.length);d.on("error",e=>console.log("error",e.code));d.on("end",()=>console.log("end",n));d.write(f.subarray(0,f.length-6));d.flush(()=>{console.log("flushed",n);d.push(null)})`
  printed `flushed 262144` and `end 262144`, no error, on both]
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
- WHATWG `new URL` repairs hostile shapes silently: `http://2130706433/`, `http://0x7f.0.0.1/` and `http://127.1/`
  all become host `127.0.0.1`; `https:\\evil.com`, `https:evil.com` and `https:///example.com` parse with that host;
  `https://example.com\@evil.net` has host `example.com` (the backslash starts the path); `https://@evil.com` and
  `https://:@evil.com` drop the empty user info; `https://exa%2Emple.com/` becomes host `exa.mple.com`; tabs and
  newlines inside are dropped, leading and trailing spaces trimmed; `https://example.com.` keeps the trailing dot. So
  `url-rules.ts` refuses those raw shapes before parsing. [V, 2026-10-28, Node 24.13.0, scratch script]
- WHATWG `new URL("app://launcher/x")` has `origin` `"null"` (non-special schemes get an opaque origin) but
  `protocol` `app:` and `host` `launcher`, so the IPC sender check builds the origin from scheme and host. [V,
  2026-10-28, Node 24.13.0, `node -e`]
- Electron IPC payloads are structured clones, so a `Map`, `Set`, `ArrayBuffer`, typed array, `Date` or class
  instance reaches the handler intact; `JSON.stringify` gives `{}` for most of them and zod 4.6.7
  `z.strictObject({})` accepts them (no own enumerable keys), so a JSON size check alone is bypassed (review finding,
  Task 9 fix round 1). A sparse array of length 2^32 − 1 kept `JSON.stringify` busy for about 54 s. `register.ts`
  therefore refuses arrays and non-plain objects before measuring, visiting at most 4 096 values (shared references
  survive structured clone: 7 levels of 10 keys sharing one next object took 568 ms to walk unbounded) inside a
  try/catch. [V, 2026-10-28, Vitest 5.0.5 on Node 24.13.0,
  `apps/desktop/src/main/ipc/register.test.ts` failing before the fix]
- zod 4.6.7: `.refine()` on a `z.strictObject` returns the same `ZodObject` with `def.catchall` of type `never` (no
  wrapper), so a schema walk can check strictness; `.trim()` on a string schema trims the parsed output. [V,
  2026-10-28, `packages/shared/src/ipc.test.ts`; a mutation to `z.object` made it fail]
- tldts 7.4.19 `parse(host, {allowPrivateDomains: true, extractHostname: false})` gives domain `com.` for
  `example.com.` (trailing dot), `null` for `co.uk`, `github.io`, `localhost`, `intranet` and IP literals (`isIp`
  true, also for `[::1]`), `a.github.io` for `a.github.io`, and falls back to the last label for an unknown TLD
  (`domain.unknown`, `sub.localhost`). `siteOf` handles the trailing dot itself. [V, 2026-10-28, same script]
- tldts 7.4.19 gives domain `.com` for `example..com`, `.co.uk` for `a..co.uk`, `.github.io` for `x.a..github.io` and
  `example.com` for `.example.com`, while `new URL` keeps those hosts as they are; so `url-rules.ts` refuses hosts with
  an empty label and `siteOf` uses the whole host for them (Task 7a fix round 1). [V, 2026-10-28, Node 24.13.0,
  `node -e` with `parse(host, {allowPrivateDomains: true, extractHostname: false})`]
- tldts 7.4.19 does not list `itch.io` as a private suffix: `a.itch.io` gives domain `itch.io`, suffix `io`,
  `isPrivate` false, so `a.itch.io` and `b.itch.io` are one site for our policy. [V, 2026-10-28, same `node -e`
  probe] Whether Chromium's schemeful site agrees is Unverified. The PSL snapshot ages with the tldts version, so
  updating tldts is part of dependency upkeep.

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
- Playwright 1.64.1 `_electron.launch` adds its loader (`-r loader.js`, which appends the Chromium switches above with
  `app.commandLine.appendSwitch`, so they are not in `process.argv`) only when no `executablePath` is given; with one,
  no switch is added and partitioning stays on by itself. It adds `--no-sandbox` on Linux unless `chromiumSandbox: true`.
  [V, 2026-10-28, `coreBundle.js` and `loader.js` of `playwright-core` 1.64.1; the desktop partitioning e2e failed with
  `executablePath` set (switch value without the entry) and passed without it]
- The desktop partitioning e2e test fails when `fixPartitioningSwitch` is removed: the cross-site iframe then shows the
  top-level progress hash. [V, 2026-10-28, mutation run on Electron 45.0.0, macOS arm64]
- Electron 45 reports a CSP or Trusted Types violation as a launcher `console-message` with level `error` ("This document
  requires 'TrustedHTML' assignment. The action has been blocked."), so recording that event from window creation
  catches start-up violations; React 19.3.1 under the production CSP with `trusted-types 'none'` produced none. [V,
  2026-10-28, `apps/desktop/e2e/launcher.spec.ts`; security.md section 6]
- `session.fetch("app://launcher/...")` from the main process goes through that session's `protocol.handle`, so e2e
  tests read the launcher's real response headers without a `connect-src`. Electron 45 `console-message` passes one
  event object (`level` is `info`, `warning`, `error` or `debug`); the positional arguments are deprecated. [V,
  2026-10-28, desktop e2e; `electron.d.ts` of 45.0.0]
- electron-vite 6.0.0 has no Electron 45 entry in its Node and Chrome target tables and falls back to 44's (`node24.18`,
  Chrome 152): output is transpiled for a slightly older runtime, harmless. A main-process `if (__WG_FLAVOR__ === "test")
  await import(...)` is dropped from the prod bundle, chunk included. `electron-vite build` has `--outDir` but no
  `--emptyOutDir`. [V, 2026-10-28, `lib-*.js` of electron-vite 6.0.0; `pnpm bundle:check`]
- [A] Linux CI for the desktop suite: Electron runs under `xvfb-run` with Chromium's sandbox on, which on Ubuntu 24.04
  is assumed to need `sysctl kernel.apparmor_restrict_unprivileged_userns=0`, and its system libraries are installed with
  `playwright install-deps chromium`. The suite started and ran there in CI run 40591493314; its only failure was the
  handover test below. [V, 2026-10-28, `gh run view 40591493314 --log-failed`; the sysctl need itself stays [A]]
- Under bare `xvfb-run` no window manager runs, so `BrowserWindow.minimize()` is never applied: `isMinimized()` stayed
  `false` for 5 s in CI run 40591493314 [V, 2026-10-28, `gh run view --log-failed`; the cause is [A], standard X11
  behavior]. The handover e2e test hides the window on Linux instead and keeps minimize on macOS and Windows;
  `focusLauncher` restores and shows, and the hide path fails without its `show()` [V, 2026-10-28, mutation run on
  macOS arm64 with the hide path forced].
- AC-13 holds on Electron 45 with the close procedure: `ServiceWorker.enable` + `ServiceWorker.stopAllWorkers` over
  `webContents.debugger` (attached to the game's `webContents` after it loaded `about:blank`) stopped progress-lab's
  worker; the session had no running worker and the game's renderer was gone 107 to 110 ms after the close (two runs), nothing of the game
  was left 5 s after the close, nothing of the bundle 5 s after a quit with the game open. Mutation control (step 3
  removed): 1 worker running and the renderer alive 5 s after the close (H16). So open check 1 needs no fallback. [V,
  2026-10-28, `e2e/game-lifecycle.spec.ts`, Electron 45.0.0, macOS arm64]
- Chromium canonicalizes a renderer-initiated URL before `will-navigate`: spaces in the query and fragment arrive as
  `%20`, a backslash there arrives raw (`?q=a\b%20c#x\y%20z`). [V, 2026-10-28, `e2e/game-isolation.spec.ts`] Ruling
  R25 (2026-10-28): raw shapes in a main-frame target are refused in its scheme and authority only (security.md
  section 5); entry URLs and `isExternalUrlAllowed` stay strict.
- With the game session's check handler denying `media`, a camera `getUserMedia` failed with `NotFoundError`, not
  `NotAllowedError` as in the spike ([A] the cause: Chromium offered no device because the check denies `media`); `permissions.query({name: "microphone"})` reaches the check
  handler (`denied`) without touching a device. `requestFullscreen()` also triggers a check for `automatic-fullscreen`.
  [V, 2026-10-28, `e2e/game-isolation.spec.ts`, screen locked]
- Under Playwright, a hung game page produced no `unresponsive` event within 90 s of input ([A] Chromium skips the
  hang report while a debugger is attached), so the e2e test emits the event itself against a really hung renderer;
  `forcefullyCrashRenderer` then ends it with `render-process-gone`. [V, 2026-10-28, `e2e/game-lifecycle.spec.ts`]
- Electron 45 does not stop a `window.open` without a user gesture before the window-open handler (it reached the
  handler and was offered), and `HandlerDetails` has no activation flag. [V, 2026-10-28, `e2e/game-isolation.spec.ts`;
  `electron.d.ts`]
- `webContents.sendInputEvent({type: "keyDown", keyCode: "Escape"})` reaches `before-input-event` and the page
  (`keydown`, not `defaultPrevented`), so the Esc-hold e2e test uses it (whether Playwright's CDP keyboard reaches
  `before-input-event` was not checked). Esc ends a
  fullscreen the page requested, and Chromium does not deliver that Esc to the page. An Esc sent at once after
  `isFullScreen()` turned true, while macOS still animated into fullscreen, had no effect in one run [U as a rule].
  [V, 2026-10-28, `e2e/window.spec.ts`, Electron 45.0.0, macOS arm64]
- The e2e harness's `launched.hooks()` is a JSON copy of `globalThis.__wgTest`, so hook functions are dropped: call them
  through `app.evaluate((_electron, id) => globalThis.__wgTest?.fn(id), id)`. [V, 2026-10-28, `e2e/window.spec.ts`]
- Playwright `page.click` and locators wait for "scheduled navigations" to finish, and a navigation the app prevented
  never does (30 s timeout): click through `page.mouse.click` at coordinates read with `page.evaluate`. [V, 2026-10-28,
  Playwright 1.64.1, `e2e/game-isolation.spec.ts` `trustedClick`]
- Pointer lock fails with `WrongDocumentError` while the macOS screen is locked (`ioreg -n Root -d1 -a` shows
  `CGSSessionScreenIsLocked` true; the key is absent when unlocked); the permissions e2e test checks that outcome then
  and annotates "pointer lock not verified". [V, 2026-10-28, run with the owner away] With the screen unlocked pointer
  lock, fullscreen and keyboard lock all SUCCEED in a game window (each after its own injected click, window focused).
  A held pointer lock makes Playwright's next `page.click` fail ("#pointer-lock intercepts pointer events", 30 s
  timeout), so the test releases it (`document.exitPointerLock()`, wait for `pointerlockchange`) before the next
  click; removing that step reproduced the failure. [V, 2026-10-28, `e2e/game-isolation.spec.ts` "permissions", 3 runs
  and the full desktop suite unlocked, Electron 45.0.0, macOS arm64]
- The main log is written asynchronously (queue), so an e2e test must poll for a record (`expect.poll` over
  `eventsNamed`), never read `main.log` once right after a state change: the force-close test did and was flaky. [A,
  2026-10-28, from `logger.ts`; the flake itself was not reproduced, 3 runs of the fixed spec passed]
- `@playwright/test` `webServer.port` is deprecated, use `url`; `pnpm test:e2e --project=chromium` forwards arguments to
  Playwright; `node:http` sends `..` paths byte for byte while `fetch` and `new URL` collapse them, so traversal tests
  use `node:http`. [V, 2026-10-24]
- zsh: `log` is a builtin, call the macOS unified log as `/usr/bin/log`; an unmatched glob aborts the whole command
  (`rm -f a-* b-*` removed nothing when `b-*` matched nothing). [V, 2026-10-24]

- Plain Node 24.13 prints "SQLite is an experimental feature" when `node:sqlite` loads. `scripts/vitest-setup.ts` (a
  Vitest `setupFiles` entry, logic in `scripts/warning-filter.ts`) wraps `process.emitWarning` and drops only that message;
  any other warning, including another ExperimentalWarning, still prints. The earlier `--disable-warning=ExperimentalWarning`
  flag hid all of them and was removed. Electron 45's Node prints none (the desktop e2e records process warnings).
  [V, 2026-10-28, Vitest 5.0.5, Node 24.13.0; `scripts/vitest-setup.test.ts`]
- `node:sqlite` rows are objects with a null prototype (map them in repositories, do not compare them with
  `toStrictEqual`); `DatabaseSync` has `isTransaction`; `PRAGMA user_version` set in a rolled-back transaction rolls
  back too. [V, 2026-10-28, Node 24.13.0, `node` probe]
- A workspace package that is TypeScript source (`@wg-launcher/shared`, `@wg-launcher/snapshot`) must be bundled into the
  main build: electron-vite externalizes `dependencies`, so without `build.externalizeDeps: {exclude: [...]}` Electron
  fails at load with `ERR_MODULE_NOT_FOUND` (`packages/shared/src/index.ts` importing `./errors.js`). `apps/desktop/
  electron.vite.config.ts` lists them in `WORKSPACE_PACKAGES`. [V, 2026-10-28, desktop e2e RED before, GREEN after]
- An ES-module main entry with a top-level `await app.whenReady()` never becomes ready (Electron waits for the module
  before emitting `ready`): use `app.whenReady().then(...)`. [V, 2026-10-28, probe app on Electron 45.0.0]
- Chromium's `--user-data-dir=<dir>` is honored by Electron 45: `app.getPath("userData")` and all of Chromium's files go
  there and the default `<appData>/<productName>` is not created; without it they go to the default. The e2e harness
  passes it for every launch (`appArgs`; `e2e/database.spec.ts` asserts the switch is on the app's command line, and fails
  without it), and its guard (`e2e/real-profile-guard.ts`) compares full listings of the real
  `WGLauncher` and `WGLauncher Dev` directories, after a failed launch as well. A module-load crash alone did not create
  the default directory in a probe (the process only hung); the earlier contamination is therefore not explained
  further. [V, 2026-10-28, Electron 45.0.0, macOS arm64: a throwaway probe app launched with and without the switch through
  Playwright `_electron.launch`; regression test `apps/desktop/e2e/database.spec.ts`]

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
