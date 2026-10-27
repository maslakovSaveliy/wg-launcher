# Phase 1 — Launcher MVP Implementation Plan (vertical scenario, library, snapshots, security)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (owner-chosen). Steps use `- [ ]`.
> Approved by the owner on 2026-10-25; committed on branch `phase-1-launcher` together with the Prerequisite below.
> Task 1 and every later task start only on the owner's explicit word.

**Goal:** A working WGLauncher on macOS arm64: add an HTTPS URL → card in SQLite → own game window with its own
persistent session → progress survives close and reopen → export a `.wgsnap` → restore into a clean session → same
progress (AC-6), plus library, edit, three delete actions, fullscreen, window memory, shortcut, playtime, honest badges
and every MUST of the specs.

**Architecture:** As specified, not redesigned here: [architecture.md](../specs/architecture.md) (processes, IPC, SQLite,
lifecycle), [save-transfer.md](../specs/save-transfer.md) (quiescent window QW-1..10, restore R1–R8),
[snapshot-format.md](../specs/snapshot-format.md) (`.wgsnap`, CBOR profile, vectors), [security.md](../specs/security.md)
(policies, S-1..S-18). This plan decides files, names, interfaces, order, tests and the review-ruled open points (M5–M13).

**Tech stack (exact, re-check with `npm view` before installing):** electron 45.0.0 · electron-vite 6.0.0 · vite 8.3.5 ·
@vitejs/plugin-react 6.1.2 · react / react-dom 19.3.1 (+ @types 19.3.0) · zod 4.6.7 · tldts 7.4.19 (PSL, MIT) ·
electron-builder 26.18.0 · @playwright/test 1.64.1 · `node:sqlite` · `node:zlib` zstd. Verified (2026-10-25, `npm view`)
for versions and licenses (all MIT except Playwright, Apache-2.0).

**Spec:** PRD `docs/product/prd.md` (F-1..F-14, AC-1..AC-25) + the four specs + ADR-0002/0004/0005. Executors read the
spec section a task names; this plan does not repeat it.

## Context
Phase 0 is merged (`main` @ d5a4812): specs, ADRs 0001–0006 accepted, toolchain, CI, `progress-lab`, spike evidence. No
client code exists. ADR-0002 and ADR-0005 are accepted on the condition that Phase 1 re-runs H7 on the launcher against
Chrome; a FAIL reopens both. Owner process (2026-10-25): code and tests only, no new spikes, one review per task, minor
findings batched, repeat runs only for noisy decisive measurements (H7: 3 runs + noise rule), deterministic checks once.

**Scope of the UI (owner decision, 2026-10-25):** this is the first version of the launcher. The goal is working
functionality, not design: the UI is plain and functional (standard controls, minimal styling, no design system, no
visual polish or animations), and UI/UX design comes in a later phase. What still applies to the UI: honest states
(no fake indicators), security rules (text rendering only, strict CSP), every action from the PRD reachable, and clear
confirmations that say what will be lost. Reviews do not reject a task for its look.

## Owner decisions applied in this plan (2026-10-25)
- **UI is functional only in Phase 1:** see "Scope of the UI" above; design and UX are a later phase.
- **Concept document:** replaced by an English translation; the Russian file and the language exception are removed.
- **M5:** a game launch cancels a background storage check (no `GAME_BUSY`); user tasks (export, import, verify, delete
  local saves, clear cache) still refuse a launch with `GAME_BUSY`.
- **M6:** truncation is `SNAP_TRUNCATED`, detected by our own zstd frame walker, because Node does not report it:
  Verified (2026-10-25, Node 24.13.0, run locally: a checksummed frame cut by 6 bytes decompressed without error through
  `zstdDecompressSync` and through `createZstdDecompress`). Vector bytes fixed in Task 4.
- **M7:** the snapshot manifest's top-level zod object is not strict (unknown top-level fields are ignored, snapshot-format
  §4); nested manifest objects and every IPC payload use `z.strictObject`.
- **M8:** "clean session" in AC-6 = a second library entry with the same URL (new `gameId`, new empty
  `persist:game:<id>`). Snapshot PK reuse: `snapshots.revision_id` stays the PK; restoring an already stored revision
  into another game inserts no row (the row keeps the game it was first stored under); `snapshot:list {gameId}` returns
  rows with `game_id = gameId` plus the row of that game's `base_revision_id`.
- **M11:** a few hand-written CBOR vectors (hex written from RFC 8949, not by our encoder) in
  `packages/snapshot/test-vectors/cbor-v1.json`.
- **M13:** shortcut e2e goes through `--launch-game=<id>`; the `wglauncher://` scheme is checked only by hand on the
  packaged app (Task 16).

## My calls (owner can override)
- Branch `phase-1-launcher`, one commit per task (Conventional Commits), PR to `main` at the end; push and merge only on
  the owner's word.
- Build flavors via a compile-time constant `__WG_FLAVOR__`: `dev` (Vite server), `test` (built, unfused, dev origins
  `http://localhost`/`http://127.0.0.1` allowed, test hooks), `prod` (none of those). Test hooks live in
  `apps/desktop/src/main/test-hooks.ts`, are imported only behind `__WG_FLAVOR__ === "test"`, and the release check
  fails if the string `__wgTest` appears in a prod bundle.
- Native dialogs go through one `Dialogs` interface in main; the test flavor lets e2e queue answers. No dialog is
  skipped in prod.
- `electron` stays a devDependency (electron-builder requires it; the runtime's own components are handled under the
  "Electron and Chromium runtime" clause of AGENTS.md). Everything else bundled or packaged is in `dependencies`,
  enforced by a build-time guard (Task 1).
- PSL: `tldts` with `allowPrivateDomains: true`, so `a.github.io` and `b.github.io` are different sites, as Chromium's
  schemeful site is assumed to treat them (Assumed; the exporter's `EXP_STORAGE_KEY_MISMATCH` cross-check against
  `Storage.getStorageKey` catches a disagreement at run time).
- UUIDv7 is our own 20-line function (`node:crypto`/Web Crypto random), not a dependency.
- Should-features F-12 (search, favorites), F-13 (diagnostics) and F-14 (title and cover proposals) are not in Phase 1
  while PRD OQ-5 is open; the title defaults to the host name. No telemetry (OQ-4 default).
- H7 runs with the frozen method by adding a `launcher` runtime to the existing `spikes/runtime-compat/run-timing.mjs`
  (measurement of the real launcher, not a new spike); HYPOTHESES.md stays frozen, RESULTS.md gets a dated section.

