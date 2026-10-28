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
  `frame` for an iframe's ([snapshot-format.md](snapshot-format.md#4-manifest)). Every key is checked against the target
  game, after any confirmed mapping:
  - a `top` key's origin MUST equal a top-level origin of the target (its URL's origin or one observed in
    `storage_targets`);
  - a partitioned key's `topLevelSite` MUST be the site of such an origin;
  - a `frame` key's origin MUST equal a frame origin observed in the target's `storage_targets` under a top-level origin
    of the same site. If the target has observations there but not this origin (the iframe moved to another host or
    port), it is a mismatch. If the target has no frame observations there yet (never played), the key is unchecked.

  A mismatch fails the restore with `IMP_STORAGE_KEY_MISMATCH`, naming each snapshot key and the target keys it was
  compared with, before anything is written. Unchecked keys are listed in a native confirmation ("these iframe storage
  keys could not be checked against this game"); without consent nothing is written. The only way past a mismatch is a
  mapping that the user confirms, origin by origin (`http://localhost:4317` to `http://127.0.0.1:4317`, for example); a
  mapped key's `topLevelSite` becomes the site of the mapped top-level origin, and mapping a frame origin to itself keeps
  an unmatched frame key deliberately. Every record then lands under the mapped
  key, which the restore check proves (expected hash per [snapshot-format.md](snapshot-format.md#5-content-hash)). No
  case ends in a silent no-op or a silent partial restore. `Owner` for the rule (PRD section 10), `Assumed` for the
  details.

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
- **Settled in Phase 1 Task 12** (`packages/exporters/src/types.ts`, `protocol.ts`; `Assumed`):
  `createFrameExporter(env)` takes the frame's Web APIs (`{localStorage, indexedDB, crypto, storage?}`), so a test can
  replace one. `exportFrame({keyIndex, storageKey, scope}, sink)` and `importFrame(source, {keyIndex, storageKey,
  scope})` take the manifest index `k` of the frame's key (for the `data/<k>/` paths) and the key itself (for error
  details); `wipeSelected(scope)` serves R5 of a selective restore. Each returns `{ok: true, data}` or `{ok: false,
  error: {code, message, detail?}}` and never throws; `code` is an `EXP_*` or `IMP_*` code or `INTERNAL` for an
  unexpected failure, and `detail` names the storage key, database, store, record key, property path and entry path
  where they apply, never a value. A sink receives each entry whole, once (`write(path, bytes)`), and the frame
  server sends it in chunks; a source yields the frame's entries, assembled, in any order. A `Selection` is `"all"` or `{include, exclude}`, per storage kind.
- The frame protocol (zod, strict objects, both directions): commands `inventory`, `export`, `import` (followed by
  `entry` messages and one `end`) and `wipe-selected`; replies `entry` (the export's entries), `inventory`, `summary`,
  `wiped` and `error`. Every message carries its command's request nonce, 32 lowercase hex digits (128 bits, QW-4), and
  entry bytes are `ArrayBuffer`s, never a string (QW-7). `Assumed`
- **Chunks (Phase 1 Task 13, `packages/exporters/src/protocol.ts`, `frame-server.ts`).** An `entry` message carries one
  chunk of an entry: its `path`, the entry's whole `size`, the chunk's `offset` and at most `MAX_ENTRY_CHUNK_BYTES`
  (1 MiB) of bytes. The chunks of an entry come back to back in order, an empty entry is one empty chunk, and a
  chunk past the entry's size is refused by the schema, so no message between a frame and the snapshot worker is
  larger than 1 MiB plus a few names; the receiver checks the declared `size` against `maxEntryBytes` before it keeps
  a byte. `Assumed` for the size. The buffers are cloned, never put in the transfer list: a message whose
  `ArrayBuffer` was transferred from a sandboxed preload's port reached a `utilityProcess`'s `MessagePortMain` as
  `null`, while the same message cloned arrived whole. Verified (2026-10-28, a throwaway probe app on Electron 45.0.0,
  macOS arm64). `serveFrame` is the frame's end: one command at a time; an invalid message, a command while another
  runs, import chunks out of order or with another nonce close the port, which the worker treats as a failed command.
  Verified (2026-10-28, `packages/exporters/src/frame-server.test.ts`, Vitest on Node 24.22.1).

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
   draft says an abort reverts the generator (Verified (2026-10-25, <https://www.w3.org/TR/IndexedDB/>)). Chromium does
   so: two exports in a row gave the same `keyGenerator` (8 after 7 progress-lab steps) and the same `contentHash`, and
   the game's next step still got key 8; a store whose generator is above its highest key plus 1 exported that
   generator, not the highest key plus 1; an explicit key 2^53 made the probe fail with `ConstraintError`. Verified
   (2026-10-28, `packages/exporters/browser/key-generator.spec.ts`, bundled Chromium 156.0.8078.4). Electron 45 does the
   same through the quiescent window: two exports of progress-lab after 7 steps had the same `contentHash` (which
   covers each store's `keyGenerator`) and the game's next step got key 8. Verified (2026-10-28,
   `apps/desktop/e2e/export.spec.ts`, Electron 45.0.0, macOS arm64). So the fallback (highest numeric key plus 1) is
   not needed. This aborted write is the only write an export makes. `Assumed`
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

Implementation (Phase 1 Task 12, `packages/exporters`). `Assumed` unless tagged otherwise:

- **Check pass, nothing written.** The importer receives the frame's entries (its `data/<k>/…` files and the blobs
  they reference) in any order, then checks the target is empty, decodes every file and builds every value once
  before its first write. A failure in this pass fails the import with nothing written: `IMP_RECORD_INVALID`, with the
  entry path and, for a record, the database, store and record key. It covers a RegExp source that does not compile in
  this engine (Ruling R7; the worker's validator already refused it in R1), a value whose view type this engine has no
  constructor for, a schema IndexedDB would refuse to create (invalid key path, `autoIncrement` with an empty or array
  key path; the reader refuses these too, snapshot-format.md section 7.2), a blob whose bytes do not match its name, a
  blob entry no record references, a missing or duplicated entry, a record count that differs from the schema and, for
  a selective restore, a localStorage key or database outside the selection. Verified for the RegExp, schema,
  unreferenced-blob and selection cases (2026-10-28, `packages/exporters/browser/import-errors.spec.ts`, bundled
  Chromium 156.0.8078.4).
- **Write pass, failures named, partial writes left to the rollback.** localStorage first, then each database. A
  database that already exists (an `upgradeneeded` with `oldVersion` above 0, no `upgradeneeded`, or a `VersionError`)
  is `IMP_TARGET_NOT_EMPTY`. Puts go in transactions of 256 records; no request error is ever prevented, so one failed
  request aborts its whole transaction, and the import fails with a named code: a `ConstraintError` (a unique index) is
  `IMP_RECORD_INVALID` with the record key, a `QuotaExceededError` is `IMP_QUOTA_EXCEEDED` (localStorage or IndexedDB),
  a key that compares unequal or a value without a key at the key path (`DataError`) is `IMP_KEY_MISMATCH`, anything
  else `INTERNAL` with the error's type name. The summary counts the records IndexedDB acknowledged. A failure in this
  pass can leave earlier localStorage items, databases and committed chunks behind: the importer does not undo them;
  the R5 to R7 rollback of the restore protocol (section 6, Task 14) does. Verified for the unique-index, raise and
  quota cases (2026-10-28, same spec and Chromium).
- **Wipe.** `wipe-selected` deletes the selected databases; a delete blocked by another open connection is
  `IMP_WIPE_FAILED` (Verified, same spec). The blocked request stays queued in IndexedDB and completes when that
  connection closes, so the job treats the failure as fatal; QW-2 keeps the partition exclusive.
- **Export.** A localStorage key listed but gone when read is `EXP_QUIESCENCE_VIOLATION`, never exported as an empty
  value (Verified, 2026-10-28, `browser/export-errors.spec.ts`). Any other failure inside a frame is `INTERNAL` with the
  error's type name only, never a value; a snapshot format error is an `IMP_` code on the import path only.

## 5. Quiescent window

The procedure is the one H14 proved (Verified (2026-10-24, RESULTS.md H14)), hardened by the findings of the review of
the spike code. All steps run in the main process unless stated.

1. **Lock.** Take the per-game exclusive lock ([architecture.md](architecture.md#4-game-session-lifecycle)). The game
   window MUST be closed, otherwise `GAME_RUNNING` (AC-11); another task or a pending recovery gives `GAME_BUSY` or
   `NEEDS_RECOVERY` ([architecture.md](architecture.md#6-ipc-contract) codes).
2. **Interceptor.** Register `ses.protocol.handle` for `https` (and `http` for development origins, PRD OQ-3) on the
   game's session, and `ses.webRequest.onBeforeRequest` as a second layer.
3. **Window.** A hidden `BrowserWindow` on the game's partition with `sandbox: true`, `contextIsolation: true`,
   `nodeIntegration: false`, `webSecurity: true`, `backgroundThrottling: false`, the quiescent preload, and
   `nodeIntegrationInSubFrames: true` only when some key of the job is resolved in an iframe. Electron's main-process
   `WebFrameMain` has no isolated-world execution, so subframes need the preload. Verified (2026-10-24, RESULTS.md H14c).
4. **Debugger.** Load `about:blank` (debugger commands wait forever on a window that never navigated: Verified
   (2026-10-24, RESULTS.md findings)), then attach this window's `webContents.debugger`.
5. **Service workers.** Through that debugger send `ServiceWorker.enable` and `ServiceWorker.stopAllWorkers` (the
   mechanism of the AC-13 close procedure, [architecture.md](architecture.md#4-game-session-lifecycle)) and wait until
   `ses.serviceWorkers.getAllRunning()` is empty, at most 10 s; otherwise `EXP_QUIESCENCE_VIOLATION` (export) or
   `IMP_QUIESCENCE_VIOLATION` (import). In the spike, a worker still running from the closed game window showed up in
   the export window's canary until the runner waited for it. Verified (2026-10-24, RESULTS.md, deviation 2).
6. **Service worker bypass, in this order:** `Network.enable` and `Network.setBypassServiceWorker {bypass: true}`;
   `Target.setAutoAttach {autoAttach: true, waitForDebuggerOnStart: true, flatten: true}` and, for each attached child
   target, the same two commands before `Runtime.runIfWaitingForDebugger`; `Debugger` and `Runtime` enabled everywhere
   for the canary. Only then navigate. Without the bypass the registered worker controlled the stub; with it, it did
   not. Verified (2026-10-24, RESULTS.md H14b). The page-level bypass also covers a cross-site iframe: with no bypass
   at all, a worker of the session started when the iframe stub loaded and the canary stopped the job
   (`service-worker-started`); the worker's scope origin, read from the `ServiceWorker` CDP domain, was the
   `127.0.0.1` iframe's, so it was progress-lab's own partitioned worker under `localhost` (the host page registers
   none); with the page-level bypass alone (none sent
   to the iframe's own target), and with the full bypass, the job was clean. Verified (2026-10-28, the no-bypass iframe
   control in `apps/desktop/e2e/quiescent.spec.ts`, Electron 45.0.0, macOS arm64; open check 3). The per-child bypass
   stays: it costs one command per target.
7. **Stub navigations.** Keys are grouped by top-level stub origin `T`, taken from the job's `top` keys first. One
   navigation to `<T>/__wg_quiescent__?job=<nonce>` resolves `T`'s own key in the top frame (only if it is part of the
   job) and, as iframes pointing to the same path, every partitioned key whose `topLevelSite` is the site of `T` and
   every first-party `frame` key of that site. A key left over gets its own navigation: its exact origin when first-party,
   its `topLevelSite` when partitioned. The window visits the groups one after another; the bypass and the canary cover
   all of them, and steps 8 to 10 repeat per navigation with fresh request nonces. `Assumed`
8. **Keys.** Resolve and check every frame's storage key (section 2).
9. **Handshake.** Each preload instance sends one `ipcRenderer` message with the job nonce. The main process accepts it
   only from the job's `webContents`, from a frame whose URL is an expected stub URL, with the right nonce; it then
   gives that frame one end of a `MessageChannelMain` whose other end goes to the snapshot worker.
10. **Commands.** The worker sends typed commands (`inventory`, `export`, `import`, `wipe-selected`) with request ids;
    both ends validate every message with zod and abort on anything unexpected.
11. **Canary, during the whole job.** Every `Debugger.scriptParsed` on every target must come from our preload's
    isolated context (its execution context and source URL, an allowlist fixed by a Phase 1 calibration test); any
    other parsed script, any service worker target, or any `running-status-changed` of the session to `starting` or
    `running` aborts the job with `EXP_QUIESCENCE_VIOLATION` or `IMP_QUIESCENCE_VIOLATION`. The canary is the real
    evidence that no game code ran; the fixture's request log could not tell bypass from no bypass. Verified
    (2026-10-24, RESULTS.md H14).
12. **Finally.** In `try`/`finally`, whatever happened: destroy the window, detach the debugger, `ses.protocol.unhandle`
    both schemes, remove the `webRequest` listener, release the lock. A watchdog ends a job that exceeds its deadline
    (Assumed: 60 s plus 1 s per MiB).

**Hardening requirements (MUST; from the review of the spike code).**

- **QW-1 Fail closed.** The interceptor answers only the exact stub URLs of the current job (expected origins, path
  `/__wg_quiescent__`, the job nonce). Every other request gets `403` with an empty body. There is no passthrough to the
  network (`ses.fetch` or `net.fetch`); the spike's passthrough was fail-open.
- **QW-2 Exclusive partition.** While the interceptor is registered, the quiescent window is the only `webContents` on
  that session; the job checks this before the first stub navigation, and the lock prevents a game launch until the
  final step.
- **QW-3 No leak on throw.** Registration and removal are paired in `try`/`finally` (step 12); a unit test makes each
  step throw and checks that nothing stays registered.
- **QW-4 Authenticated IPC.** Every message from the quiescent window is checked against `event.senderFrame` (job
  `webContents`, expected stub URL) and carries a request nonce of at least 128 random bits (`crypto.randomBytes`), not a
  counter.
- **QW-5 Typed commands only.** The preload exposes nothing to the main world (no `contextBridge`) and never evaluates
  code it receives: no `eval`, no `new Function`, no `executeJavaScriptInIsolatedWorld` with a received string. If an
  extra isolated world is ever needed, its code is a build-time constant.
- **QW-6 Subframes only when needed.** The preload runs in subframes only for jobs with a key resolved in an iframe
  and stays inert in any frame whose URL is not an expected stub URL.
- **QW-7 Data is data.** Snapshot bytes pass through the message port or files, never spliced into a code string.
- **QW-8 No credentials.** The exporter never reads cookies or other credentials (section 4, step 6).
- **QW-9 Quiet logs.** Logs carry job id, game id, step, counts, byte sizes and error codes; never values, localStorage
  key names, database contents or URLs with query strings (origins only).
- **QW-10 Inert stub.** The stub is `text/html` with `Cache-Control: no-store` and
  `Content-Security-Policy: default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-src <the
  job's iframe stub origins>`; its body holds only those iframes. The spike's subframe preload worked under a stub with
  `script-src 'none'`. Verified (2026-10-24, RESULTS.md H14c). That no page CSP can restrict a preload is Assumed.

**Implementation (Phase 1 Task 13).** `apps/desktop/src/main/snapshots/` (`quiescent/{job,interceptor,stub,layout,
handshake,canary,channels}.ts`, `export.ts`, `storage-check.ts`, `keys.ts`, `jobs.ts`), the snapshot worker
`apps/desktop/src/main/worker/` and the preload `apps/desktop/src/preload/quiescent.ts`. `Assumed` unless tagged
otherwise.

- **Steps.** `runQuiescentJob(gameId, plan, deps, signal)` runs steps 1 to 12 in order; a plan names its lease kind
  (`task` for what the user asked, `background` for a storage check), its keys, `runFrames` (once per navigation, with
  that navigation's connected frames) and `commit` or `discard`. `commit` runs after the canary's clean verdict and
  the window's teardown, still under the lease, which is released last. A launch that cancels a `background` lease
  (plan M5), the caller's signal, the canary and the watchdog all stop every wait at once; the cancelled job returns
  `CANCELLED` and lets go of the lease. Verified (2026-10-28, `apps/desktop/e2e/quiescent.spec.ts`: a launch during a
  held storage check opened the game in under 2.5 s and the check was cancelled; an export right after a close
  cancelled the running check the same way). An aborted job's signal carries why it stopped, so a commit returns
  that code (the watchdog's `EXP_TIMEOUT`, a cancellation's `CANCELLED`); a commit that has not settled when the
  job is stopped is left to the plan's `discard`, which must end its work (the export kills its worker and waits for
  the exit before it removes the revision's files). At most two jobs run at once in the process, and a user task
  takes a storage check's slot by cancelling it (security.md section 8, architecture.md section 4 "Lock details"). A job's worker is started once and killed when the job ends, also when the job
  was stopped while the worker was still starting (`worker/slot.ts`); the kill resolves once the process has exited,
  and the worker's pending requests fail then, not before. Each step throwing once
  leaves no protocol handler, `webRequest` listener, debugger listener, handshake listener, worker listener or window
  behind and releases the lease (QW-3, `job.test.ts`). QW-2 counts the `webContents` on the game's session before
  the first stub navigation.
- **Stub URLs.** `<origin>/__wg_quiescent__?job=<nonce>&key=<k>` for a frame that resolves manifest key `k`, without
  `key` for a top page that only hosts iframes (the preload stays inert there, QW-6). The interceptor serves exactly
  the job's stub URLs for `GET` on both `http` and `https`, whatever the build (fail closed), and the `webRequest`
  layer cancels everything else; the job logs the refused origins. Navigations follow step 7 (`layout.ts`).
- **Handshake.** The preload sends `{job}` on `wg:quiescent:hello`; the job listens on its own window's
  `webContents.ipc`, so concurrent jobs never see each other's hellos; it checks the sender, the frame URL and the
  nonce (`timingSafeEqual`), once per frame, then sends one end of a `MessageChannelMain` on `wg:quiescent:port` with
  `WebFrameMain.postMessage`; the other end goes to the snapshot worker with the frame command. The worker sends the
  typed commands with a fresh nonce each (`randomBytes(16)`), validates every reply with `FrameReply` and closes the
  port on anything unexpected; a frame silent for 30 s is `EXP_TIMEOUT`.
- **Canary calibration.** In a clean job Electron 45 parses, per document of the window (`about:blank`, each stub and
  each cross-site iframe), exactly three scripts in the preload's isolated world: `electron/js2c/event_emitter_dispatch`,
  the preload file (its path is the script URL) and a 6-character `void 0` without a URL. Electron names that world
  "Electron Isolated Context" in a top-level frame and leaves it unnamed in a cross-site iframe's own target. Every
  other script, a script in the default world, any worker target or a session worker `starting` or `running` stops
  the job. The allowlist is pinned to exactly that: the one Electron module, the preload's world as named in the
  page's own session or unnamed only in a child target, and a context the canary saw announced
  (`Runtime.executionContextCreated`; any other is a violation). Verified (2026-10-28,
  `apps/desktop/e2e/quiescent.spec.ts` "calibration": 2 of each for a plain job, 3 for the iframe job, nothing
  refused; an injected main-world script and a worker started during the job were each flagged, S-13). Two findings shaped it: zod 4.6.7 builds object parsers with `new Function` and probes
  `new Function("")` when a schema is created, which the canary saw as a 28-character script without a URL, so the
  preload sets `z.config({jitless: true})` before any schema exists (`zod-jitless.ts`); and Playwright's `_electron`
  attaches to every page, the quiescent window included, and evaluates an empty script in its own
  `__playwright_utility_world_*` world, which the test flavor alone names as the harness's world (counted apart,
  never in the default world). Verified (2026-10-28, e2e runs before and after each change).
- **Isolated world.** The preload's world reads IndexedDB values with that world's own prototypes: progress-lab's
  Date, ArrayBuffer, Uint8Array and Blob values were exported without `EXP_UNSUPPORTED_VALUE` (the exporter's
  classifiers accept exact prototypes only), with the Blob as one blob entry. `navigator.storage.estimate()` has
  `usageDetails` there: a session with Cache Storage and a registered worker gave `notExported` `cacheStorage` and
  `serviceWorkers` (open check 8). Verified (2026-10-28, `apps/desktop/e2e/export.spec.ts`).
- **Worker.** One `utilityProcess` per job (`out/main/snapshot-worker.js`, a second main entry), killed when the job
  ends. Main and the worker exchange only `WorkerCommand`/`WorkerEvent` (zod, bounded strings and lists, no data
  bytes). The worker assembles each frame's chunks under the job's limits (`maxEntryBytes` on the declared size before
  a byte is kept, `maxEntries`, and `maxTotalBytes` over the data from the declared size before an entry's buffer is
  allocated and again as entries complete), refuses a file outside the
  frame's own `data/<k>/` or a blob not named by its SHA-256, and reports measured bytes (`received`). `write` runs
  the writer into `tmp/<revisionId>.wgsnap.partial` (`wx`, flushed with `fsync`), reads that file back through
  `validateSnapshot` with its `stat` size and the same limits, renames it to `snapshots/<gameId>/<revisionId>.wgsnap`
  only when it validates and no file of that revision exists, and flushes that directory (skipped on Windows,
  Assumed); any failure removes the partial file. So save data
  above a limit fails with its `SNAP_*` code (`SNAP_TOTAL_TOO_LARGE` from the collector or writer,
  `SNAP_RATIO_EXCEEDED` and `SNAP_FILE_TOO_LARGE` from the read-back) and a disk error is `INTERNAL` with the error
  code in the message ("The snapshot file could not be written (EIO).", the test-flavor fault `fail-write`); in both
  cases nothing is left in `tmp/` or `snapshots/` and no row is written (Review Focus 4 and 5). Verified (2026-10-28,
  `apps/desktop/src/main/worker/write.test.ts` and `apps/desktop/e2e/export.spec.ts`). The worker keeps a job's
  entries in memory until `write` (the writer takes whole files), so its memory follows the save data, up to
  `maxTotalBytes`.

## 6. Restore protocol

Each step is written to `restore_journal` ([architecture.md](architecture.md#7-sqlite-schema-v1)) before it starts.

| Step | What happens | On failure |
| --- | --- | --- |
| R1 Validate | Full validation in the snapshot worker ([snapshot-format.md](snapshot-format.md#8-limits-and-error-codes)) of a private copy in `tmp/` (an external file is copied first, [security.md](security.md#8-archive-safety-and-resource-limits)); a `revisionId` already stored is reused when its `contentHash` matches | The `SNAP_*` code or `IMP_REVISION_CONFLICT`; nothing written |
| R2 Plan | From the validated manifest, check the keys and the confirmed mapping (section 2) and compute the wipe set: the snapshot's keys (mapped) plus all known keys of the game | `IMP_STORAGE_KEY_MISMATCH`; nothing written |
| R3 Lock | Per-game exclusive lock; game window closed. Then R2 runs again under the lock (the game may have run in between and recorded new frames); if the result differs from what the user confirmed, the job stops | `GAME_RUNNING` (AC-11), `GAME_BUSY`, `NEEDS_RECOVERY` or `IMP_PLAN_CHANGED`; nothing written |
| R4 Backup | Export every known key with the generic exporter and no adapter filter to `backups/<gameId>/<revisionId>.wgsnap` (written as `.partial`, read back and validated, then renamed); recorded with kind `backup` | `IMP_BACKUP_FAILED`; nothing wiped, the partial file removed |
| R5 Wipe | In one quiescent window that visits every key of the wipe set (section 5, step 7): CDP `Storage.clearDataForStorageKey` with each frame's key and `local_storage,indexeddb`; for a selective (adapter) restore, the importer removes only the selected localStorage keys and databases instead; then an inventory confirms emptiness | `IMP_WIPE_FAILED`, rollback |
| R6 Import | Section 4, from a second streaming pass over the file that re-checks every entry hash | `IMP_*` code, rollback |
| R7 Verify | Re-export the same scope and compare `contentHash` with the expected hash (mapped if a mapping was confirmed) | `IMP_VERIFY_MISMATCH`, rollback |
| R8 Commit | Journal `done`; `base_revision_id` becomes the restored snapshot's `revisionId`; lock released; "Local data" rechecked | (none) |

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
- **Delete local saves** (PRD section 9, AC-16) is R3 (the wipe set is all known keys, computed under the lock), R4
  and R5, then R8 with `base_revision_id` set to `null` (the partition no longer descends from any revision); a failure
  after R5 restores the backup in the same way. **Verify** (`snapshot:verify`) is R1, then R6 and R7 into a fresh
  in-memory partition (`wg-verify-<nonce>`, no `persist:` prefix) whose data is cleared afterwards; it never touches the
  game's partition. A non-`persist:` partition lives in memory. Verified (2026-10-24,
  <https://www.electronjs.org/docs/latest/api/session>). Passing it sets "Export verified" for that exporter version
  ([architecture.md](architecture.md#11-badges)).

**Export** (`snapshot:export`): lock; stop service workers; quiescent export of the game keys with the adapter's scope;
the worker writes `tmp/<revisionId>.wgsnap.partial`, reads it back through the full validator, fsyncs and renames it to
`snapshots/<gameId>/<revisionId>.wgsnap`; the database row records the manifest fields and `base_revision_id` moves to
the new revision (below). Export never changes the game's storage apart from the aborted probe of section 4. `Assumed`
In Phase 1 Task 13 (`apps/desktop/src/main/snapshots/export.ts`, `Assumed`): the game keys are every top-level origin
(the entry URL's and those observed in `storage_targets`), the frame keys an adapter declares that were observed, and
the frame keys the user chose in `snapshot:export {frameKeys}`; without a choice, the remembered one (`in_export`).
A chosen key that is not a frame of the game is `INVALID_ARGUMENT`; more keys than a manifest holds
(`maxStorageKeys`, 32) is `SNAP_MANIFEST_INVALID`, the code snapshot-format.md section 4 gives such a manifest. The
choice is remembered (`in_export`) only when the export commits, in the same database transaction as the row and the
game's base revision; any failed write removes the revision's partial and final file, so neither a row without its
file nor a file without its row is left (`export.test.ts`). A frame of the same site as its top-level page is
first-party storage, a cross-site frame is partitioned under its top-level site (`keys.ts`). The adapter is the one
whose `match.origins` holds the entry URL's origin. The row's `path` is relative to userData, and the export commit
sets `base_revision_id` to the new revision, so a second export's parent is the first. Verified (2026-10-28,
`apps/desktop/e2e/export.spec.ts`: plain, service-worker running at the start, cross-site iframe with and without the
frame chosen, the choice remembered, an unknown frame refused, AC-11 while the window is open).

**Revision parents.** `games.base_revision_id` names the revision the partition's data descends from, and every new
snapshot's `parentRevisionId` is its current value. It moves in exactly three places: an export commit sets it to the
new `revisionId`; a restore commit (R8) sets it to the restored `revisionId`; "Delete local saves" sets it to `null`.
Pre-import and pre-delete backups, verifications, failed jobs and rollbacks never move it. So consecutive exports form a
chain (E1, then E2 with parent E1), and two revisions share a parent only when the user restored an older revision and
exported again, or, later, when another device continued from the same revision
([architecture.md](architecture.md#15-future-cloud-sync)). `parentRevisionId` is immutable once written. `Assumed`

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
- Settled in Phase 1 Task 12 (`packages/exporters/src/flush.ts`, `Assumed`): the observation carries the declared
  hook, the hook's `timeoutMs`, whether the flush flow requested the export, the hook run (`not-run`, `returned` with its
  value, `threw`, `timed-out`, with start and finish times), the times of user input and the time the launcher closed
  the window (`null` if it did not). "Before its timeout" means strictly less than `timeoutMs` after the start; input
  at the hook's start or at the close counts; the close must come at or after the hook's finish; a time that is not a
  finite number gives `unconfirmed`.
- The generic exporter has no hook, so every MVP snapshot without such an adapter is `unconfirmed`. `Assumed`. Phase 1
  Task 13 takes the manifest's and the row's `flushState` from `decideFlushState` with no hook run, so every export is
  `unconfirmed`, and `snapshot:list` carries it to the UI. Verified (2026-10-28, `apps/desktop/e2e/export.spec.ts`).
- The decision is one pure function, `decideFlushState(observation)`. Its unit test (AC-12) uses a fake hook: none,
  success, error, timeout, a value other than `true`, input after the hook started, and a late close; only the success
  case without input and with a prompt close gives `confirmed`. A UI test checks that every place showing an
  `unconfirmed` snapshot shows "flush unconfirmed" and never "save point", "guaranteed" or "complete".
- The hook runs in the game page's main world through `webContents.executeJavaScript` from a fixed template. Its only
  parameter, the adapter's `module`, MUST match `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$` and is inserted only as a JSON string
  literal for a property lookup on `globalThis` (`globalThis["Module"]`), never as code. Adapters are bundled with the
  app (section 8), so the value is ours, and the check runs again at load. The page could fake the result, which only
  affects its own snapshot; that is accepted. `Assumed`

## 8. Declarative adapters

Adapters are JSON data, never code (AGENTS.md security invariant 7). In v1 they ship inside the app
(`packages/exporters/src/adapters/*.json`), are validated by the unit tests and when `src/adapters/index.ts` loads, and
user-supplied adapters are not loaded. `Assumed`

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
- `match.origins` are exact origins compared with the game's top-level origin, at least one per adapter (`Assumed`). `frameKeys` lists partitioned keys
  (`{origin, topLevelSite}`) that belong to the game, which the user then need not confirm.
- localStorage selectors are key prefixes; IndexedDB selectors are whole database names, matched exactly. No regular
  expressions or globs (no ReDoS, predictable scope). Store-level filtering is not offered, because a database restored
  at its version without some of its stores would break the game's upgrade logic. `Assumed`
- `flush.hook` is `none` or `emscripten-idbfs` with `module` (matching the identifier pattern of section 7, default
  `Module`) and `timeoutMs`
  (an integer from 1 to 30 000). The `emscripten-idbfs` hook calls `FS.syncfs(false, callback)` on that module object. `Assumed`
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
| AC-24 | integration: progress-lab exported on `localhost` with a nested `127.0.0.1` iframe, restored where the keys differ: refused naming both keys and nothing written; with a confirmed mapping every record lands under the mapped key. Also: the iframe moved to another host or port under the same top origin is refused (or mapped) the same way, and a target without frame observations asks for confirmation listing the unchecked frame keys and writes nothing without it |
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
- Game-native "download save" buttons do not work in the MVP: downloads and the File System Access API are denied
  ([security.md](security.md#5-permission-and-navigation-policy)). `Assumed`
