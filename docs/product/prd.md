# Product requirements: wg-launcher MVP

Status: draft for Phase 0, 2026-10-24; updated 2026-10-25 after the specifications and ADRs were written. Codename
`wg-launcher`; the display name is open. Sources: the owner's concept
document [concept-v1.0.ru.md](sources/concept-v1.0.ru.md) (Russian, kept verbatim), the owner's decisions of 2026-10-24
(recorded in [MEMORY.md](../../MEMORY.md) and the [Phase 0 plan](../plans/2026-10-24-phase-0-foundation.md)) and the
research in [foundations.md](../research/foundations.md) and
[runtime-and-storage.md](../research/runtime-and-storage.md).

## How to read this document

Each requirement carries a marker for who decided it:

- `Owner`: decided by the owner (the original brief or the plan's "Owner decisions").
- `Concept`: stated in the concept document, a working description by the owner that is not confirmed as a decision.
- `Assumed`: a call made while writing this document; the owner can override it.

Facts about the outside world carry the claim tags from [AGENTS.md](../../AGENTS.md#documentation-rules). Ids: `F-n`
features, `AC-n` acceptance criteria, `OQ-n` open questions.

## 1. Summary

wg-launcher is an open-source desktop library and launcher for web games (JavaScript, WebAssembly, WebGL, WebGPU). The
user pastes an HTTPS link and gets a library card. The game runs locally, in its own window, with its own persistent
browser session. For compatible games the launcher exports a snapshot of the saves and restores it somewhere else. It
is not cloud streaming, not a reverse-engineering tool and not an automatic converter of games to native code. `Owner`

## 2. Problem and users

| Audience | Who | Marker |
| --- | --- | --- |
| Primary | People who try fan ports, independent web games and browser emulators and want to come back to them without hunting for old links | `Concept` |
| Secondary | Authors of web games who want a desktop way to distribute their game without writing their own launcher; served by the "integrated" support mode, which is later | `Concept` |

Problems the product addresses (`Concept`):

- Games are scattered across sites and links get lost.
- A game window mixes with work tabs in a normal browser.
- Local progress is hard to move to another computer.
- It is unclear what takes space and what a "clear data" action will delete.

What the product does not claim (`Owner`): that heavy fan-made web ports of major commercial games are complete, that a
free market for them exists, or that every web game will work. The Cyberpunk port found during the early discussion was
never verified. The catalog may only contain links that were really checked and builds that may legitimately be
distributed.

## 3. Value hypothesis

- Users want one library with predictable progress storage. "People do not like playing in a browser" is not enough on
  its own: for many players a link with no install is an advantage. `Concept`
- The difference shows only in repeat use: returning to the library, restoring progress, continuing on another computer.
  `Concept`
- The hypothesis holds only if repeat use is observed (return visits, restores). How that will be observed is not defined
  yet (OQ-4). `Assumed`
- The concept's business idea (a free client with paid extra cloud volume) has no pricing or willingness-to-pay research
  behind it, and no store or payment infrastructure is built before repeat use is confirmed. `Concept`

## 4. Support modes

| Mode | Behavior | Limits of the promise | Stage |
| --- | --- | --- | --- |
| By link | Opens the original site in a game window | The site and its servers must be reachable; some sites may not work in an embedded environment | MVP |
| Local package | Runs a full game package locally | Needs a compatible build and known dependencies; server features may still need a network | Later |
| Integrated | Uses a manifest, adapter or author SDK | Saves, versions and offline can be supported more reliably | Later |

The product does not promise to download any site automatically; a browser cache is not an installation. `Concept`

## 5. Vertical scenario

The first end-to-end scenario, run on the controlled test game `progress-lab` (later also on at least one real
compatible game). `Owner`

1. Add a URL.
2. Save the card locally.
3. Launch the game in a separate window.
4. Change verifiable progress.
5. Close the window.
6. Reopen the game and confirm the data persisted.
7. Export a snapshot.
8. Restore it in a clean session.
9. Verify the same progress.

The scenario is done when AC-6 passes.

## 6. MVP features

| Id | Feature | Priority | Marker |
| --- | --- | --- | --- |
| F-1 | Library of cards (title, cover, badges, Play), stored locally; no account needed | Must | `Owner` |
| F-2 | Add a game by HTTPS URL; the card gets a stable internal `gameId` (UUIDv7) that does not depend on the URL | Must | `Owner` for the stable id, `Assumed` for UUIDv7 |
| F-3 | Edit the card by hand: title and cover | Must | `Owner` |
| F-4 | Delete an entry, with the three distinct actions in section 9 | Must | `Owner` |
| F-5 | Game window: separate window, own persistent browser session `persist:game:<gameId>`; a second launch focuses the existing window | Must | `Owner` for the session, `Assumed` for the focus rule |
| F-6 | Fullscreen mode | Must | `Owner` |
| F-7 | Remember window state (size, position, fullscreen) per game | Must | `Owner` |
| F-8 | Shortcut that calls the shared client with the game id; no separate bundle per game | Must | `Owner` |
| F-9 | Playtime by the explicit rule in section 8 | Must | `Owner` |
| F-10 | Honest badges from recorded state (section 7) | Must | `Owner` |
| F-11 | Save export and import UI, working for at least one controlled game (section 10) | Must | `Owner` |
| F-12 | Search and favorites | Should | `Concept` |
| F-13 | Diagnostics for load errors and graphics capabilities | Should | `Concept` |
| F-14 | The client proposes a title and cover when a URL is added (both stay editable) | Should | `Concept` |

Platform behavior of F-6 to F-8 is specified in [architecture.md](../specs/architecture.md#8-shortcuts-and-deep-links)
(shortcuts and deep links, section 8) and [architecture.md](../specs/architecture.md#9-window-state-and-fullscreen)
(window state and fullscreen, section 9); the platform status is in section 11.

## 7. Honest badges

Badges come from recorded state only. A badge is shown if and only if its condition holds. `Owner`

| Badge | Shown when | Marker |
| --- | --- | --- |
| By link | The entry's support mode is "by link" (the only mode in the MVP) | `Owner` |
| Needs internet | The entry depends on the original site; in the MVP this coincides with "By link", and it becomes a separate state when local packages exist | `Assumed` |
| Local data | The game's own session holds data (storage usage above zero at the last check; the check time is recorded) | `Owner` |
| Export verified | A round trip (export, restore, compare) passed for this game with the current exporter version; the round trip ("Verify") is defined in [save-transfer.md](../specs/save-transfer.md#6-restore-protocol) and the badge condition in [architecture.md](../specs/architecture.md#11-badges) | `Owner` for the meaning, `Assumed` for the exporter-version condition |
| Compatibility not verified | The default; it is removed only by a recorded verification (the MVP has no catalog, so it appears on every entry) | `Owner` |

- Never shown: install, sync, FPS or download indicators or progress bars that have no real state behind them; a
  completion percentage; achievements. `Owner`
- Later badges from the concept: "Installed locally", "Cloud saves supported", "Local progress only". `Concept`

## 8. Playtime rule

`Owner` for having an explicit rule, `Concept` for "only while the game window is active", `Assumed` for the numbers.

- Playtime accrues while the game window is visible and focused.
- It stops on blur, minimize, system suspend and screen lock.
- A session shorter than 10 seconds is dropped, not recorded.
- The launcher knows session time and the last launch date. It does not know completion percentage, achievements or
  events inside the game; those need an integration with the game. `Concept`

## 9. Delete semantics

Three distinct actions with different consequences. Each has its own confirmation that says what will be lost. `Owner`

| Action | Removes | Keeps | Safety |
| --- | --- | --- | --- |
| Remove from library | The card and its metadata | Snapshots and backups | The game's live session storage stays as orphaned data until the user deletes it (OQ-2, decided in [architecture.md](../specs/architecture.md#12-library-entries-and-delete-semantics)) |
| Clear cache | Cache, shader cache and service workers (asset cache, never game data) | Game data, snapshots, backups | None needed |
| Delete local saves | The game's localStorage and IndexedDB data | Snapshots, backups, and OPFS and other file-system data (v1 cannot back those up, so it does not delete them; the dialog says so) | A backup is made and verified first |

Backups are never deleted automatically or as a side effect of another action. A way to prune them by hand is not part
of the MVP. `Assumed` for "backups are never auto-deleted silently" (it is in the plan's "Design decisions the specs
must encode", approved with the [Phase 0 plan](../plans/2026-10-24-phase-0-foundation.md), and tagged the same in
[architecture.md](../specs/architecture.md#12-library-entries-and-delete-semantics)); `Concept` for "deleting a game must
not silently destroy backups" (concept section 11); `Assumed` for the wider wording above, for the missing manual
pruning, and for keeping OPFS data ([save-transfer.md](../specs/save-transfer.md#1-data-versus-cache): a delete without
a backup is forbidden, and OPFS cannot be backed up in v1).

## 10. Saves and snapshots

| Where progress lives | MVP support | Marker |
| --- | --- | --- |
| localStorage | Export and restore before launch | `Owner` |
| IndexedDB | Export and restore, including binary types, key paths, indexes and the database version | `Owner` |
| Emscripten IDBFS (stored in IndexedDB) | Through the IndexedDB exporter; the snapshot is labeled "flush unconfirmed" unless a known flush hook confirmed completion; a real Emscripten fixture comes later | `Assumed` |
| OPFS and other virtual file systems | Later, as an adapter | `Concept` |
| The game's own server | Not exported; the game's account serves it | `Owner` |
| Process memory only | Not supported; no universal suspend and resume | `Owner` |

Rules (`Owner`): never read the files of a live browser profile; never export or sync a whole profile, cookies or
tokens; keep game data apart from asset cache; back up before every import and restore the backup if anything fails;
version every snapshot (game id, exporter and adapter version, content and hash, parent revision, device, game version
when known); treat archives as hostile; an unsupported value type is an explicit error. A game is called
export-capable only after a restore was verified.

Storage keys and origins:

- A snapshot records the full storage key of the data it holds: the origin, plus the top-level site for storage of
  partitioned third-party iframes. Since Chrome 115 that storage is keyed by the iframe's origin and the top-level site.
  Verified (2026-10-24, <https://developer.chrome.com/docs/privacy-sandbox/storage-partitioning>). Nested origins (a game
  running in an iframe on another origin) are recorded separately. `Owner`
- A change of scheme, host, port or top-level site between export and restore changes which storage the game sees. A
  restore under a changed key is refused with an explicit error naming both keys, or goes ahead only through a mapping
  the user confirmed. It is never a silent no-op and never a silent partial restore (AC-24). `Owner` for the
  requirement (the brief and concept section 9), `Assumed` for the exact interaction.

Flush state:

- Closing a window does not prove that a game flushed its storage. Each snapshot records a flush state in its manifest
  (the field name is decided in the snapshot spec): `confirmed` only when a known flush hook or adapter reported
  completion before the export, otherwise `unconfirmed`. The generic exporter has no hook, so its snapshots are
  `unconfirmed` unless an adapter says otherwise. `Assumed`
- An `unconfirmed` snapshot holds the persisted storage state only. The UI labels it "flush unconfirmed" and never
  presents it as a guaranteed save point. The "Export verified" badge needs a successful round trip and says nothing
  about flush. `Assumed` (an MVP compromise: no universal flush hook exists, so a snapshot is never claimed safer than it
  is; AGENTS.md invariant 4 says the same)

## 11. Platforms

| Platform | Role | Status |
| --- | --- | --- |
| macOS arm64 | First tested platform; the dev machine | Tested in the runtime spike on one machine, a MacBook Air with an Apple M3 on macOS 27.0.1: Electron 45.0.0 passed isolation, persistence, cross-origin isolation, WebGPU, hardware WebGL2 and the save-transfer checks; frame time against Chrome (H7) is deferred to Phase 1. No game is verified, because the launcher does not exist yet. Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md), [matrix.md](../compat/matrix.md)) |
| Windows | Target platform | Not tested. CI runs only install and unit tests on `windows-latest` (the fixture's browser tests do not run there), which says nothing about game compatibility; no Windows machine is available. Verified (2026-10-25, [ci.yml](../../.github/workflows/ci.yml), [matrix.md](../compat/matrix.md) "Not tested") |
| Linux | Next stage, after GPU, input and packaging checks on chosen distributions | Not tested. CI on Ubuntu runs lint, typecheck, license and docs checks and the fixture's Chromium tests, which prove nothing about the launcher or games. `Concept` for the plan; Verified (2026-10-25, [ci.yml](../../.github/workflows/ci.yml)) for the CI coverage |
| iOS and Android | Future, a separate client | Not tested. Out of scope for version 1 (`Owner`). App Store guideline 2.5.6 requires apps that browse the web to use WebKit; alternative engines need an entitlement available only in the EU and Japan. Verified (2026-10-24, <https://developer.apple.com/app-store/review/guidelines/>, guideline 2.5.6). A future iOS client is therefore assumed to be a separate WebKit-based client, and desktop Chromium code cannot be assumed reusable there. Android's system WebView is Chromium-based. Assumed |

- Electron 45 builds only for x64 and arm64. Verified (2026-10-24, <https://releases.electronjs.org/release/v45.0.0>).
- The runtime is Electron 45.0.0, decided by [ADR-0002](../adr/0002-desktop-runtime.md): accepted by the owner on
  2026-10-25 on the condition that Phase 1 re-measures H7 (frame time) on the launcher against Chrome. Tauri was not
  built (owner-approved scope change); Safari served only as a labeled WebKit proxy. `Owner`
- An unsupported or untested OS is never called verified. A game, runtime or OS is verified only after a real recorded
  run in `docs/compat/` (date, version, machine). `Owner`
- Snapshots must not depend on Chromium internals, so a WebKit or WebView client could read them later. Assumed

## 12. Non-goals

Out of scope for version 1. `Owner` unless marked.

- A store, payments, chat, friends, achievements, a mobile client.
- Reverse engineering of games, a universal downloader of arbitrary sites, automatic conversion of games to native code,
  cloud streaming.
- Saving process memory, importing from a normal browser (Chrome, Safari), continuing on a phone.
- Cloud sync before local export and import are proven.
- Offline play, except for prepared compatible packages (a later stage). Adding a link keeps the dependency on the site.
- An account for the local library; deploying cloud infrastructure without a concrete need.
- Mods and overlays. `Concept`

## 13. Anti-goals

Outcomes that make the product a failure even if it appears to work. `Owner`

1. Fake indicators: install, sync, FPS or download progress, completion percentage or achievements with no real state
   behind them.
2. Silently losing saves: a failed import that destroys the original, trusting a closed window as a flush, ignoring a
   quota failure, a delete action that also removes backups.
3. Claiming compatibility that was not verified: a game, runtime or OS called supported without a recorded run, a Windows
   claim based on a CI runner, speed or memory numbers without a measurement.
4. Giving games privileged access: Node.js, filesystem access, administrative IPC, a session shared with the launcher UI, or
   a loosened `webSecurity` to make one site work.
5. Exporting or syncing a whole profile, cookies or tokens, or copying a live browser profile's files.
6. Merging two links into one game without confirmation, or using the URL as the game's identity.
7. Abstractions with nothing behind them: Rust as an empty process, a separate Electron bundle per game.
8. Resolving cloud conflicts by "last clock wins".

## 14. Cloud sync (Later)

Not part of the MVP. It starts only after local export and import are proven (AC-6 to AC-9). `Owner`

- Accounts are needed only when the cloud is connected. The local library never needs one. `Concept`
- Sync protocol: check the cloud version, fetch and verify the object, restore a compatible copy, launch the game, export
  a new snapshot at a valid save point, publish the new revision atomically. `Concept`
- Revision rule: every snapshot has a parent revision; the device clock is for display only and never decides which
  progress is newer. If two machines changed the same base revision, both branches are kept and the user chooses; one is
  never discarded silently. A local backup precedes every import. On a quota failure the local data stays and the error
  is explained. `Owner`
- Playing offline is allowed; its result syncs later. `Concept`
- The backend is described as an interface only. If one is needed later, the candidate stack is NestJS, PostgreSQL and
  S3-compatible object storage; no provider is chosen and nothing is deployed. `Owner`
- End-to-end encryption is a possible later feature, not an MVP promise. `Concept`

## 15. Licensing commitment

- The whole repository is `AGPL-3.0-or-later`; commercial use is possible only by separate agreement, outside
  contributors sign a CLA, and any future paid features live only in one named source-available directory (none exists).
  `Owner`
- The core stays free and AGPL-licensed: the game library, launching games, local saves and snapshots (export and
  restore), and progress tracking. `Owner`
- Whether cloud storage will be paid is undecided (OQ-6). Details and the trademark policy are in
  [LICENSING.md](../../LICENSING.md). Not legal advice. `Assumed`

## 16. Acceptance criteria

Test types: unit, integration, e2e (the launcher driven end to end), manual. Planned tests live where the code will
live (`apps/desktop`, `packages/snapshot`, `packages/exporters`, `fixtures/test-games/progress-lab`); none of these
acceptance tests exists yet (the fixture has its own suite).
Stage "Later" means it depends on work after the MVP.

| Id | Criterion (testable) | Test type | Stage |
| --- | --- | --- | --- |
| AC-1 | After a full restart, an added game is still in the library with the same title, URL, cover and `gameId`, and Play opens it from the library and from its shortcut | e2e | MVP |
| AC-2 | Two entries (including two entries with the same URL) get different `gameId` and partitions; localStorage, IndexedDB and cookie markers written by one are absent in the other; the launcher UI shares no session with any game | integration, e2e | MVP |
| AC-3 | In a game window there is no `require`, `process` or launcher bridge, and game content cannot reach launcher IPC; the window factory is unit-tested for `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload and `webSecurity` on | unit, e2e | MVP |
| AC-4 | In a game session camera, microphone, geolocation, notifications and display capture are denied and logged, while fullscreen, pointer lock and keyboard lock are allowed | unit (handler), e2e | MVP |
| AC-5 | Navigation off the game's site and `window.open` are blocked or routed by the rules, and downloads are denied in the MVP; `shell.openExternal` accepts only a validated http or https URL after confirmation; the URL decision is unit-tested with `javascript:`, `file:`, a custom-scheme URL, userinfo tricks and lookalike hostnames | unit, e2e | MVP |
| AC-6 | The vertical scenario (section 5) runs automatically on `progress-lab` and ends with an equal `#progress-hash` after the restore | e2e | MVP |
| AC-7 | Export then restore into a clean session reproduces the progress of at least one controlled game (equal `#progress-hash`), with Date, ArrayBuffer, Uint8Array and Blob values preserved, also for the service-worker and cross-site iframe variants | integration, e2e | MVP |
| AC-8 | With a fault injected at each restore step (validate, lock, backup, wipe, import, verify), the state afterwards equals the pre-import state, and the backup exists and verifies | integration | MVP |
| AC-9 | Snapshot validation rejects each of: truncated or malformed input, an absolute path, `..`, a symlink, a hardlink, a device entry, too many entries, oversize content, a bad compression ratio, a bad entry hash, a bad content hash and an unknown format version, each with a distinct error, and nothing is written before validation passes | unit (golden vectors) | MVP |
| AC-10 | A value type the exporter cannot represent fails the export with a named error (key path and type) and is never dropped silently | unit | MVP |
| AC-11 | Export and restore are refused while that game's window is open | integration | MVP |
| AC-12 | The manifest flush state is `confirmed` only when a known flush hook reports completion before the export; with no hook, a failing hook or a timeout it is `unconfirmed`, and the UI then shows "flush unconfirmed" and never calls the snapshot a guaranteed save point; "Export verified" appears only after a successful round trip | unit (fake flush hook) | MVP |
| AC-13 | After a game window is closed, within 5 s (the threshold is `Assumed`) no window of that game and no process belonging to it remain (process list before and after); the same holds after quitting the app | e2e, manual | MVP |
| AC-14 | For each badge, entries in each recorded state show it if and only if its condition in section 7 holds; no UI element indicates install, sync, FPS or download progress without backing state | unit, manual review | MVP |
| AC-15 | With a fake clock and window events, playtime accrues only while the window is visible and focused, stops on blur, minimize, suspend and lock, and drops sessions under 10 s | unit | MVP |
| AC-16 | The three delete actions behave as in section 9: remove keeps snapshots; clear cache leaves game data; delete local saves creates and verifies a backup before wiping | integration | MVP |
| AC-17 | Editing title or cover persists and changes neither `gameId` nor partition; adding a URL that is not HTTPS is rejected (development and test builds also accept `http://localhost` and `http://127.0.0.1`: OQ-3) | unit, e2e | MVP |
| AC-18 | Window size, position and fullscreen state are restored on the next launch; fullscreen toggles from the UI and the keyboard; a fullscreen set by the launcher exits with the toggle, the UI, or Esc held for 1.5 s, and short Esc presses reach the game, because the launcher never takes Esc from a game ([architecture.md](../specs/architecture.md#9-window-state-and-fullscreen), `Assumed`, OQ-8) | e2e, manual (real input on macOS) | MVP |
| AC-19 | The deep link or launch argument for a game id focuses or opens its single window, starts the client first if it is not running, and an unknown or malformed id is rejected without navigating anywhere; no per-game bundle exists | integration, manual (packaged macOS build) | MVP |
| AC-20 | Logs contain no tokens, cookies or save contents; a snapshot contains no cookies, HTTP cache, Cache Storage, service workers or shader cache | unit, integration | MVP |
| AC-21 | Every "verified" statement in the README, docs or UI points to a record in `docs/compat/` (date, version, machine); Windows and Linux entries are absent or "not tested" | manual review | MVP |
| AC-22 | Every published start-up, frame-time or memory number has a measurement record (cold and warm separate, same-machine Chrome comparison, scene id) | manual review | MVP |
| AC-23 | With a fake backend, two devices changing the same base revision produce two kept branches and a user choice; the device clock never decides; a local backup precedes every import; a quota failure keeps the local data | integration | Later (cloud) |
| AC-24 | A snapshot records the full storage key (origin, plus top-level site for partitioned iframe storage). Restoring it where the scheme, host, port or top-level site differs fails with an explicit error naming both keys and writes nothing, unless the user confirmed a mapping, in which case every record lands under the mapped key; no case ends in a silent no-op or a partial restore | integration (`progress-lab` on `localhost` and `127.0.0.1`, with a nested iframe) | MVP |
| AC-25 | With a small real Emscripten program that writes through IDBFS, an export taken after `syncfs` completes contains the latest in-game save, and an export taken before it is labeled `unconfirmed` | integration | Later (needs an Emscripten fixture) |

## 17. Risks and unverified assumptions

| Risk | State | Resolved by |
| --- | --- | --- |
| Electron fails frame-time criteria (H7); it passed isolation, persistence, cross-origin isolation, WebGPU and hardware WebGL2 | Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H1 to H6) for what passed, on one machine; H7 is not measured, deferred to Phase 1 by the owner (2026-10-25) | The Phase 1 H7 re-run on the launcher against Chrome, the condition of [ADR-0002](../adr/0002-desktop-runtime.md) |
| The quiescent-window export and restore mechanism does not work for service-worker or cross-site iframe games | Verified (2026-10-24, RESULTS.md H14) that it worked in four variants on the controlled game; that the page-level service-worker bypass covers subframes is Assumed (no control run) | The MUST tests in [save-transfer.md](../specs/save-transfer.md), [ADR-0005](../adr/0005-save-transfer-mechanism.md) |
| Real game saves (Emscripten flush timing, Unity paths, OPFS) behave differently from the controlled game | Unverified (2026-10-24, not tested) | Later fixtures and real runs |
| Windows and Linux behave differently from macOS | Unverified (2026-10-25, no machine; [matrix.md](../compat/matrix.md) lists both as not tested) | CI for install and unit tests; real runs later |
| The value hypothesis is wrong | Unverified (2026-10-24, not tested with any user) | Repeat-use observation after the MVP |
| [CLA.md](../../CLA.md), [LICENSING.md](../../LICENSING.md) and [TRADEMARKS.md](../../TRADEMARKS.md) have legal gaps | Unverified (2026-10-25, no lawyer review yet) | Lawyer review before outside contributions |

## 18. Open questions

- OQ-1: the product's display name (the codename is `wg-launcher`).
- OQ-2: closed. "Remove from library" keeps the game's live session storage, listed as orphaned data until the user
  deletes it, so an accidental removal cannot destroy progress. Decided as proposed in
  [architecture.md](../specs/architecture.md#12-library-entries-and-delete-semantics). `Assumed`; the owner can override.
- OQ-3: closed. Entries must be HTTPS; plain `http://localhost` and `http://127.0.0.1` are accepted only in development
  and test builds. Decided as proposed in [architecture.md](../specs/architecture.md#12-library-entries-and-delete-semantics).
  `Assumed`; the owner can override.
- OQ-4: how repeat use is measured, and whether any telemetry exists at all (no decision yet).
- OQ-5: whether search and favorites (F-12) and automatic title and cover proposals (F-14) enter the first MVP.
- OQ-6: whether cloud storage is a paid feature; the concept hypothesizes paid extra volume, and the core-free list in
  `LICENSING.md` does not mention cloud.
- OQ-7: closed. WebGPU worked on Electron 45.0.0 without the `enable-unsafe-webgpu` switch (spike H5), so the switch is
  not shipped; shipping it would need an ADR. Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H5);
  the policy is `Assumed`.
- OQ-8: how a fullscreen that the launcher set ends. Default in
  [architecture.md](../specs/architecture.md#9-window-state-and-fullscreen): the toggle, the UI, or Esc held for 1.5 s;
  short Esc presses go to the game. If the owner prefers "every Esc exits", it is a one-line policy change. `Assumed`

## 19. Related documents

- [concept-v1.0.ru.md](sources/concept-v1.0.ru.md): the original concept (Russian).
- [foundations.md](../research/foundations.md) and [runtime-and-storage.md](../research/runtime-and-storage.md): evidence.
- Specifications: [architecture.md](../specs/architecture.md), [snapshot-format.md](../specs/snapshot-format.md),
  [save-transfer.md](../specs/save-transfer.md) and [security.md](../specs/security.md).
- Decisions: the [ADRs](../adr/) 0001 to 0006; the runtime is [ADR-0002](../adr/0002-desktop-runtime.md) and the save
  mechanism [ADR-0005](../adr/0005-save-transfer-mechanism.md).
- [HYPOTHESES.md](../../spikes/runtime-compat/HYPOTHESES.md) (the runtime experiment, written before it ran),
  [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) and the [compatibility matrix](../compat/matrix.md).
- [AGENTS.md](../../AGENTS.md): security, data-safety and honesty rules that these requirements rest on.