## Global Constraints
- AGENTS.md hard rules apply to every task: security invariants 1–9, data-safety invariants 1–9, honesty rules 1–6,
  documentation rules (claim tags, English, no machine paths), YAGNI, dependency policy.
- Exact versions only (`saveExact: true`); new build scripts only through `allowBuilds` (`electron: true` is needed).
- Tools run through `pnpm` / `pnpm exec`. TDD: failing test first, watch it fail for the right reason.
- Every game `webPreferences` value exactly as architecture.md §5; permission allowlist exactly
  `fullscreen`, `pointerLock`, `keyboardLock`.
- IPC: invoke-only, sender check (`app://launcher` main frame), `z.strictObject`, 64 KiB max, lowercase UUIDv7 ids,
  errors `{ok: false, code, message}`; no paths or URLs to open over IPC.
- Limits and codes exactly as snapshot-format.md §8; production values pinned by a unit test.
- Logs through `redact()` only; never values, localStorage key names, record contents, query strings, home paths.
- No install, sync, FPS, download, completion or achievement indicator; progress only from real steps and bytes.
- A game, runtime or OS is "verified" only with a record in `docs/compat/`. Windows code paths are labeled not tested.
- Each task updates the specs it settles, `MEMORY.md` (dated verified facts, gotchas) and its plan checkboxes.

## Review Focus
1. **A game URL that redirects at start** (`https://example.com` → `https://www.example.com`, or to a login host):
   same-site redirects must load, cross-site top-level ones must be offered to the system browser, never followed
   silently. Test in Task 8 (`will-redirect` www → apex allowed, to another site → `ask-external`).
2. **App quit or crash in the middle of an import (R5–R7):** the next start must roll back before any launch. Test in
   Task 14 (fault hook `crash-after:wipe` kills the test app; relaunch shows the pre-import hash and a valid backup).
3. **Play pressed twice, or a deep link while the game is launching:** exactly one window. Test in Task 8.
4. **Save data above a limit:** the export fails with the named `SNAP_*` code, leaves no file in `snapshots/` or `tmp/`,
   writes no row. Test in Task 13 (lowered `maxTotalBytes`).
5. **Disk write failure while a snapshot is written:** `.partial` removed, no row, real error shown. Test in Task 13
   (worker fault hook `fail-write`).

---

### Prerequisite (docs, owner decision 2026-10-25): English concept, no language exception
**Files:** create `docs/product/sources/concept-v1.0.md` (faithful English translation, same structure, header noting
it translates the owner's Russian concept v1.0 of 2026-10-24); delete `docs/product/sources/concept-v1.0.ru.md`;
modify `AGENTS.md` (drop the exception in "Documentation rules"), `.markdownlint-cli2.jsonc` and `biome.json` (drop the
`docs/product/sources` ignores), every reference found by `git grep concept-v1.0.ru` (`.cursor/rules/docs.mdc`,
`CONTRIBUTING.md`, `docs/README.md`, `docs/product/prd.md`, `docs/research/foundations.md`; the Phase 0 plan keeps its
historical text plus a one-line note), `MEMORY.md` (dated decision).
- [ ] Translate; keep the concept's own facts as it states them (it is a source, not a spec).
- [ ] `git grep -n "concept-v1.0.ru\|kept verbatim"` → only the Phase 0 plan note remains; `pnpm docs:lint` and
  `pnpm lint` pass.
- [ ] Commit `docs: replace the Russian concept with its English translation` together with this plan file
  (`docs: add the phase 1 plan`).

### Task 1: Workspace, dependency rule, license gate for our AGPL packages, `packages/shared` base (S)
**Files:** modify `pnpm-workspace.yaml` (`packages: ["apps/*", "packages/*", "fixtures/test-games/*"]`,
`allowBuilds.electron: true` is added in Task 5), `package.json` (`typecheck` lists the new projects),
`scripts/check-licenses.mjs`, `scripts/check-licenses.test.ts`; create `scripts/prod-deps-guard.mjs` (+ test),
`packages/shared/{package.json,tsconfig.json,src/ids.ts,src/result.ts,src/errors.ts,src/index.ts}` with tests.
**Interfaces (Produces):** `uuidv7(now?: () => number, random?: (n: number) => Uint8Array): string`,
`isUuidV7(s: string): boolean` (the lowercase pattern of architecture.md §8);
`type Result<T, C extends string = ErrorCode> = {ok: true; data: T} | {ok: false; code: C; message: string}`;
`ErrorCode` union = IPC codes of architecture.md §6 ∪ `SnapCode` ∪ `ExpCode` ∪ `ImpCode` (every code named in the
specs, as `const` arrays plus types); `prodDepsGuard(pkgJson): VitePlugin` failing the build when a module resolved
from `node_modules` belongs to a package not in that package.json's `dependencies` (name parsed from the resolved id,
scoped names included); `workspacePackageNames(): Set<string>` used by the license gate.
- [x] Test: `uuidv7` gives version nibble 7, variant `8..b`, increasing 48-bit time prefix, passes `isUuidV7`; `isUuidV7`
  rejects upper case, v4, wrong length.
- [x] Test (gate): a report containing `@wg-launcher/shared` with `AGPL-3.0-or-later` passes when it is a workspace
  member and fails when it is not; a GPL dependency *of* a workspace package still fails.
- [x] Test (guard): `node_modules/react/index.js` with `react` only in `devDependencies` → build error naming `react`;
  `node_modules/@scope/x/y.js` handled; a workspace package resolved through its symlink is allowed when listed.
- [x] Run each failing, implement, run passing.
- [x] Real check: `pnpm install`, then `pnpm licenses list --prod --recursive --json` (read without printing paths):
  record in MEMORY.md how our AGPL workspace packages and their deps appear [V, date, command]; `pnpm licenses:check`
  passes; `pnpm check` passes.
- [x] Docs: ADR-0004 action item checked with the result; AGENTS.md repository map lists `packages/shared`.
- [x] Commit `build: add workspace packages and enforce the dependency rule`.

