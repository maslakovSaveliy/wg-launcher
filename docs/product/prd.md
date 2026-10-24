# Product requirements: wg-launcher MVP

Status: draft for Phase 0, 2026-10-24. Codename `wg-launcher`; the display name is open. Sources: the owner's concept
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

Platform behavior of F-6 to F-8 follows section 11.

## 7. Honest badges

Badges come from recorded state only. A badge is shown if and only if its condition holds. `Owner`

| Badge | Shown when | Marker |
| --- | --- | --- |
| By link | The entry's support mode is "by link" (the only mode in the MVP) | `Owner` |
| Needs internet | The entry depends on the original site; in the MVP this coincides with "By link", and it becomes a separate state when local packages exist | `Assumed` |
| Local data | The game's own session holds data (storage usage above zero at the last check; the check time is recorded) | `Owner` |
| Export verified | A round trip (export, restore, compare) passed for this game with the current exporter version | `Owner` for the meaning, `Assumed` for the exporter-version condition |
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
| Remove from library | The card and its metadata | Snapshots and backups | What happens to the game's live session storage is open (OQ-2) |
| Clear cache | Cache, shader cache and service workers (asset cache, never game data) | Game data, snapshots, backups | None needed |
| Delete local saves | The game's local data (localStorage, IndexedDB and similar) | Snapshots and backups | A backup is made and verified first |

