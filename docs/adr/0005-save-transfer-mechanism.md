# ADR-0005: Save transfer mechanism

**Status:** Accepted for the Electron runtime of ADR-0002 (Proposed only on H7, a frame-time criterion that does not
touch this mechanism).

**Date:** 2026-10-24

**Deciders:** owner (maslakovSaveliy); drafted by AI agent

Conventions: [ADR-0000](0000-template.md#conventions). Exact procedures are normative in
[save-transfer.md](../specs/save-transfer.md) (QW-1 to QW-10, restore steps R1 to R8) and the file format in
[snapshot-format.md](../specs/snapshot-format.md); this ADR records why.

## Context

- Saves live in localStorage and IndexedDB (including Emscripten IDBFS) of each game's partition and must be exported
  and restored without reading live profile files and without running game code. `Owner`
  ([AGENTS.md](../../AGENTS.md#data-safety-invariants) invariants 1 to 5; [PRD](../product/prd.md) section 10)
- CDP's IndexedDB domain can read and delete but has no put or add, so it cannot restore. Verified (2026-10-24,
  [runtime-and-storage.md](../research/runtime-and-storage.md) section 5.1)
- Storage calls from an isolated world reach the page's own storage with structured clone (Chrome documentation;
  Verified (2026-10-24, runtime-and-storage.md section 5.2)); the spike showed it in Electron 45 (H14 below).
- Since Chrome 115 a cross-site iframe's storage is keyed by its origin plus the top-level site. Verified (2026-10-24,
  runtime-and-storage.md section 5.5)

## Decision

Details are in save-transfer.md; each item names who decided it.

1. **Quiescent window.** Export and restore run only while the game window is closed, under the per-game lock, in a
   hidden window on the game's own partition. `ses.protocol.handle` serves an empty stub at the game origin
   (`/__wg_quiescent__?job=<nonce>`) and answers everything else with 403, with no network passthrough (QW-1, QW-10).
   `Owner` for "closed window, browser APIs" (AGENTS.md data-safety invariant 1), `Assumed` for the rest.
2. **Service workers out, in this order:** stop the session's workers and wait until none runs; load `about:blank`;
   attach `webContents.debugger`; `Network.enable` and `Network.setBypassServiceWorker {bypass: true}` (also on
   auto-attached child targets); only then navigate to the stub. `Assumed`
3. **Canary.** For the whole job every parsed script must be ours, and any other script, service-worker target or worker
   start aborts with `EXP_QUIESCENCE_VIOLATION` or `IMP_QUIESCENCE_VIOLATION`. The canary is the proof that no game code
   ran. `Assumed`
4. **Isolated world.** The exporter and importer run in an isolated world of the stub frames through a context-isolated
   preload that exists only in that window; it exposes nothing to the main world and never evaluates received code
   (QW-5). Subframes get it only for jobs with partitioned keys (QW-6). `Assumed`
5. **Storage keys.** Each snapshot records `{origin, topLevelSite, role}` per key; partitioned iframe storage is reached
   by recreating the top-level and iframe stub pair. Keys are read with CDP `Storage.getStorageKey`; a changed key is
   refused unless the user confirms a mapping (AC-24). `Owner` for recording the full key and refusing silent
   changes (PRD section 10), `Assumed` for the encoding.
6. **Restore order R1 to R8:** validate, plan, lock, pre-import backup (written, read back and validated), wipe by
   storage key with CDP `Storage.clearDataForStorageKey`, import, verify by re-export and `contentHash` comparison,
   commit. A failure in the wipe, import or verify step rolls back to the backup and verifies it. Restore happens before
   the game starts, so before an Emscripten start-up `syncfs(true)`. `Owner` for backup, rollback and verify (AGENTS.md
   data-safety invariant 3), `Assumed` for the steps.
7. **Flush state.** The owner delegated the trade-off; decided: exports without a confirmed flush are allowed, labeled
   "flush unconfirmed" in the manifest and the UI, and never presented as a guaranteed save point. `Owner` (delegated,
   decided 2026-10-24)
8. **Key generators.** Explicit-key puts advance an `autoIncrement` store's generator (Verified (2026-10-24, RESULTS.md
   H14a)); the exporter records the current number with an aborted probe and the importer raises the generator to it
   (snapshot-format.md section 7.5). `Assumed`
9. **Record encoding:** deterministic CBOR with our own codec, decided in snapshot-format.md section 6.1. `Assumed`

## Options considered

### Option A: quiescent window with an isolated-world exporter (chosen)