### Task 2: `packages/snapshot` record layer: CBOR profile and value model (M)
**Files:** create `packages/snapshot/{package.json,tsconfig.json}`, `src/record/{cbor.ts,value.ts,idb-key.ts,data-files.ts}`,
tests beside, `test-vectors/cbor-v1.json` (M11).
**Interfaces (Produces):** `type CborItem` = `{k: "uint" | "nint"; v: number} | {k: "float"; v: number} |
{k: "bytes"; v: Uint8Array} | {k: "text"; v: string} | {k: "array"; v: CborItem[]} |
{k: "map"; v: [string, CborItem][]} | {k: "tag"; tag: number; v: CborItem} | {k: "simple"; v: boolean | null | undefined}`;
`encodeItem(item): Uint8Array` (canonical: shortest heads, shortest exact float, `NaN` = `f97e00`, maps sorted by
encoded key bytes); `decodeSequence(bytes, {maxDepth}): CborItem[]` throwing `SnapError("SNAP_RECORD_INVALID")` on any
profile break of snapshot-format §6.2; `checkValueItem(item, refs: BlobRefs): void` (tags and shapes of §6.3);
`toItem(value: unknown, ctx: ToItemContext): Promise<CborItem>` (JS → item; Blob/File bytes hashed with
`crypto.subtle`, handed to `ctx.onBlob(sha256, bytes)`; errors `ExportError` with `EXP_UNSUPPORTED_VALUE`,
`EXP_SHARED_REFERENCE`, `EXP_TOO_DEEP` and `detail.path`, `detail.type` from `Object.prototype.toString`);
`fromItem(item, blobs: (sha256: string) => Blob): unknown`; `compareIdbKeys(a, b): -1 | 0 | 1` (W3C order);
`encodeLocalStorage`, `encodeSchema`, `encodeStoreRecords` and their decoders for §7.1–7.3. Web APIs only (no `node:`
import; a test asserts the source has none).
- [x] Hand-written vectors (M11), `cbor-v1.json` as `[{id, value (test notation of §10), hex, ok}]`, at least: `-0` →
  `f98000`; `NaN` → `f97e00`; `1.5` → `f93e00`; `100000.5` → shortest exact float; `2**53-1` → `1b001fffffffffffff`;
  plain object `{a: 1}` → tag 33101 `d9814d82616101`; `Uint8Array [1,2]` → tag 64 `d84042 0102`; lone surrogate →
  tag 33102; invalid: `1817` (non-shortest head), `fa3fc00000` (float32 holding 1.5 that fits f16), `f93c00` (float
  holding the integer 1), `a2616201616101` (unsorted map), `d9 81af` + any (tag 33199). Hex is computed by hand in the
  test file's comments, never by running the encoder.
- [x] Tests: every hand vector both ways; value model round trip for each row of §6.3 (Date incl. invalid, Map/Set order,
  sparse array with extra props, boxed, RegExp, BigInt, every typed array, DataView, partial view, Blob, File); each
  unsupported type and a shared reference and a cycle give their code and path; `maxDepth` 256 enforced; IDB key order
  number < Date < string < binary < array.
- [x] Run failing, implement, run passing; `pnpm check`.
- [x] Docs: snapshot-format §10 gains the `cbor-v1.json` paragraph (hand-written, language-neutral, Rust must pass it).
- [x] Commit `feat(snapshot): add the deterministic CBOR record codec`.

### Task 3: `packages/snapshot` container: zstd frame walker, ustar, manifest, content hash, validator, writer (L)
**Files:** `src/container/{zstd-frame.ts,ustar.ts,jcs.ts,manifest.ts,content-hash.ts,limits.ts,reader.ts,writer.ts}`, tests.
Node-only (`node:zlib`, `node:crypto`), used only by the snapshot worker.
**Interfaces (Produces):** `DEFAULT_LIMITS` (snapshot-format §8 values); `class SnapError extends Error {code: SnapCode;
path?: string}`; `ZstdFrameWalker` — a streaming parser of the frame header, block headers and the 4-byte checksum that
reports `SNAP_ZSTD_INVALID` (bad magic, skippable frame, dictionary id, window above 2^27), `SNAP_ZSTD_NO_CHECKSUM`,
`SNAP_TRUNCATED` (input ends before the last block and checksum) and `SNAP_TRAILING_DATA` (any byte after the frame),
in front of `zlib.createZstdDecompress({params: {ZSTD_d_windowLogMax: 27}})`; `canonicalJson(value): string` (JCS for the
ASCII/integer/null subset); `ManifestSchema` (zod: top level `z.object`, nested `z.strictObject`, M7);
`computeContentHash(manifest): string`; all exported from the package entry `@wg-launcher/snapshot/container` (R10).
`validateSnapshot(source: AsyncIterable<Uint8Array>, options: {compressedSize: number; limits?: Partial<Limits>}):
Promise<ValidatedSnapshot>` (`ReadOptions`; the caller gives `compressedSize`, the exact byte size of the file, which the
worker takes from `stat` of its private copy in `tmp/`; `SNAP_FILE_TOO_LARGE` is checked from it first and the ratio
limit is max(`ratioFloorBytes`, `maxRatio` × `compressedSize`), R11. Order: container → per-header rules 1–14 →
manifest checks in §4 order → hash → per-entry size/sha256 while streaming → records decoded and checked with Task 2 →
blob references; first failure wins); `readEntries(source, manifest: Manifest, options: {compressedSize: number;
limits?: Partial<Limits>}): AsyncGenerator<{path: string; bytes: Uint8Array}>`: second pass re-checking hashes (R6),
same options; `writeSnapshot(input: SnapshotInput, out: Writable, limits?: Partial<Limits>): Promise<{contentHash:
string; sizeBytes: number}>` (`limits` for tests only; refused input writes nothing).
- [x] Tests: frame walker on real `zstdCompressSync` output with and without checksum, cut at 1, half and length−1 bytes
  (all `SNAP_TRUNCATED`), with a skippable frame, a second frame, a byte appended; ustar rules 1–14 each from a crafted
  header; JCS rejects whitespace and duplicate keys via re-serialization; manifest check order (a `formatVersion` 2
  manifest with extra whitespace gives `SNAP_UNSUPPORTED_VERSION`); unknown top-level field ignored and not hashed,
  unknown nested member rejected (M7); ratio check only past `ratioFloorBytes`; writer output validates; nothing is
  written by the validator (it has no sink).
- [x] Run failing, implement, run passing; `pnpm check`. (`manifest.ts` had no RED run before it was written;
  some suites passed at once and were mutation-checked after the fact; see the Task 3 report.)
- [x] MEMORY.md: Node zstd truncation gotcha [V, 2026-10-25]; snapshot-format §2 and §8 state that truncation is detected
  by the frame walker (M6).
- [x] Commit `feat(snapshot): add the wgsnap container reader and writer`.

