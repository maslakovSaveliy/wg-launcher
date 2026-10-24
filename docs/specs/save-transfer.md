# Save transfer: export, restore and verify

Status: draft for Phase 1, 2026-10-25. Normative for `packages/exporters`, the snapshot jobs in `apps/desktop/main` and
the snapshot worker. The mechanism is the one of ADR-0005 (save transfer mechanism): a hidden quiescent window of the
game's own partition, our code in an isolated world, never the game's code. The file format is
[snapshot-format.md](snapshot-format.md); processes, locks and the database are in [architecture.md](architecture.md);
threats in [security.md](security.md). Conventions (MUST, claim tags, `Assumed` for calls made here) are those of
[snapshot-format.md](snapshot-format.md#conventions).

Evidence used throughout: the Electron 45 spike, hypothesis H14 variants a to d, all PASS. Verified (2026-10-24,
[RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H14).

## 1. Data versus cache

| Storage kind | Class | In a snapshot | Backed up before import or delete | Removed by "Clear cache" | Removed by "Delete local saves" |
| --- | --- | --- | --- | --- | --- |
| localStorage | Data | Yes | Yes | No | Yes |
| IndexedDB (including Emscripten IDBFS) | Data | Yes | Yes | No | Yes |
| OPFS and other file systems | Data, not supported in v1 | No, listed in `notExported` | No | No | No (kept; the dialog says so) |
| Cookies | Credentials | Never | No | No | No |
| HTTP cache, code cache, shader cache | Cache | Never | No | Yes | No |
| Cache Storage, service worker registrations | Cache | Never | No | Yes | No |

`Owner` for the data and cache split and the exclusions (PRD sections 9 and 10, AC-20), `Assumed` for OPFS being kept
by "Delete local saves": it cannot be backed up in v1, and a delete without a backup is forbidden (AGENTS.md
data-safety invariant 3).

## 2. Storage keys

- Since Chrome 115 a third-party iframe's storage is keyed by its origin plus the top-level site. Verified
  (2026-10-24, <https://developer.chrome.com/docs/privacy-sandbox/storage-partitioning>). In Electron 45 the spike read
  the keys `http://localhost:4417/` (top level) and `http://127.0.0.1:4417/^0http://localhost` (iframe) through CDP
  `Storage.getStorageKey`, and `ses.clearStorageData({origin})` did not clear the partitioned key while CDP
  `Storage.clearDataForStorageKey` did. Verified (2026-10-24, RESULTS.md H14c).
- **Discovery.** While a game window runs, the main process records each frame's origin and its top-level origin
  (`did-frame-navigate`, http and https only) in `storage_targets`
  ([architecture.md](architecture.md#7-sqlite-schema-v1)). These are the game's **known keys**. **Game keys** are the
  top-level origins plus the frame keys the user confirmed as part of the game (or an adapter declared). Exports cover
  game keys; backups and "Delete local saves" cover all known keys, so that nothing reachable is wiped without a
  backup. `Assumed`
- **Resolution.** The quiescent window recreates each key as a stub frame (section 5) and reads its Chromium key with
  `Storage.getStorageKey`. It accepts only the two observed forms, `<origin>/` and `<origin>/^0<site>`, and parses them
  into `{origin, topLevelSite}`; it compares the result with the key computed in the main process (`siteOf` from the
  Public Suffix List, [architecture.md](architecture.md#5-game-windows-and-sessions)). Another form or a difference is
  `EXP_UNSUPPORTED_STORAGE_KEY` or `EXP_STORAGE_KEY_MISMATCH`. The Chromium string is used only at run time and never
  stored. Assumed (only these two forms were observed; others, such as nonce or ancestor-bit keys, are Unverified).
- **Changed keys (AC-24).** Each snapshot key has a `role`: `top` for the storage of a top-level document of the game,
  `frame` for an iframe's ([snapshot-format.md](snapshot-format.md#4-manifest)). A restore is compatible when every `top`
  key's origin equals a top-level origin of the target game (its URL's origin or one observed in `storage_targets`) and
  every partitioned key's `topLevelSite` is the site of such an origin. Frame origins themselves are not compared: the
  game's page decides which frames it embeds. Otherwise the restore fails with `IMP_STORAGE_KEY_MISMATCH`, naming each
  snapshot key and the target key it was compared with, before anything is written. The only way past it is a mapping that the user confirms in the
  launcher UI, origin by origin (`http://localhost:4317` to `http://127.0.0.1:4317`, for example); a mapped key's
  `topLevelSite` becomes the site of the mapped top-level origin. Every record then lands under the mapped key, which
  the restore check proves (expected hash per [snapshot-format.md](snapshot-format.md#5-content-hash)). No case ends in
  a silent no-op or a partial restore. `Owner` for the rule (PRD section 10), `Assumed` for the details.

## 3. Exporter interface and versioning

Exporters run inside the quiescent window, one instance per stub frame, compiled into the quiescent preload bundle. The
snapshot worker assembles the file. Sketch (TypeScript, not final code):

```ts
interface ExporterInfo { id: string; version: string }        // { id: "generic-web-storage", version: "1.0.0" }
type Selection = "all" | { include: string[]; exclude: string[] }; // localStorage key prefixes or database names
interface FrameScope { localStorage: Selection; indexedDB: Selection }
interface FrameExporter {
  readonly info: ExporterInfo;
  inventory(): Promise<FrameInventory>;   // counts, names, usage numbers; never values, never cookies
  exportFrame(scope: FrameScope, out: EntrySink): Promise<FrameSummary>;     // writes data/<k>/... and blobs/...
  importFrame(source: EntrySource, plan: FrameImportPlan): Promise<FrameSummary>;
}
interface FrameInventory {
  localStorageItems: number;
  databases: { name: string; version: number }[];
  usageDetails: Record<string, number> | null;   // navigator.storage.estimate().usageDetails when available
}
```

- Entry bytes travel as `ArrayBuffer` chunks over a `MessagePort` between the frame and the snapshot worker, never as
  JSON through the main process and never inside a code string ([architecture.md](architecture.md#6-ipc-contract)).
  `Assumed`
- `exporter.id` names the algorithm; `exporter.version` follows the rule of
  [snapshot-format.md](snapshot-format.md#9-versioning-and-migration). v1 ships exactly one exporter,
  `generic-web-storage` 1.0.0. Adapters (section 8) only narrow its scope and add a flush hook; they never add code.
  `Assumed`
- Errors are values `{code, detail}`; codes start with `EXP_` (export) or `IMP_` (import) and are listed in sections 4
  and 6. Because a throwing script in an isolated world resolves to `undefined` (Verified (2026-10-24,
  <https://www.electronjs.org/docs/latest/api/web-frame>)), every command catches its own errors and returns an
  explicit error message; a missing reply is `EXP_TIMEOUT`.

## 4. Generic exporter

Export, inside one stub frame:

1. Inventory. Read `localStorage` (every item) and `indexedDB.databases()`.
2. For each database, sorted by name: open it without a version (an `upgradeneeded` there means it no longer exists:
   abort that transaction and skip it), read the schema (version, stores, key paths, auto-increment, indexes with
   `unique` and `multiEntry`) and every record with its primary key in key order, in read-only transactions, in chunks
   (cursor or `getAll` with a key range) so that memory stays bounded.
3. For each `autoIncrement` store, probe the key generator: a separate read-write transaction on that store calls
   `add(placeholder)` (`null` without a key path, `{}` with one, so the key is injected), reads the generated key and
   aborts the transaction. That key is `keyGenerator`. A `ConstraintError` is `EXP_KEY_GENERATOR_EXHAUSTED`. The W3C
   draft says an abort reverts the generator (Verified (2026-10-25, <https://www.w3.org/TR/IndexedDB/>)); that Chromium
   does so is Unverified, and a Phase 1 test MUST show that two exports in a row give the same `keyGenerator` and an
   unchanged `contentHash`. This aborted write is the only write an export makes. `Assumed`
4. Encode with the codec ([snapshot-format.md](snapshot-format.md#6-record-encoding)); hash Blob and File bytes with
   `crypto.subtle.digest("SHA-256")` and send each distinct blob once. Unsupported values fail the whole export with
   `EXP_UNSUPPORTED_VALUE`, `EXP_SHARED_REFERENCE` or `EXP_TOO_DEEP` and the record path (AC-10).
5. Record `notExported` kinds from `usageDetails`: `fileSystem`, `caches` and `serviceWorkerRegistrations` above zero
   become `fileSystem`, `cacheStorage` and `serviceWorkers`.
6. Never read `document.cookie`, `cookieStore`, Cache Storage contents, `navigator.credentials` or service worker
   scripts (spike code review; AC-20). `Owner` for the exclusions, `Assumed` for the list.

Import, inside one stub frame, after the wipe (section 6):

1. The target MUST be empty (no localStorage item, no database; for a selective restore, none of the selected ones),
   otherwise `IMP_TARGET_NOT_EMPTY`.
2. Write localStorage items. A `QuotaExceededError` is `IMP_QUOTA_EXCEEDED`, never ignored (PRD anti-goal 2).
3. For each database: `indexedDB.open(name, version)`; in `upgradeneeded` (which MUST see `oldVersion` 0) create the
   stores and indexes exactly as recorded. Then put the records in read-write transactions of bounded size:
   `put(value, key)` without a key path, `put(value)` with one, and `indexedDB.cmp(result, key) === 0` or
   `IMP_KEY_MISMATCH`. Blob and File values are rebuilt with their type, name and `lastModified`.
4. Key generator: where `keyGenerator` is above the generator's value after the puts (the highest numeric key plus 1,
   at least 1), put a placeholder with the explicit key `keyGenerator − 1` (inside the value at the key path when there is
   one) and delete it in the same transaction. Explicit numeric keys move the generator up and deletes never move it
   down. Verified (2026-10-25, <https://www.w3.org/TR/IndexedDB/>, key generators); in Chromium, Verified for explicit
   keys (2026-10-24, RESULTS.md H14a). The restore check covers the rest.

## 5. Quiescent window

The procedure is the one H14 proved (Verified (2026-10-24, RESULTS.md H14)), hardened by the findings of the review of
the spike code. All steps run in the main process unless stated.

1. **Lock.** Take the per-game exclusive lock ([architecture.md](architecture.md#4-game-session-lifecycle)). The game
   window MUST be closed, otherwise `GAME_RUNNING` (AC-11); another task or a pending recovery gives `GAME_BUSY` or
   `NEEDS_RECOVERY` ([architecture.md](architecture.md#6-ipc-contract) codes).
2. **Service workers.** Stop the session's service workers and wait until `ses.serviceWorkers.getAllRunning()` is empty
   (at most 10 s, then `EXP_QUIESCENCE_VIOLATION`). In the spike, a worker still running from the closed game window
   showed up in the export window's canary until the runner waited for it. Verified (2026-10-24, RESULTS.md, deviation
   2). The stop mechanism is the one of AC-13 ([architecture.md](architecture.md#4-game-session-lifecycle)).
3. **Interceptor.** Register `ses.protocol.handle` for `https` (and `http` for development origins, PRD OQ-3) on the
   game's session, and `ses.webRequest.onBeforeRequest` as a second layer.
4. **Window.** A hidden `BrowserWindow` on the game's partition with `sandbox: true`, `contextIsolation: true`,
   `nodeIntegration: false`, `webSecurity: true`, `backgroundThrottling: false`, the quiescent preload, and
   `nodeIntegrationInSubFrames: true` only when the job has partitioned keys. Electron's main-process `WebFrameMain` has
   no isolated-world execution, so subframes need the preload. Verified (2026-10-24, RESULTS.md H14c).
5. **Service worker bypass, in this order:** load `about:blank` (debugger commands wait forever on a window that never
   navigated: Verified (2026-10-24, RESULTS.md findings)); attach `webContents.debugger`; send `Network.enable` and
   `Network.setBypassServiceWorker {bypass: true}`; set `Target.setAutoAttach {autoAttach: true,
   waitForDebuggerOnStart: true, flatten: true}` and, for each attached child target, send the same two commands
   before `Runtime.runIfWaitingForDebugger`; enable `Debugger` and `Runtime` everywhere for the canary. Only then
   navigate. Without the bypass the registered worker controlled the stub; with it, it did not. Verified (2026-10-24,
   RESULTS.md H14b). That the bypass also covers iframes is Assumed (no no-bypass iframe control ran), so Phase 1 MUST
   add that control.
6. **Stub.** Navigate to `<top origin>/__wg_quiescent__?job=<nonce>`; for partitioned keys the stub contains one
   `<iframe>` per frame origin pointing to the same path there. The top origin of a partitioned key is its
   `topLevelSite`; a first-party key uses its exact origin.
7. **Keys.** Resolve and check every frame's storage key (section 2).
8. **Handshake.** Each preload instance sends one `ipcRenderer` message with the job nonce. The main process accepts it
   only from the job's `webContents`, from a frame whose URL is an expected stub URL, with the right nonce; it then
   gives that frame one end of a `MessageChannelMain` whose other end goes to the snapshot worker.
9. **Commands.** The worker sends typed commands (`inventory`, `export`, `import`, `wipe-selected`) with request ids;
   both ends validate every message with zod and abort on anything unexpected.
10. **Canary, during the whole job.** Every `Debugger.scriptParsed` on every target must come from our preload's
    isolated context (its execution context and source URL, an allowlist fixed by a Phase 1 calibration test); any
    other parsed script, any service worker target, or any `running-status-changed` of the session to `starting` or
    `running` aborts the job with `EXP_QUIESCENCE_VIOLATION` or `IMP_QUIESCENCE_VIOLATION`. The canary is the real
    evidence that no game code ran; the fixture's request log could not tell bypass from no bypass. Verified
    (2026-10-24, RESULTS.md H14).
11. **Finally.** In `try`/`finally`, whatever happened: destroy the window, detach the debugger, `ses.protocol.unhandle`
    both schemes, remove the `webRequest` listener, release the lock. A watchdog ends a job that exceeds its deadline
    (Assumed: 60 s plus 1 s per MiB).

**Hardening requirements (MUST; from the review of the spike code).**

- **QW-1 Fail closed.** The interceptor answers only the exact stub URLs of the current job (expected origins, path
  `/__wg_quiescent__`, the job nonce). Every other request gets `403` with an empty body. There is no passthrough to the
  network (`ses.fetch` or `net.fetch`); the spike's passthrough was fail-open.
- **QW-2 Exclusive partition.** While the interceptor is registered, the quiescent window is the only `webContents` on
  that session; the job checks this before step 6 and the lock prevents a game launch until step 11.
- **QW-3 No leak on throw.** Registration and removal are paired in `try`/`finally` (step 11); a unit test makes each
  step throw and checks that nothing stays registered.
- **QW-4 Authenticated IPC.** Every message from the quiescent window is checked against `event.senderFrame` (job
  `webContents`, expected stub URL) and carries a request nonce of at least 128 random bits (`crypto.randomBytes`), not a
  counter.
- **QW-5 Typed commands only.** The preload exposes nothing to the main world (no `contextBridge`) and never evaluates
  code it receives: no `eval`, no `new Function`, no `executeJavaScriptInIsolatedWorld` with a received string. If an
  extra isolated world is ever needed, its code is a build-time constant.
- **QW-6 Subframes only when needed.** The preload runs in subframes only for jobs with partitioned keys and stays inert
  in any frame whose URL is not an expected stub URL.
- **QW-7 Data is data.** Snapshot bytes pass through the message port or files, never spliced into a code string.
- **QW-8 No credentials.** The exporter never reads cookies or other credentials (section 4, step 6).
- **QW-9 Quiet logs.** Logs carry job id, game id, step, counts, byte sizes and error codes; never values, localStorage
  key names, database contents or URLs with query strings (origins only).
- **QW-10 Inert stub.** The stub is `text/html` with `Cache-Control: no-store` and
  `Content-Security-Policy: default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-src <the
  job's iframe stub origins>`; its body holds only those iframes. The preload is not affected by the page CSP.

## 6. Restore protocol

Each step is written to `restore_journal` ([architecture.md](architecture.md#7-sqlite-schema-v1)) before it starts.

| Step | What happens | On failure |
| --- | --- | --- |
| R1 Validate | Full validation in the snapshot worker ([snapshot-format.md](snapshot-format.md#8-limits-and-error-codes)) of a private copy in `tmp/` (an external file is copied first, [security.md](security.md#8-archive-safety-and-resource-limits)) | The `SNAP_*` code; nothing written |
| R2 Plan | From the validated manifest, check the keys and the confirmed mapping (section 2) and compute the wipe set: the snapshot's keys (mapped) plus all known keys of the game | `IMP_STORAGE_KEY_MISMATCH`; nothing written |
| R3 Lock | Per-game exclusive lock; game window closed | `GAME_RUNNING` (AC-11), `GAME_BUSY` or `NEEDS_RECOVERY`; nothing written |
| R4 Backup | Export every known key with the generic exporter and no adapter filter to `backups/<gameId>/<revisionId>.wgsnap` (written as `.partial`, read back and validated, then renamed); recorded with kind `backup` | `IMP_BACKUP_FAILED`; nothing wiped, the partial file removed |
| R5 Wipe | In one quiescent window holding all keys of the wipe set: CDP `Storage.clearDataForStorageKey` with each frame's key and `local_storage,indexeddb`; for a selective (adapter) restore, the importer removes only the selected localStorage keys and databases instead; then an inventory confirms emptiness | `IMP_WIPE_FAILED`, rollback |
| R6 Import | Section 4, from a second streaming pass over the file that re-checks every entry hash | `IMP_*` code, rollback |
| R7 Verify | Re-export the same scope and compare `contentHash` with the expected hash (mapped if a mapping was confirmed) | `IMP_VERIFY_MISMATCH`, rollback |
| R8 Commit | Journal `done`; the game's `base_revision_id` becomes the snapshot's `revisionId`; lock released; "Local data" rechecked | (none) |

- **Rollback** (any failure in R5 to R7): wipe the wipe set again, import the R4 backup, re-export and compare with the
  backup's `contentHash`. The state then equals the pre-import state and the backup still exists and verifies (AC-8).
  `Owner` for backup, restore on failure and verify (AGENTS.md data-safety invariant 3), `Assumed` for the steps.
- **Failed rollback:** `IMP_RECOVERY_FAILED`. The game stays locked in `needs_recovery`: launching it is refused with an
  explicit message naming the backup, and the UI offers "Retry recovery". The backup is never deleted, by this or any
  other action (PRD section 9). `Assumed`
- **Crash or power loss:** at start-up the main process reads unfinished journal entries before any game can launch. A
  job that stopped in R1 to R4 changed nothing: its temporary files under `tmp/` are removed and the entry closed. A job
  that reached R5 or later runs the rollback first. `Assumed`
- **Fault injection (AC-8):** the job runner takes an injectable fault hook per step (validate, lock, backup, wipe,
  import, verify); the integration test runs each fault on progress-lab and checks that the progress hash and the
  storage inventory equal the pre-import state and that the backup validates.
- **Delete local saves** (PRD section 9, AC-16) is R3, R4 and R5 over all known keys, then R8 without a revision; a
  failure after R5 restores the backup in the same way. **Verify** (`snapshot:verify`) is R1, then R6 and R7 into a
  fresh in-memory partition (`wg-verify-<nonce>`, no `persist:` prefix) whose data is cleared afterwards; it never
  touches the game's partition. A non-`persist:` partition lives in memory. Verified (2026-10-24,
  <https://www.electronjs.org/docs/latest/api/session>). Passing it sets "Export verified" for that exporter version
  ([architecture.md](architecture.md#11-badges)).

**Export** (`snapshot:export`): lock; stop service workers; quiescent export of the game keys with the adapter's scope;
the worker writes `tmp/<revisionId>.wgsnap.partial`, reads it back through the full validator, fsyncs and renames it to
`snapshots/<gameId>/<revisionId>.wgsnap`; the database row records the manifest fields. `parentRevisionId` is the game's
`base_revision_id`. Export never changes the game's storage apart from the aborted probe of section 4. `Assumed`

## 7. Flush state

Closing a window does not prove that a game flushed its storage, for example Emscripten IDBFS. `Owner` (AGENTS.md
data-safety invariant 4). The owner delegated the trade-off and it is decided: exports without a confirmed flush are
allowed, labeled "flush unconfirmed" in the manifest and the UI, and never presented as a guaranteed save point; "Export
verified" needs a successful round trip and says nothing about flush. `Owner` (delegated, decided 2026-10-24).

- Export still never runs while the game window is open (AC-11). When an adapter declares a flush hook and the game is
  running, the UI offers "Flush, close and export": the launcher runs the hook, closes the window (architecture close
  procedure) and only then starts the export. Without such an adapter, `snapshot:export` on a running game is refused
  with `GAME_RUNNING`. `Assumed`
- `flushState` is `confirmed` if and only if all of these hold, and `unconfirmed` otherwise: an adapter declares a flush
  hook (section 8); the export was requested through that flow; the launcher ran the hook in the
  game page and it returned exactly `true` before its timeout; no user input reached the game window between the start
  of the hook and the close; and the launcher closed the window itself within 2 s after the hook finished. `Assumed`
  (the numbers and the input rule)
- The generic exporter has no hook, so every MVP snapshot without such an adapter is `unconfirmed`. `Assumed`
- The decision is one pure function, `decideFlushState(observation)`. Its unit test (AC-12) uses a fake hook: none,
  success, error, timeout, a value other than `true`, input after the hook started, and a late close; only the success
  case without input and with a prompt close gives `confirmed`. A UI test checks that every place showing an
  `unconfirmed` snapshot shows "flush unconfirmed" and never "save point", "guaranteed" or "complete".
- The hook runs in the game page's main world through `webContents.executeJavaScript` from a fixed template whose only
  parameter is a validated identifier. The page could fake the result, which only affects its own snapshot. That is
  accepted. `Assumed`

## 8. Declarative adapters

Adapters are JSON data, never code (AGENTS.md security invariant 7). In v1 they ship inside the app
(`packages/exporters/adapters/*.json`), are validated at build time and at load, and user-supplied adapters are not
loaded. `Assumed`

```json
{
  "adapterFormat": 1,
  "id": "progress-lab",
  "version": "1.0.0",
  "match": { "origins": ["http://localhost:4317"] },
  "storage": {
    "frameKeys": [],
    "localStorage": { "include": ["progress-lab:"], "exclude": [] },
    "indexedDB": { "include": ["progress-lab", "/home/web_user"], "exclude": [] }
  },
  "flush": { "hook": "none" }
}
```

- The schema is closed: unknown members, a wrong type or an over-long value make the adapter invalid. `id` matches
  `^[a-z0-9-]{1,64}$`; `version` is SemVer; at most 64 items per list and 256 characters per string. `Assumed`
- `match.origins` are exact origins compared with the game's top-level origin. `frameKeys` lists partitioned keys
  (`{origin, topLevelSite}`) that belong to the game, which the user then need not confirm.
- localStorage selectors are key prefixes; IndexedDB selectors are whole database names, matched exactly. No regular
  expressions or globs (no ReDoS, predictable scope). Store-level filtering is not offered, because a database restored
  at its version without some of its stores would break the game's upgrade logic. `Assumed`
- `flush.hook` is `none` or `emscripten-idbfs` with `module` (a JavaScript identifier, default `Module`) and `timeoutMs`
  (at most 30 000). The `emscripten-idbfs` hook calls `FS.syncfs(false, callback)` on that module object. `Assumed`
- Filtering is a declared choice: the manifest names the adapter and its version, so a snapshot's scope can always be
  explained. A selective restore never wipes data outside the selection (section 6, R5).

## 9. Emscripten and Unity notes

- Emscripten IDBFS keeps files in the object store `FILE_DATA` of a database whose version is 21, with an index
  `timestamp`; the key is the absolute path and the value `{timestamp: Date, mode, contents: Uint8Array}` or `{timestamp,
  mode, link}`. The in-memory file system is the truth while the program runs; `syncfs(false)` writes it back and
  `syncfs(true)` loads it at start-up. Verified (2026-10-24,
  <https://raw.githubusercontent.com/emscripten-core/emscripten/main/src/lib/libidbfs.js>).
- So the generic exporter handles IDBFS data as ordinary IndexedDB records (progress-lab imitates the shape: vector
  `valid-idbfs`); restore runs only while the game is closed, which is before its start-up `syncfs(true)`; and an export
  taken without a confirmed `syncfs(false)` is `unconfirmed`. The real test needs a small Emscripten program (AC-25,
  later). `Assumed`
- Unity WebGL stores up to 1 MB of PlayerPrefs in IndexedDB. Verified (2026-10-24,
  <https://docs.unity3d.com/ScriptReference/PlayerPrefs.html>). Its path is said to contain a build hash that changes
  per build. Unverified (community report). If so, a snapshot restored after a game update may be invisible to the
  game; mapping paths is not part of v1.

## 10. Tests

| AC | Test (Phase 1) |
| --- | --- |
| AC-6 | e2e: the vertical scenario on progress-lab ends with an equal `#progress-hash` |
| AC-7 | integration and e2e: export and restore into a clean partition with equal hash for progress-lab in the plain, service-worker and cross-site iframe variants (H14 a to c), including the no-bypass iframe control |
| AC-8 | integration: fault injection at each restore step (section 6) |
| AC-10 | unit: each unsupported value type gives its code and path |
| AC-11 | integration: export, import and delete refused while the game window is open |
| AC-12 | unit: `decideFlushState` with a fake hook (section 7) |
| AC-16 | integration: "Delete local saves" makes and verifies a backup first, then wipes; "Clear cache" leaves data |
| AC-20 | integration: a snapshot of a session with cookies, Cache Storage and a service worker contains none of them |
| AC-24 | integration: progress-lab exported on `localhost` with a nested `127.0.0.1` iframe, restored where the keys differ: refused naming both keys and nothing written; with a confirmed mapping every record lands under the mapped key |
| AC-25 | later: a small Emscripten program, export after and before `syncfs` |

Additional MUST tests: key generator probe stability (section 4); interceptor fail-closed and removal on throw (QW-1,
QW-3); sender and nonce checks (QW-4); canary flags a deliberately injected main-world script.

## Open questions

- Which frame keys are part of a game when no adapter says so? Default: the export dialog lists the cross-site frame
  origins that hold data, with their sizes, unticked, and remembers the choice. Ads in iframes can keep tracking ids in
  storage, so they are never included silently. `Assumed`
- The generic exporter can capture tokens a site keeps in localStorage (cookies are never read). Default: no heuristic
  filtering, because it would drop data silently; the export dialog shows the origins and counts, and snapshots stay
  local unless the user moves them. Recorded as a residual risk in [security.md](security.md). `Assumed`
- If Chromium does not revert the generator on abort (section 4), the fallback is to record the highest numeric key
  plus 1 and accept the documented difference. `Assumed`
- Game-native "download save" buttons do not work in the MVP: downloads and the File System Access API are denied
  ([security.md](security.md#5-permission-and-navigation-policy)). `Assumed`