Backups are never deleted automatically or as a side effect of another action. A way to prune them by hand is not part
of the MVP. `Assumed` (rule from [AGENTS.md](../../AGENTS.md#data-safety-invariants))

## 10. Saves and snapshots

| Where progress lives | MVP support | Marker |
| --- | --- | --- |
| localStorage | Export and restore before launch | `Owner` |
| IndexedDB | Export and restore, including binary types, key paths, indexes and the database version | `Owner` |
| Emscripten IDBFS (stored in IndexedDB) | Through the IndexedDB exporter, only after a confirmed flush; needs an Emscripten fixture first | `Assumed` |
| OPFS and other virtual file systems | Later, as an adapter | `Concept` |
| The game's own server | Not exported; the game's account serves it | `Owner` |
| Process memory only | Not supported; no universal suspend and resume | `Owner` |

Rules (`Owner`): never read the files of a live browser profile; never export or sync a whole profile, cookies or
tokens; keep game data apart from asset cache; back up before every import and restore the backup if anything fails;
version every snapshot (game id, exporter and adapter version, content and hash, parent revision, device, game version
when known); closing a window does not prove that a game flushed its storage; treat archives as hostile; an
unsupported value type is an explicit error. A game is called export-capable only after a restore was verified.

## 11. Platforms

| Platform | Role | Status |
| --- | --- | --- |
| macOS arm64 | First tested platform; the dev machine | Nothing is verified yet; the dev machine is macOS 27.0.1 on an Apple M3. Verified (2026-10-24, run locally: `sw_vers`, `sysctl -n machdep.cpu.brand_string`) |
| Windows | Target platform | CI-verified only: CI runs install and unit tests on `windows-latest`, which says nothing about game compatibility; no Windows machine is available. Verified (2026-10-24, [ci.yml](../../.github/workflows/ci.yml), [MEMORY.md](../../MEMORY.md)) |
| Linux | Next stage, after GPU, input and packaging checks on chosen distributions | Not started. `Concept` |
| iOS and Android | Future, a separate client | Out of scope for version 1 (`Owner`). iOS apps that browse the web must use WebKit, so a future iOS client is a separate WebKit-based client and desktop Chromium code cannot be reused. Verified (2026-10-24, <https://developer.apple.com/app-store/review/guidelines/>, guideline 2.5.6). Android's system WebView is Chromium-based. Assumed |

- Electron 45 builds only for x64 and arm64. Verified (2026-10-24, <https://releases.electronjs.org/release/v45.0.0>).
- The runtime is provisional: Electron 45 is the planned choice and Tauri 2 the alternative, decided by ADR-0002 after the
  runtime spike. Assumed
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
live (`apps/desktop`, `packages/snapshot`, `packages/exporters`, `fixtures/test-games/progress-lab`); none exists yet.
Stage "Later" means it depends on work after the MVP.

| Id | Criterion (testable) | Test type | Stage |
| --- | --- | --- | --- |
| AC-1 | After a full restart, an added game is still in the library with the same title, URL, cover and `gameId`, and Play opens it from the library and from its shortcut | e2e | MVP |
| AC-2 | Two entries (including two entries with the same URL) get different `gameId` and partitions; localStorage, IndexedDB and cookie markers written by one are absent in the other; the launcher UI shares no session with any game | integration, e2e | MVP |
| AC-3 | In a game window there is no `require`, `process` or launcher bridge, and game content cannot reach launcher IPC; the window factory is unit-tested for `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload and `webSecurity` on | unit, e2e | MVP |
| AC-4 | In a game session camera, microphone, geolocation, notifications and display capture are denied and logged, while fullscreen, pointer lock and keyboard lock are allowed | unit (handler), e2e | MVP |
| AC-5 | Navigation off the game's site, `window.open` and downloads are blocked or routed by the rules; `shell.openExternal` accepts only a validated http or https URL after confirmation; the URL decision is unit-tested with `javascript:`, `file:`, a custom-scheme URL, userinfo tricks and lookalike hostnames | unit, e2e | MVP |
| AC-6 | The vertical scenario (section 5) runs automatically on `progress-lab` and ends with an equal `#progress-hash` after the restore | e2e | MVP |
| AC-7 | Export then restore into a clean session reproduces the progress of at least one controlled game (equal `#progress-hash`), with Date, ArrayBuffer, Uint8Array and Blob values preserved, also for the service-worker and cross-site iframe variants | integration, e2e | MVP |
| AC-8 | With a fault injected at each restore step (validate, lock, backup, wipe, import, verify), the state afterwards equals the pre-import state, and the backup exists and verifies | integration | MVP |
| AC-9 | Snapshot validation rejects each of: truncated or malformed input, an absolute path, `..`, a symlink, a hardlink, a device entry, too many entries, oversize content, a bad compression ratio, a bad entry hash, a bad content hash and an unknown format version, each with a distinct error, and nothing is written before validation passes | unit (golden vectors) | MVP |
| AC-10 | A value type the exporter cannot represent fails the export with a named error (key path and type) and is never dropped silently | unit | MVP |
| AC-11 | Export and restore are refused while that game's window is open | integration | MVP |
| AC-12 | For games that flush through a known hook (Emscripten IDBFS), export is allowed only after the flush is confirmed | integration | Later (needs an Emscripten fixture) |
| AC-13 | After a game window is closed, within 5 s no window of that game and no process belonging to it remain (process list before and after); the same holds after quitting the app | e2e, manual | MVP |
| AC-14 | For each badge, entries in each recorded state show it if and only if its condition in section 7 holds; no UI element indicates install, sync, FPS or download progress without backing state | unit, manual review | MVP |
| AC-15 | With a fake clock and window events, playtime accrues only while the window is visible and focused, stops on blur, minimize, suspend and lock, and drops sessions under 10 s | unit | MVP |
| AC-16 | The three delete actions behave as in section 9: remove keeps snapshots; clear cache leaves game data; delete local saves creates and verifies a backup before wiping | integration | MVP |
| AC-17 | Editing title or cover persists and changes neither `gameId` nor partition; adding a URL that is not HTTPS is rejected (development exception: OQ-3) | unit, e2e | MVP |
| AC-18 | Window size, position and fullscreen state are restored on the next launch; fullscreen toggles from the UI and the keyboard and exits on Esc | e2e, manual (real input on macOS) | MVP |
| AC-19 | The deep link or launch argument for a game id focuses or opens its single window, starts the client first if it is not running, and an unknown or malformed id is rejected without navigating anywhere; no per-game bundle exists | integration, manual (packaged macOS build) | MVP |
| AC-20 | Logs contain no tokens, cookies or save contents; a snapshot contains no cookies, HTTP cache, Cache Storage, service workers or shader cache | unit, integration | MVP |
| AC-21 | Every "verified" statement in the README, docs or UI points to a record in `docs/compat/` (date, version, machine); Windows and Linux entries are absent or "not tested" | manual review | MVP |
| AC-22 | Every published start-up, frame-time or memory number has a measurement record (cold and warm separate, same-machine Chrome comparison, scene id) | manual review | MVP |
| AC-23 | With a fake backend, two devices changing the same base revision produce two kept branches and a user choice; the device clock never decides; a local backup precedes every import; a quota failure keeps the local data | integration | Later (cloud) |

## 17. Risks and unverified assumptions

| Risk | State | Resolved by |
| --- | --- | --- |
| Electron fails isolation, persistence, cross-origin isolation, WebGPU or frame-time criteria | Unverified (2026-10-24, no spike has run) | `spikes/runtime-compat/HYPOTHESES.md`, H1 to H7 |
| The quiescent-window export and restore mechanism does not work for service-worker or cross-site iframe games | Unverified (2026-10-24, no spike has run) | H14 |
| Real game saves (Emscripten flush timing, Unity paths, OPFS) behave differently from the controlled game | Unverified (2026-10-24, not tested) | Later fixtures and real runs |
| Windows and Linux behave differently from macOS | Unverified (2026-10-24, no machine) | CI for install and unit tests; real runs later |
| The value hypothesis is wrong | Unverified (2026-10-24, not tested with any user) | Repeat-use observation after the MVP |
| `CLA.md`, `LICENSING.md` and `TRADEMARKS.md` have legal gaps | Unverified (2026-10-24, no lawyer review yet) | Lawyer review before outside contributions |

## 18. Open questions

- OQ-1: the product's display name (the codename is `wg-launcher`).
- OQ-2: what "remove from library" does to the game's live session storage. Proposal: keep it, listed as orphaned data
  until the user deletes it, so an accidental removal cannot destroy progress. To be fixed in the architecture spec.
- OQ-3: the vertical scenario and tests use `http://localhost`, but entries must be HTTPS. Proposal: allow plain
  `http://localhost` and `http://127.0.0.1` only in development and test builds.
- OQ-4: how repeat use is measured, and whether any telemetry exists at all (no decision yet).
- OQ-5: whether search and favorites (F-12) and automatic title and cover proposals (F-14) enter the first MVP.
- OQ-6: whether cloud storage is a paid feature; the concept hypothesizes paid extra volume, and the core-free list in
  `LICENSING.md` does not mention cloud.

## 19. Related documents

- [concept-v1.0.ru.md](sources/concept-v1.0.ru.md): the original concept (Russian).
- [foundations.md](../research/foundations.md) and [runtime-and-storage.md](../research/runtime-and-storage.md): evidence.
- [HYPOTHESES.md](../../spikes/runtime-compat/HYPOTHESES.md): the runtime experiment, written before it runs.
- [AGENTS.md](../../AGENTS.md): security, data-safety and honesty rules that these requirements rest on.
- Planned, not written yet: `docs/specs/` (architecture, snapshot format, save transfer, security) and `docs/adr/`.