### Task 4: Golden vectors: generator, committed files, runner (M)
**Files:** `packages/snapshot/scripts/generate-vectors.ts`, `test-vectors/v1/index.json` and one directory per vector,
`src/vectors.test.ts`, `test/notation.ts` (test notation ⇄ `CborItem`); done with `test/content.ts` (`content.json` ⇄
data files, shared by generator and runner) and an extended `test/wgsnap.ts` (`linkname`, `listTar`).
- [x] Generator writes the 31 vectors of snapshot-format §10 plus `invalid-truncated-tar`; invalid ones as raw bytes.
  **M6 bytes:** `invalid-truncated` = the `input.wgsnap` of `valid-binary-types` with only its first
  `floor(length / 2)` bytes (a compressed file cut mid-frame; the walker gives `SNAP_TRUNCATED`);
  `invalid-truncated-tar` = a complete checksummed zstd frame whose tar ends 100 bytes into the data of the second
  entry (the tar reader gives `SNAP_TRUNCATED`). zstd output is not compared, so the cut length is recorded in
  `vector.json` `description`.
- [x] Runner: fails on a missing or an unlisted directory and on unknown `vector.json` members; valid vectors decode to
  `content.json` and re-encode to the same entry paths, hashes and `contentHash`; invalid vectors give exactly their code.
- [x] Generate once, commit the files, run the runner twice (deterministic); `pnpm check`.
- [x] Docs: snapshot-format §10 table gains `invalid-truncated-tar` and the exact M6 cut rule.
- [x] Commit `test(snapshot): add frozen golden vectors`.

### Task 5: `apps/desktop` skeleton: build, flavors, app protocol, launcher window, logs, e2e harness, CI (L)
**Files:** `apps/desktop/{package.json,tsconfig*.json,electron.vite.config.ts,playwright.config.ts}`,
`src/main/{index.ts,flavor.ts,paths.ts,start-up.ts,app-protocol.ts,launcher-window.ts,dialogs.ts,test-hooks.ts}`,
`src/main/log/{logger.ts,redact.ts}`, `src/preload/launcher.ts`, `src/renderer/{index.html,main.tsx,App.tsx}`,
`e2e/{harness.ts,launcher.spec.ts}`; modify `pnpm-workspace.yaml` (`allowBuilds.electron: true`), root `package.json`
(`test:e2e` runs the fixture and the desktop suites), `.github/workflows/ci.yml` (desktop e2e on macOS and on Ubuntu under
`xvfb-run`, labeled "proves the build and tests, not game compatibility").
**Interfaces (Produces):** `FLAVOR: "dev" | "test" | "prod"`; `appPaths(userData): {db, covers, snapshots, backups, tmp, logs}`
(architecture §3; `tmp/` emptied at start-up; userData from `WG_USER_DATA` in the test flavor only);
`createLogger(logsDir)` (`logs/main.log`, rotated 5 files × 5 MiB, every record through `redact`);
`registerAppScheme()` before `ready` (privileges exactly security §6) and `handleAppProtocol(session, rendererDir, coversDir)`
(containment check, CSP and headers of security §6, 404 otherwise); `fixPartitioningSwitch(argv)` (re-appends
`--disable-features` without `ThirdPartyStoragePartitioning`, architecture §5); `redact(record): record` (security §9);
`interface Dialogs {confirm(spec): Promise<boolean>; openFile(spec): Promise<string | null>; saveFile(spec): Promise<string | null>}`;
`launchApp(opts): Promise<{app: ElectronApplication; launcher: Page}>` in `e2e/harness.ts` (temp userData, test build,
progress-lab server on a free port). electron-vite: main (`externalizeDeps` default, worker via `?modulePath`), preload
with `isolatedEntries: true, externalizeDeps: false` (launcher bridge now, quiescent preload in Task 13), renderer with
React; `prodDepsGuard` on all three; electron-builder `files` excludes packages already fully bundled into the renderer
(react, react-dom, scheduler) so they are not shipped twice.
- [x] Tests (unit): `redact` (URL → origin, home → `~`, `Authorization`/cookie dropped, deep-link input → length);
  protocol path containment (`..`, `%2e%2e`, absolute, cover name pattern); `fixPartitioningSwitch` keeps other features.
- [x] Tests (e2e): app starts, launcher page served from `app://launcher` with the CSP header; no CSP violation report
  during start-up (S-15 part, decides the Trusted Types open check); a second instance exits and focuses the first;
  under Playwright the iframe partitioning check of progress-lab's `iframe-host.html` shows partitioned storage.
- [ ] Run failing, implement, run passing; `pnpm check`; `pnpm test:e2e`; CI green on the pushed branch only when the
  owner approves the push. (Local part done 2026-10-28; CI not run, nothing pushed.)
- [x] MEMORY.md: Electron install under pnpm, React 19 under `trusted-types 'none'` result [V], Linux xvfb note.
- [x] Commit `feat(desktop): add the app skeleton, launcher protocol and e2e harness`.
- Notes (2026-10-28): `electron@45.0.0` has no install script, so no `allowBuilds` entry was added (the binary is
  downloaded on first use; CI runs `install-electron`). `fixPartitioningSwitch` takes `app.commandLine`, since
  Playwright appends its switches there. The electron-builder `files` exclusion moves to Task 16, which adds
  electron-builder. Open check 6 is settled: React 19 runs under `trusted-types 'none'` (security.md section 6).
  Fix round 1 (2026-10-28): the guard is `apply: "build"` (it broke the dev server); the test flavor never reads
  Electron's default userData (reading it created an empty real `WGLauncher` directory), guarded by the e2e harness;
  the dev flavor was run once and verified (security.md section 6).

### Task 6: SQLite database, migrations, repositories (M)
**Files:** `src/main/db/{database.ts,migrate.ts,migrations/001-initial.sql}`, `src/main/db/repos/{games.ts,window-state.ts,
play-sessions.ts,storage-targets.ts,snapshots.ts,restore-journal.ts,storage-checks.ts,orphans.ts,settings.ts,device.ts}`, tests.
**Interfaces (Produces):** `openDatabase(path, {now}): Db` (WAL, foreign keys, `synchronous = FULL`; copies the file to
`backups/library-v<n>-<time>.db` before migrating; opens read-only and returns `{readOnly: true, reason}` when
`user_version` is newer); one repo object per table with small typed methods (e.g. `games.insert(row)`,
`games.update(id, patch)`, `snapshots.listForGame(gameId, baseRevisionId)` implementing M8,
`snapshots.findByRevision(id)`). Schema exactly architecture §7.
- [x] Tests (Vitest, `node:sqlite` in Node 24): migration from empty sets `user_version` 1; a failing migration leaves
  `user_version` 0 and the backup copy; newer version → read-only; M8 listing; `games` delete cascades window state and
  sessions but keeps `snapshots`, `storage_targets`; a statement-time budget check over 1 000 games stays under 5 ms per
  query (Assumed budget, recorded, not a product number).