| Dimension | Assessment |
| --- | --- |
| Complexity | High: interceptor, CDP bypass, canary, preload, two-pass restore. Assumed |
| Cost and size | No dependency beyond Electron. Assumed |
| Compatibility | H14 PASS in all four variants: plain, service worker registered, cross-site iframe, restore in place. Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H14) |
| Security | No game code runs (canary); the stub is our code; the interceptor fails closed. Verified for the canary result (2026-10-24, RESULTS.md H14); the hardened design is Assumed |
| Team familiarity | The spike implemented it. Verified (2026-10-24, RESULTS.md H14) |
| Reversibility | Medium: the snapshot format is engine-independent, the mechanism is not. Assumed |
| Pros | Full structured clone, real IndexedDB API, works with service workers and partitioned iframes. Verified (2026-10-24, RESULTS.md H14) |
| Cons | Needs CDP and Electron-only APIs. Assumed |

### Option B: CDP only

| Dimension | Assessment |
| --- | --- |
| Complexity | Low for export. Assumed |
| Compatibility | IndexedDB is read and delete only, and records come back as `RemoteObject` references; no import is possible. Verified (2026-10-24, runtime-and-storage.md section 5.1) |
| Security, cost, familiarity, reversibility | Not assessed further: it fails the restore requirement. Assumed |
| Pros and cons | Kept only for storage keys, wipes and the canary. Assumed |

### Option C: copy Chromium's LevelDB and IndexedDB files

| Dimension | Assessment |
| --- | --- |
| All dimensions | Forbidden: never copy or read the files of a live Chromium profile; it would also tie snapshots to Chromium internals. `Owner` (AGENTS.md data-safety invariant 1; PRD section 11) |

### Option D: in-game SDK or adapters

| Dimension | Assessment |
| --- | --- |
| Complexity, compatibility | Needs the game author's cooperation; the "integrated" mode is later. `Owner` (PRD section 4) |
| Security | Declarative adapters only, never code. `Owner` (AGENTS.md security invariant 7) |
| Pros and cons | v1 ships JSON adapters that narrow scope and add a flush hook on top of Option A (save-transfer.md section 8). Assumed |

### Option E: dexie-export-import instead of an own encoding

| Dimension | Assessment |
| --- | --- |
| Compatibility | 4.4.2, Apache-2.0; Date, ArrayBuffer and Blob through typeson, not CryptoKey; can export non-Dexie databases. Verified (2026-10-24, runtime-and-storage.md section 5.7). Whether it inlines Blobs as base64 is Unverified |
| Cons | A JSON format with no byte-exact canonical form for hashing, and no shared golden vectors for a Rust codec. Assumed (snapshot-format.md section 6.1) |

## Trade-off analysis

Only Option A both reads and writes with full structured clone while proving that no game code ran. Its complexity is
the price of that proof and of partitioned storage; CDP keeps the narrow jobs it can do (key discovery, wipe, canary).
Assumed

## Consequences

- **Easier:** one uniform mechanism for every game that keeps saves in localStorage or IndexedDB. Assumed
- **Harder:** the mechanism is Electron-only: WKWebView has no CDP, so an iOS or Tauri client would need another one.
  Assumed (runtime-and-storage.md section 3). Snapshots stay readable there because the format avoids Chromium
  internals. Assumed
- **Phase 1 gates (MUST tests in save-transfer.md):** the iframe no-bypass control, because that the page-level bypass
  covers subframes is Assumed (RESULTS.md H14c); that Chromium reverts the key generator on an aborted probe is
  Unverified; OPFS is not exported in v1 and is listed in `notExported`.

### Revisit triggers

- ADR-0002 ends without Electron; Chromium or Electron removes `Network.setBypassServiceWorker`, isolated worlds or
  `Storage.clearDataForStorageKey`; a real game keeps saves in OPFS or another store; the generator probe proves
  unstable. Assumed

## Evidence

- [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H14 (variants a to d, aggregate
  `electron-45.0.0-20261024T151511.707Z.json`, `checks.h14`), its deviations 2 and 3, and the findings on `about:blank`
  and debugger commands; [runtime-and-storage.md](../research/runtime-and-storage.md) section 5.

## Facts versus assumptions

- **Facts** (Verified (2026-10-24, RESULTS.md H14)): Hd equalled Hs in every variant and the negative control differed;
  without the bypass the registered worker controlled the stub, with it no worker started; the fixture request log could
  not tell bypass from no bypass, the CDP canary could; `ses.clearStorageData({origin})` left partitioned iframe
  storage, CDP `Storage.clearDataForStorageKey` removed it; `WebFrameMain` has no isolated-world execution, so subframes
  need the preload; explicit keys 1 to 7 made the next `add` get 8.
- **Assumptions** (Assumed): the bypass covers subframes; the hardening rules close the spike's fail-open passthrough;
  only two storage-key forms occur; save data fits the limits.

## Action items

- [ ] Phase 1 implements save-transfer.md sections 4 to 6 test-first, including the AC-7, AC-8 and AC-24 tests and the
  MUST tests listed there (agent).