- [x] Run failing, implement, run passing; check in e2e that the app opens the DB in Electron's main without a warning.
- [x] Commit `feat(desktop): add the library database`.
- Done as ruled: R18 (the 5 ms budget is checked by `EXPLAIN QUERY PLAN` on every hot-path statement, over 1 000
  games, with no wall-clock assertion) and R19 (workspace packages are bundled into the main build; the e2e harness
  passes `--user-data-dir` and its real-profile guard compares a full listing, also after a failed launch). The
  harness hardening is its own commit, `test(desktop): keep e2e runs off the real userData even when start-up crashes`.

### Task 7a: Security policies as pure functions (M)
**Files:** `src/main/policy/{site.ts,url-rules.ts,permissions.ts,deep-link.ts}`, tests.
**Interfaces (Produces):** `siteOf(origin: string): string`; `checkEntryUrl(input: string, flavor): Result<string,
"URL_NOT_ALLOWED">` (architecture §12); `decideTopNavigation(entryUrl: URL, target: string, flavor): "allow" |
"ask-external" | "block"`; `decideFrameNavigation(target: string): "allow" | "block"`; `isExternalUrlAllowed(url: string):
boolean`; `decidePermission(name: string): "allow" | "deny"`; `parseLaunchInput(argv: readonly string[]): LaunchInput`
and `parseDeepLink(url: string): LaunchInput` with `LaunchInput = {kind: "launch"; gameId: string} | {kind: "invalid";
length: number} | {kind: "none"}` (one argument that is a whole deep link or `--launch-game=<id>`, rest ignored).
- [ ] Tests: the full S-5 list of security §5 (`javascript:`, `file:`, `wglauncher:`, `app:`, userinfo tricks, IDN
  lookalike in punycode, `example.com.evil.net`, `evil-example.com`, http vs https, `co.uk` siblings, `github.io`
  siblings, spaces and upper case, over-long); redirect www ↔ apex allowed (Review Focus 1); permission table incl. an
  unknown future name; deep-link pattern accepts only lowercase UUIDv7 with no query, fragment, port or userinfo; argv
  with extra `--` switches or spaces cannot inject anything (S-11).
- [ ] Run failing, implement, run passing.
- [ ] Commit `feat(desktop): add URL, permission and deep-link policies`.

### Task 7b: Product policies as pure functions (S)
**Files:** `src/main/policy/{playtime.ts,badges.ts,window-guard.ts}`, tests.
**Interfaces (Produces):** `createPlaytime(nowMs: number): {on(e: PlaytimeEvent, nowMs: number): void; activeMs(nowMs: number): number}`
(events of architecture §10); `keepSession(activeMs: number): boolean` (≥ 10 000); `badgesFor(r: BadgeRecord): Badge[]`
(architecture §11; `BadgeRecord = {supportMode; lastCheck: {hasData; checkedAt} | null; verifiedExporterVersions: string[];
runningExporterVersion}`); `restoreBounds(saved: SavedWindow | null, displays: DisplayArea[]): Bounds` (100 × 50 overlap,
default 1280 × 800 centered on the primary).
- [ ] Tests: AC-15 with a fake clock (blur, minimize, suspend, lock each stop; 9 999 ms dropped, 10 000 kept); AC-14 each
  badge in each state, "Compatibility not verified" always; off-screen guard cases (display removed, partly visible).
- [ ] Run failing, implement, run passing.
- [ ] Commit `feat(desktop): add playtime, badge and window-state rules`.

### Task 8: Game windows, sessions, lifecycle, locks, close procedure (L)
**Files:** `src/main/games/{window-factory.ts,game-session.ts,lifecycle.ts,locks.ts,close-procedure.ts,frames.ts}`, e2e
`e2e/game-isolation.spec.ts`, `e2e/game-lifecycle.spec.ts`; test pages under `apps/desktop/e2e/pages/` only where
progress-lab cannot serve the case (permissions, popups, downloads).
**Interfaces (Produces):** `gameWebPreferences(gameId): WebPreferences` (every key of architecture §5);
`gameSession(gameId): Session` (handlers of security §5, rate-limited denial logs, download refusal, device refusals);
`installBaselineHandlers(app)` (`session-created`, `web-contents-created`); `class LockManager {acquire(gameId, kind:
"session" | "task" | "background"): Promise<Lease | {code: "GAME_RUNNING" | "GAME_BUSY" | "NEEDS_RECOVERY"}>}` where a
`session` request aborts a `background` lease through its `AbortSignal` and waits for its release (M5; at most 2 s, then
`INTERNAL` logged); `GameRuntime.launch(gameId)` / `.focus` / `.closeAll()` with the state machine of architecture §4;
`closeGameWindow(win, deps)` = the 4-step close procedure (about:blank, debugger `ServiceWorker.enable` +
`stopAllWorkers`, wait `getAllRunning()` empty ≤ 2 s, `stopWorker` per version, `SW_STOP_FAILED`, destroy);
`recordFrames(webContents, repo)` (`did-frame-navigate` → `storage_targets`).
- [ ] Unit: `gameWebPreferences` asserts every value (S-1); `LockManager` matrix incl. M5 (background cancelled with
  `CANCELLED`, no `GAME_BUSY`; task holds → `GAME_BUSY`; recovery → `NEEDS_RECOVERY`).
- [ ] e2e: AC-2/S-3 (two entries with the same URL: localStorage, IndexedDB and cookie markers not shared; launcher
  session distinct); AC-3/S-2 (`typeof require`, `typeof process`, bridge `undefined`); AC-4/S-4 (five denied and logged,
  three allowed, each after its own injected click, pointer lock first, focus checked); AC-5/S-5 (off-site navigation,
  `window.open` → deny + confirm dialog queued, download cancelled); Review Focus 1 and 3 (double Play, deep link during
  `launching` → one window); S-7 (a `beforeunload` trap asks through the queued dialog and cannot block closing;
  `unresponsive` → "Force close" via `forcefullyCrashRenderer`; `render-process-gone` → `crashed`); AC-13/S-9 (process list before, with the game open, 5 s after close, 5 s after quit; with
  progress-lab's service worker registered).
- [ ] Run failing, implement, run passing. If `stopAllWorkers` through `webContents.debugger` does not stop the worker
  (open check 1), stop, record the evidence, and ask the owner which fallback to take.
- [ ] MEMORY.md and architecture §4: the AC-13 outcome [V].
- [ ] Commit `feat(desktop): add isolated game windows and their lifecycle`.

### Task 9: IPC contract, launcher bridge, library UI (L; UI functional only, no design work)
**Files:** `packages/shared/src/ipc.ts` (channel table of architecture §6 as zod schemas + types), `src/main/ipc/{register.ts,
sender-check.ts,handlers/library.ts,handlers/game.ts,handlers/settings.ts}`, `src/preload/launcher.ts`,
`src/renderer/{App.tsx,library/*.tsx,dialogs/*.tsx,settings/*.tsx,api.ts}`, covers handling `src/main/covers.ts`, e2e
`e2e/library.spec.ts`.
**Interfaces (Produces):** `IpcContract` (channel → `{request: ZodType; response: ZodType}`), `window.wg` with one typed
function per channel plus `onGameState(cb)` and `onTaskProgress(cb)`; `checkSender(event, launcherWc): boolean`;
`setCover(gameId, path): Promise<Result<string>>` (PNG/JPEG/WebP magic bytes, ≤ 10 MiB, `covers/<gameId>-<random>.<ext>`).
- [ ] Unit (S-10): wrong sender, subframe, wrong origin, unknown key, oversize payload, upper-case id → rejected,
  `IPC_FORBIDDEN_SENDER` logged once; every schema is a `z.strictObject`.
- [ ] e2e: AC-17 (edit title and cover keeps `gameId` and partition; `ftp:`/`http://example.com` rejected; dev origins
  only in the test flavor); add the same URL twice → warning, then a second entry; AC-1 part (restart → same title, URL,
  cover, `gameId`; Play opens it); remove from library → card gone, row in "Data of removed games" (settings), snapshots
  kept; a title `<img src=x onerror=…>` renders as text (S-15).
- [ ] Run failing, implement, run passing.
- [ ] Commit `feat(desktop): add the library UI and IPC contract`.

### Task 10: Window state, fullscreen, playtime and badges wired (M)
**Files:** `src/main/games/{window-state.ts,fullscreen.ts,playtime-recorder.ts}`, `src/main/library/badges-view.ts`, e2e
`e2e/window.spec.ts`.
- [ ] Window state saved on close and debounced 500 ms on move/resize; restored through `restoreBounds`; menu item role
  `togglefullscreen` and a UI control; launcher-set fullscreen exits with toggle, UI or Esc held 1.5 s (`before-input-event`
  observes, never `preventDefault`s Esc; short Esc reaches the page: e2e asserts the page saw keydown Esc).
- [ ] Playtime: checkpoints every 60 s, `last_launched_at` on launch, < 10 s deleted at close and at start-up.
- [ ] e2e: AC-18 automated part (bounds and fullscreen restored; toggle; short Esc reaches the game); card shows playtime
  and badges from DB state only (AC-14 automated part).
- [ ] Run failing, implement, run passing. Manual AC-18 real-input check goes to Task 16's checklist.
- [ ] Commit `feat(desktop): remember windows, add fullscreen and playtime`.

### Task 11: Shortcuts and deep links (S)
**Files:** `src/main/{launch-input.ts,shortcuts.ts}`, e2e `e2e/shortcut.spec.ts`.
- [ ] `open-url` registered before `ready`, queued until the window manager is up; `second-instance` argv parsed with
  `parseLaunchInput`; valid known id → focus or open; unknown → library with "not in the library"; malformed → library
  with an error, nothing navigated.
- [ ] `shortcut:create`: macOS `.webloc` (only the id varies); Windows `shell.writeShortcutLink` with the options of
  architecture §8 (unit-tested args, labeled not tested on Windows). Dev and test builds never call
  `setAsDefaultProtocolClient`.
- [ ] e2e (M13): launching with `--launch-game=<id>` opens that game; a second instance with the argument focuses the
  existing window; malformed and unknown ids (AC-19 automated part). Scheme handling → Task 16 manual.
- [ ] Commit `feat(desktop): add shortcuts and launch arguments`.

### Task 12: `packages/exporters`: generic frame exporter and importer, adapters, flush decision (L)
**Files:** `packages/exporters/{package.json,tsconfig.json,playwright.config.ts}`, `src/{frame-exporter.ts,frame-importer.ts,
inventory.ts,key-generator.ts,protocol.ts,flush.ts}`, `src/adapters/{schema.ts,progress-lab.json}`, tests: unit
(`flush.test.ts`, `schema.test.ts`) and browser (`browser/*.spec.ts` in Playwright Chromium against progress-lab, with
the partitioning override of its config).
**Interfaces (Produces):** the `FrameExporter`, `FrameInventory`, `FrameScope` shapes of save-transfer §3;
`createFrameExporter(env: FrameEnv): FrameExporter` (`FrameEnv = {localStorage; indexedDB; crypto}`);
`EntrySink {write(path: string, bytes: Uint8Array): Promise<void>}`, `EntrySource` (async iterator of `{path, bytes}`);
`FrameCommand` / `FrameReply` zod schemas (`inventory`, `export`, `import`, `wipe-selected`, with 128-bit request nonces);
`decideFlushState(o: FlushObservation): "confirmed" | "unconfirmed"`; `parseAdapter(json): Adapter` (closed schema of §8).
- [ ] Browser tests: export progress-lab after 7 steps, import into a fresh context, progress-lab's own `#progress-hash`
  equal; Date/ArrayBuffer/Uint8Array/Blob preserved (AC-7 value part); key-generator probe twice → same `keyGenerator`
  and same `contentHash` (open check 2: Chromium reverting on abort); after import the next `add` key equals the
  exported generator; `IMP_TARGET_NOT_EMPTY`; a quota error maps to `IMP_QUOTA_EXCEEDED` (lowered quota via a fake
  `localStorage`); exporter never touches `document.cookie`/`cookieStore` (spy).
- [ ] Unit: AC-12 `decideFlushState` (none, success, error, timeout, non-`true`, input after start, late close);
  adapter schema rejects unknown members, regex-like strings are plain prefixes, `module` pattern.
- [ ] Run failing, implement, run passing. If the probe is unstable, apply the save-transfer fallback (highest key + 1)
  and record it.
- [ ] Commit `feat(exporters): add the generic web storage exporter`.

### Task 13: Quiescent job runner, snapshot worker, export (L)
**Files:** `src/main/snapshots/quiescent/{job.ts,interceptor.ts,stub.ts,canary.ts,handshake.ts}`,
`src/main/snapshots/{export.ts,storage-check.ts}`, `src/main/worker/snapshot-worker.ts`, `src/preload/quiescent.ts`, IPC
`handlers/snapshots.ts` (export, list, saveAs), e2e `e2e/export.spec.ts`, integration specs `e2e/quiescent.spec.ts`.
**Interfaces (Produces):** `runQuiescentJob(gameId, plan: JobPlan, deps: JobDeps, signal?: AbortSignal):
Promise<Result<JobOutcome>>` implementing save-transfer §5 steps 1–12 exactly; `exportSnapshot(gameId, opts):
Promise<Result<SnapshotRow>>`; `runStorageCheck(gameId, signal): Promise<Result<StorageCheck>>` (holds a `background`
lease, M5); worker message protocol `WorkerCommand` / `WorkerEvent` (zod) over `MessagePort`; worker fault hook
`fail-write` (test flavor).
- [ ] Unit: interceptor answers only the job's exact stub URLs, 403 empty body otherwise, no passthrough (QW-1); each
  step throws once → nothing stays registered (QW-3); handshake rejects wrong `webContents`, wrong frame URL, wrong or
  short nonce (QW-4); stub headers and CSP (QW-10); log lines contain no values or key names (QW-9).
- [ ] e2e/integration: export progress-lab plain, with service worker, cross-site iframe; canary flags an injected
  main-world script and a started worker; **the no-bypass iframe control** (open check 3); AC-11 (export refused while the
  window is open); AC-20/S-17 (snapshot of a session with cookies, Cache Storage and a worker contains none);
  Review Focus 4 and 5; manifest `flushState` `unconfirmed`; M5 (launch during a running storage check cancels it).
- [ ] Run failing, implement, run passing.
- [ ] MEMORY.md, save-transfer §5: outcome of the iframe bypass control and of `usageDetails` in an isolated world [V].
- [ ] Commit `feat(desktop): export snapshots through the quiescent window`.

### Task 14: Restore R1–R8, rollback, recovery, storage-key mapping, delete local saves, clear cache, verify (L)
**Files:** `src/main/snapshots/{restore.ts,journal.ts,key-check.ts,recovery.ts,delete-saves.ts,clear-cache.ts,verify.ts,
faults.ts}`, IPC handlers (import, verify, deleteSaves, clearCache, deleteOrphanData), integration specs `e2e/restore.spec.ts`,
`e2e/keys.spec.ts`, `e2e/delete.spec.ts`.
**Interfaces (Produces):** `runRestore(req: RestoreRequest, deps: RestoreDeps): Promise<Result<RestoreOutcome>>` with
`RestoreStep = "validate" | "plan" | "lock" | "backup" | "wipe" | "import" | "verify" | "commit"`, journal written before
each step, `deps.faults?: (step: RestoreStep) => void` (test flavor; also `crash-after:<step>` exits the process);
`checkStorageKeys(manifestKeys, target: TargetKeys, mapping?: KeyMapping[]): Result<CheckedKeys, "IMP_STORAGE_KEY_MISMATCH">
& {unchecked: StorageKey[]}`; `recoverAtStartup(deps)` before any launch; `deleteLocalSaves`, `clearCache`,
`verifySnapshot(gameId, revisionId)` (into `wg-verify-<nonce>`, sets `verified_at` and `verified_exporter_version`).
- [ ] Unit: key-check table of save-transfer §2 (top, partitioned, frame, unchecked, mapping incl. self-mapping); expected
  hash after a mapping (snapshot-format §5) renumbers `data/<k>/`.
- [ ] Integration: AC-8 (fault at validate, lock, backup, wipe, import, verify → progress hash and inventory equal the
  pre-import state, backup validates); failed rollback → `needs_recovery`, launch refused naming the backup, "Retry
  recovery" works; Review Focus 2 (crash after wipe → recovered at next start); AC-24/S-16 (progress-lab on `localhost`
  with a `127.0.0.1` iframe restored under changed keys → refused naming both, nothing written; with a confirmed mapping
  every record lands under the mapped key; moved iframe; target without frame observations asks and writes nothing
  without consent); `IMP_REVISION_CONFLICT`; M8 (restore revision of entry A into entry B adds no row, B's base moves);
  AC-16 (delete local saves makes and verifies a backup, then wipes; clear cache leaves data, and open check 4 —
  `clearStorageData` without origin reaches partitioned cache keys — is asserted here); verify sets "Export verified".
- [ ] Run failing, implement, run passing.
- [ ] Commit `feat(desktop): restore snapshots with backup and rollback`.

### Task 15: Snapshot UI and the vertical scenario (M)
**Files:** `src/renderer/snapshots/*.tsx`, `src/renderer/library/GameMenu.tsx` (three delete actions, export, import,
verify, save as, shortcut), `src/renderer/recovery/*.tsx`, e2e `e2e/vertical.spec.ts`.
- [ ] UI (functional only, no design work; see "Scope of the UI"): snapshot list with "flush unconfirmed" on every `unconfirmed` row (never "save point", "guaranteed",
  "complete"); export dialog lists cross-site frame origins with data, unticked; import source = this game's snapshots,
  snapshots of entries with the same origin, or a file; mapping confirmation in a native dialog written by main; task
  progress from real steps and bytes only; `needs_recovery` banner.
- [ ] e2e AC-6: add `http://localhost:<port>/` → Play → 7 × `#play-step` → hash H → close → reopen → H → close → export
  → add the same URL again (entry B, clean session) → import A's snapshot into B → launch B → H; then restart the app and
  launch B → H (AC-1 part). AC-7 e2e: the same through the UI for the service-worker and iframe variants.
- [ ] UI text test: no element anywhere shows install, sync, FPS, download, completion or achievement wording (AC-14).
- [ ] Run failing, implement, run passing; `pnpm check` and `pnpm test:e2e` green.
- [ ] Commit `feat(desktop): add the snapshot UI and the vertical scenario`.

### Task 16: Packaging, release check, manual check of the packaged app on macOS arm64 (M, owner at the machine)
**Files:** `apps/desktop/electron-builder.yml`, `apps/desktop/build/after-pack.mjs` (removes `NSCameraUsageDescription`,
`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` and the Bluetooth descriptions), `apps/desktop/scripts/
release-check.mjs` (+ unit test on a fixture plist/bundle listing), `docs/compat/manual-checks/<date>-macos-arm64.md`.
- [ ] `electronFuses` exactly security §4; `protocols: [{name: "WGLauncher", schemes: ["wglauncher"]}]`; ad-hoc signing
  (`identity: null`, then `codesign --force --deep --sign -`), no notarization.
- [ ] `release-check.mjs` (S-14): reads fuses (`@electron/fuses` read API), `Info.plist` (no media/Bluetooth usage
  descriptions, `CFBundleURLTypes` has `wglauncher`), no `__wgTest` in the bundle, renderer deps not duplicated.
- [ ] **Warn the owner first** (windows open, macOS prompts may appear, ~30–45 min, owner needed at the keyboard).
  Manual checklist, each result recorded with date, versions, machine: deep link not running / running / second
  instance (AC-19); `.webloc` shortcut opens the game; media with the macOS microphone and camera permission undecided,
  denied, granted → `NotAllowedError`, no OS prompt, app keeps running (security §5 item 3; open check 5); real-input
  fullscreen, pointer lock, keyboard lock, Esc hold (AC-18, H13 manual); process list after close and quit (AC-13 manual).
- [ ] If removing the usage descriptions makes macOS kill the process, stop and ask the owner (security open question).
- [ ] Commit `build(desktop): package the app and add the release check`.

### Task 17: H7 on the launcher against Chrome (with H8 Chrome side, H9, demo frame samples) — hands-off
**Files:** `spikes/runtime-compat/run-timing.mjs` (add runtime `launcher`: drives the packaged test-flavor app with
`--launch-game=<id>` of an entry pointing at the spike scene), `spikes/runtime-compat/results/*.json`, `RESULTS.md`
(dated Phase 1 section), `docs/compat/matrix.md` (regenerated), ADR-0002 and ADR-0005 status.
- [ ] Wiring check with tiny durations (no result).
- [ ] **STOP: READY_FOR_HANDS_OFF.** Tell the owner: total ≈ 45–60 min (calibration, 3 alternating runs per runtime,
  a 5-run rerun if Chrome's p95 spread ≥ 15 %, H8 cold/warm, H9 60 s each, six demos); do not touch the Mac, keep the
  screen unlocked, connect power; Chrome is 155 unless the owner updates it to 156 (else the label "version mismatch").
  Wait for "ок".
- [ ] Run with the frozen method; apply the noise rule; record PASS / FAIL / INCONCLUSIVE / INVALID exactly as ADR-0002.
- [ ] FAIL or no verdict → stop and report; ADR-0002 and ADR-0005 are reopened by the owner, not by the agent.
- [ ] Commit `spike(runtime-compat): measure H7 on the launcher against Chrome`.

### Task 18: Compatibility record, docs close-out, pull request (S)
- [ ] `docs/compat/matrix.md`: launcher rows only for real runs (progress-lab through the launcher, the manual checks of
  Task 16, the H7 outcome); "not tested" rows unchanged for Windows, Linux and real games.
- [ ] README status and limitations, PRD acceptance table states which AC passed and how (AC-21, AC-22 manual review),
  specs' open questions closed or kept, ADR action items checked, MEMORY.md current, AGENTS.md repository map.
- [ ] Ask the owner whether to archive or delete `spikes/runtime-compat/` now that H7 is recorded (MEMORY decision).
- [ ] `pnpm check`, `pnpm test:e2e`, release check; whole-branch review; PR with the real outputs pasted (push only on
  the owner's word).

## Open checks from the specs, each with its fallback

| # | Check (where it is settled) | Fallback if it fails |
| --- | --- | --- |
| 1 | `ServiceWorker.stopAllWorkers` through `webContents.debugger` stops the game's worker on close (Task 8, AC-13) | Owner decides: unregister the game's workers on close (offline games re-download) or accept a longer AC-13 window |
| 2 | Chromium reverts the key generator on an aborted probe (Task 12) | Record highest numeric key + 1; document the difference |
| 3 | The page-level service-worker bypass covers cross-site iframes (Task 13, no-bypass control) | Per-child-target bypass is already sent; if a worker still starts, the canary aborts the job and the iframe variant is refused with `EXP_QUIESCENCE_VIOLATION` |
| 4 | `ses.clearStorageData` without `origin` reaches partitioned cache keys (Task 14) | Clear each known key with CDP `Storage.clearDataForStorageKey` and cache storage types |
| 5 | Packaged app: media denied without an OS prompt in all three TCC states (Task 16) | Keep the usage descriptions and rely on the handlers, accepting a possible OS prompt (owner decides) |
| 6 | React 19 runs under `trusted-types 'none'` (Task 5): settled 2026-10-28, it does (security.md section 6) | Allow one named policy, keep `require-trusted-types-for 'script'` |
| 7 | `node:sqlite` runs without a warning in Electron 45 main (Task 6) | better-sqlite3 13.0.3 per ADR-0004 revisit trigger |
| 8 | `usageDetails` available in an isolated world (Task 13) | Omit `notExported`; "Local data" from counts only (badge may be absent for OPFS-only data) |
| 9 | Esc ends a page-requested fullscreen in Electron 45 (Task 10) | Document; the launcher still never takes Esc |
| 10 | `.webloc` with `wglauncher://` opens the packaged app (Task 16) | Offer "copy launch link" instead of a macOS shortcut file |
| 11 | Windows shortcut and deep link (no machine) | Code and unit tests only, labeled not tested |

## Estimates (honest, rough)
Sizes: S ≈ 1–2 h, M ≈ 2–4 h, L ≈ 4–8 h of agent work per task including its review; Tasks 13 and 14 are the riskiest and
may double. Total ≈ 50–80 h of agent work, spread over several sessions. Owner time: plan and per-task reviews, the Task 16
manual check (≈ 30–45 min at the machine), the Task 17 hands-off run (≈ 45–60 min, plus set-up).

## Verification (end-to-end for Phase 1)
`pnpm check` · `pnpm test:e2e` (fixture + desktop, AC-6 among them) · golden vectors runner · `release-check.mjs` on the
packaged app · manual checklist file of Task 16 · H7 record of Task 17 · CI green on the PR (macOS, Ubuntu, Windows unit).
