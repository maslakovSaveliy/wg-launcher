# Concept of a desktop platform for browser games

Version 1.0 · 24 October 2026

> English translation of the owner's concept document, version 1.0 of 2026-10-24, written in Russian. The original was
> replaced by this translation on 2026-10-25 (owner decision). It is a source document: it records the owner's working
> description as it was written and is not a specification. Decisions that differ from it are in the
> [PRD](../prd.md), the [specifications](../../specs/) and the [ADRs](../../adr/).

Working description: an independent library of web games with launch by link, separate profiles and transfer of saves.
Product name: WGLauncher. This document describes the product and the recommended way to validate it; it is not a report
about an application that was built or tested.

## 1. Product idea

The user installs one desktop client, pastes a link to a game and adds it to a personal library. The game gets a card, a
separate window, persistent local storage and, optionally, a desktop shortcut. For supported games the client makes
backups and moves saves between computers.

Main scenario: "Found a game on the internet → added it to the library → launch it like a regular game → continue from
where I saved".

The product targets both ordinary JavaScript games and modern ports using WebAssembly, WebGL and WebGPU. For launching,
these are web applications of different complexity. Supporting one class of games does not guarantee compatibility with
all the others.

The client does not convert a web game into native executable code and does not run it on a cloud server. The game runs
on the user's computer in a browser engine. The cloud part is needed mainly for the library and backups.

## 2. Who it is for and what problem it solves

The first audience is people who try fan ports, independent web games and browser emulators and want to come back to
them without hunting for old links. The second is authors of web games who need a clear desktop way to distribute their
game without developing their own launcher.

The main problems: games are scattered across different sites; links get lost; the window mixes with work tabs; local
progress is hard to move; it is unclear what takes up space and what will be deleted when data is cleared.

Value hypothesis: users need a shared library with predictable storage of progress. The assumption "people do not want
to play in a browser" is not enough on its own: for many, a link and the absence of an install are an advantage.

The product's difference should show in repeat use: the user returns to the library, restores progress and launches the
game on another computer.

## 3. User experience

1. Install the client and use it right away without an account.
2. Paste an HTTPS link. The client proposes a title and a cover, which can be corrected by hand.
3. See a card with a "Play" button and the available capabilities.
4. Launch the game in a separate window. Window settings and local data are kept.
5. If needed, create a shortcut that leads to the shared client with the game's identifier.
6. Turn on backups for a compatible game. An account is required only when the cloud is connected.
7. On another computer, get the library and restore a compatible save before launch.

The interface must distinguish "added by link" from "installed for offline". Useful statuses: "Needs internet",
"Installed locally", "Cloud saves supported", "Local progress only", "Compatibility not verified".

A universal launcher knows the session time and the launch date. It does not automatically know the completion
percentage, achievements or events inside the game. That needs an integration with the game.

## 4. Three support modes

| Mode | Behavior | Limits of the promise |
| --- | --- | --- |
| Launch by link | Open the original site in a game window | The site and its servers must be reachable; some sites may not work in an embedded environment |
| Local web build | Get the full game package and run it locally | Needs a compatible build and known dependencies; server features may need a network |
| Integrated game | Use a manifest, an adapter or the author's SDK | Saves, versions, offline and extra features can be supported more reliably |

We do not promise to download any whole site automatically. Resources can load dynamically and depend on authorization,
external APIs, server logic and the specific domain. An ordinary browser cache is not a full installation.

Loading the original game's local files, if a particular port requires it, stays part of that port's scenario. Adding a
URL by itself does not replace such files.

## 5. MVP and later versions

### First version: library and launch

- Windows and macOS as the target desktop platforms; first a check on the available machine, then a build and a check on
  the second OS.
- Adding a URL, editing the card by hand, search and favorites.
- A separate window and a persistent session for each game entry.
- Fullscreen mode, remembering the window size, launching from a shortcut.
- Playtime by an explicitly defined rule, for example only while the game window is active.
- Clear actions "remove from library", "clear cache" and "delete saves" with different consequences.
- Diagnostics of load errors and of the graphics engine's capabilities.
- A save exporter interface and working export and import for at least one verified game or test build.

### Next version: cloud progress

An account, library sync, backup versions, restore on another computer, safe conflict resolution. A limited list of games
with confirmed save compatibility.

### Then: installation and integrations

Local packages, resumable downloads, integrity checks, versions and rollback. A manifest format for authors and
declarative adapters. Linux comes after checking the GPU, input and packaging on chosen distributions.

A store, a social network, chat, achievements, mods, an overlay and a mobile client are not part of the MVP. Adding them
must rest on real use of the base product.

## 6. Recommended architecture

The initial direction is Electron + React/TypeScript + a separate core in Rust. This is a recommendation to be checked,
not a finally approved choice.

| Layer | Responsibility |
| --- | --- |
| React + TypeScript + Vite | Library, settings, task states, conflict dialogs |
| Electron main process | Windows, Chromium sessions, permissions, narrow IPC, system shortcuts |
| Isolated game window | Running third-party web code and the browser storages |
| Rust process | Work with packages and files, hashing, compression, backups, the sync queue |
| SQLite | Catalog, settings, task states and local version information |
| Optional backend | Accounts, metadata sync and access to save objects |

Each game uses its own persistent browser session, for example `persist:game:<id>`. The client's interface runs
separately from third-party content. One Chromium distribution serves the whole client; no separate Electron bundle is
created per game. Chromium's process model stays multi-process.

Rust receives only the commands it needs. The first transport is JSON messages with request identifiers over the child
process's stdin and stdout; logs go to stderr. Timeouts, cancellation, progress messages, request size control and
recovery after a crash are needed. Large files are not encoded in JSON: verified internal identifiers or allowed paths
are passed instead.

The Rust code is a separate crate with minimal dependence on the shell. This makes it possible, if needed, to connect it
through napi-rs or use it in Tauri. We do not create an abstraction over all Electron APIs in advance: we separate only
the real boundaries between the core and the browser runtime.

In the MVP the local catalog has one write owner. The Rust core is preferred; the UI gets operations through IPC. If the
core is not introduced yet in the first stage, we do not complicate the migration with distributed writes to SQLite from
several layers.

## 7. Electron, Tauri and other paths

**Path A — Electron + Rust.** A controlled Chromium version, convenient management of persistent sessions, a familiar
TypeScript stack. The price is the size of the distribution, the memory of the browser engine and the need to maintain
native Rust builds for every OS and architecture.

**Path B — Tauri 2 + Rust.** A smaller own bundle thanks to the system WebView, and direct use of Rust. Windows uses
WebView2, macOS WKWebView, Linux WebKitGTK. For games this is an extra compatibility matrix. For a Windows-first product
this path especially deserves a check.

**Path C — Tauri with CEF.** The checked Tauri 3 alpha documentation describes a CEF runtime that ships Chromium. It
could combine a Rust core with a controlled engine, but the maturity of the alpha branch needs assessment. Shipping
Chromium shrinks the small-distribution advantage. Do not treat this path as a ready replacement without an experiment.

**Path D — own Rust shell + CEF.** More control, but far more work with windows, profiles, IPC, updates and packaging.
Not recommended for the first MVP.

The choice is made from the results of the same game scenarios, not by language or by the size of an empty application.
Changing the shell must not require rewriting the Rust file part.

## 8. Where Rust helps and where it does not help automatically

Good candidates: processing large files, streaming downloads and unpacking, integrity control, compressing copies,
comparing versions and background queues. A possible set of libraries: Tokio, reqwest, serde, SQLite through rusqlite or
sqlx, BLAKE3, zstd. Versions and the need for each dependency are checked during implementation. This is a possible set,
not a mandatory list.

Rust does not by itself speed up a game's own JavaScript or WASM and does not remove GPU limits. Rendering, shader
compilation and game computations stay in the respective engine. Node.js with correct asynchronous I/O can also do many
tasks quickly.

Practical measures: do not keep the windows of all games open; limit background tasks; do not unpack large packages at
the same time as a CPU-sensitive game; virtualize a large library; do not send data arrays through IPC without need.
Measure first, then optimize.

## 9. Saves: the main technical risk

| Where progress lives | How to support it |
| --- | --- |
| localStorage | Export the chosen keys and restore before launch |
| IndexedDB | Export the schema and the supported value types; transactions, Blob and binary data need checking |
| OPFS or a virtual file system | A separate export method; account for buffer flushing and the runtime's lifecycle |
| The game's server | Progress is served by the game's own account; the client does not promise its own export of it |
| Process memory only | Ordinary data export is not enough; a universal suspend and resume is not part of the concept |

There is no need to assume an individual adapter for every game: generic exporters can cover many cases. But claimed
support appears only after the restore is verified. In Emscripten, for example, MEMFS and IDBFS have different
persistence properties; data may need `FS.syncfs()`.

Sync protocol: before launch, check the cloud version → fetch and verify the object → restore a compatible copy →
launch the game → at a valid save point, export a new snapshot → publish the new revision atomically.

A snapshot holds the game_id, the export format version, the adapter version, the parent revision, the device
identifier, the content hash and, if known, the game version. The device time is used for display but is not the only
basis for choosing the current progress.

If two computers changed the same base revision, we keep both branches and offer a choice. Offline play is allowed; its
result syncs later. Do not apply a blind "last by the clock wins" overwrite. Before an import, a local backup. When a
quota is exceeded, we keep the local data and explain the error.

We do not automatically sync cookies, tokens, the resource cache or the whole Chromium profile. We do not copy the
running databases of a browser profile as ordinary files. We check the origin of data separately: a game inside an
iframe can store progress on another origin, and a change of domain, port or scheme can change the available storage.
The adapter accounts for this.

Import from Chrome or Safari, transfer between a browser and the client, and continuing on a phone are separate tasks.
The first version promises transfer between compatible desktop clients. Cloud saves do not make a game compatible with
an unsupported device.

## 10. Installing local packages

A package holds a web build and a declarative manifest. Minimal fields: a stable game_id, the version, the entrypoint,
the list of files or the package hash, the allowed external origins, runtime requirements and a description of the save
export.

Launch goes through a local server with a stable origin or a correctly registered protocol. MIME types, WASM, workers,
Range requests, CORS, COOP/COEP and the Service Worker where it is needed must be checked. We do not promise full
compatibility of our own protocol with all browser APIs without tests.

An update is installed into a new folder, verified and then switched atomically. User data is stored separately.
Rolling back the game's files and rolling back the save format are different operations: an old engine may not read a
new save.

## 11. Security as part of the architecture

A third-party game gets no Node.js, no file access and no shared administrative IPC. For Electron: sandbox,
contextIsolation, nodeIntegration turned off, checks of the IPC sender and parameters, controlled permissions and
navigation. We do not turn off webSecurity to make one site run.

The client and each game have different trust boundaries. A server cannot send the client an arbitrary OS command. The
adapters of the first stage are built in and verified; downloadable arbitrary JS or Rust extension code is not part of
the MVP. Archives are unpacked with protection against escaping the directory, symlinks and excessive size. Downloads
have limits and cancellation.

Permissions for the camera, microphone, files and devices are granted explicitly and bound to the game. Logs must not
contain tokens or save contents. Deleting a game must not silently destroy backups.

## 12. Cloud part and data model

Start local-first: the client works without registration or a network. The backend is connected after local export and
import are proven. A possible stack is the owner's familiar NestJS + PostgreSQL and S3-compatible object storage; no
specific provider is chosen yet.

Main entities: User, Device, Game, LibraryEntry, Installation, PlaySession, SaveSnapshot, SyncJob. A game has a stable
internal ID; the URL can change separately. Different links must not be merged into one game automatically without
confirmation.

The server stores metadata and authorization, and snapshot objects separately. Quotas, integrity control, restricted
access to objects and atomic publication of revisions are needed. Client-side end-to-end encryption is a possible extra
feature, not a claimed capability of the MVP.

## 13. Existing open-source bases and competition

The closest confirmed analog is the itch.io app: a library, installation and launch of HTML5 games from its own catalog.
There are also Xsolla Launcher for publishers and Flashpoint for archiving web content. An exact independent analog of
the whole combination "arbitrary URL + modern ports + cloud saves" was not confirmed in the earlier search. That does not
prove there are no competitors.

| Base | What to use | Limitation |
| --- | --- | --- |
| itchio/itch | Catalog architecture, launch and installation; a possible full fork | Depends on itch.io and a separate butler in Go; Rust does not replace them without extra work |
| FlashpointProject/launcher | Catalog, extensions, local packages | Archive-specific; the checked master used an old Electron, other branches need a separate check |
| arhitekt86/pixens-launcher | An example of a React/Electron client with web games | A small project, part of the system is outside the repository, readiness not checked |
| lutris/web-runner | A minimal example of launching a URL | Not a ready library and not a cloud save system |

Tentatively, a small own client fits the narrow link-based MVP better. A fork of itch makes sense if installation,
updates and a large library infrastructure are needed right away. The final decision comes after building a candidate
and estimating how much foreign logic would have to be removed. The licenses of the main code and of the dependencies
are checked at the chosen commit; available source code does not mean there are no terms of use.

Product promises must not be built on the unconfirmed completeness of individual fan ports. In particular, whether the
Cyberpunk project that was found works, and how complete it is, has not been established. The catalog must consist of
really checked links and of builds that may be distributed accordingly.

## 14. Experiments and readiness criteria

First pick several real games and controlled test builds: JavaScript with localStorage, WASM with IndexedDB, heavy WebGL
or WebGPU, an iframe, a game with an account or a network. One game per case is not required. Record the URL, the date,
the runtime version, the OS, the GPU and the result. An unreachable game is an unreachable check, not a successful
compatibility.

Check the launch, sound, pointer lock, fullscreen mode, controls and gamepad where they are supported. Compare the same
scenes with Chrome on the same machine. Measure cold and repeat launches separately, memory, CPU and frame smoothness; do
not carry the results of one machine over to all devices.

Criteria for the first demonstration:

- An added URL survives a restart and opens from the library and from a shortcut.
- Data of different games does not mix; a third-party site does not call privileged operations.
- For at least one controlled or real compatible game, export and import restore verifiable progress in a clean
  session.
- A failed export or restore does not destroy the original save.
- After a game is closed, none of its extra windows or processes remain.
- If the cloud is already connected, independent changes from two devices are kept as conflicting versions, not lost.

The first experiments must produce a decision on the runtime, the save format and the launch method. Implementation
timelines are estimated after them; there are no guarantees about days or FPS gains yet.

## 15. Possible business model

Hypothesis: a free client with a local library and backups; paid extra cloud volume, snapshot history and sync
conveniences. For authors, publishing and integration tools are possible. Prices and willingness to pay have not been
researched.

First we check whether a person comes back to play and uses the saves. Until that value is confirmed, we do not build a
store, a payment infrastructure or a large catalog. Account separately for the costs of storage, traffic and adapter
support: they can grow faster than the number of users.

## 16. Proposed first decision

Make a limited technical prototype with Electron + React/TypeScript, a separate game window and a persistent session;
check the Tauri alternative on the same games if the needed OS is available. Connect the Rust core to one specific
operation, for example packing and verifying a backup, and then extend it by real need. Do not add Rust as an empty
process for the sake of a stack claim.

The result of the first stage is a working launch by link, a proven local transfer of progress and a short
justification of the runtime choice. After that, design cloud sync and extend compatibility.

## Sources and degree of verification

The following pages were studied in the discussion of 23 October 2026. Current versions and the state of the projects
must be checked again before implementation. This is a documentation check, not a source audit and not the results of
local builds.

- Electron: <https://www.electronjs.org/docs/latest/api/session>
- Embedding web content: <https://www.electronjs.org/docs/latest/tutorial/web-embeds>
- Performance: <https://www.electronjs.org/docs/latest/tutorial/performance>
- Security: <https://www.electronjs.org/docs/latest/tutorial/security>
- Tauri 2, system WebViews: <https://v2.tauri.app/reference/webview-versions/>
- Tauri 3 alpha, runtime and CEF: <https://v3.tauri.app/develop/webview-runtime/>
- napi-rs: <https://github.com/napi-rs/napi-rs>
- Emscripten, MEMFS and IDBFS: <https://emscripten.org/docs/api_reference/Filesystem-API.html>
- itch: <https://github.com/itchio/itch>
- HTML5 in the itch app: <https://itch.io/docs/app/faq>
- butler: <https://github.com/itchio/butler>
- Flashpoint: <https://github.com/FlashpointProject/launcher>
- Pixens: <https://github.com/arhitekt86/pixens-launcher>
- Lutris web-runner: <https://github.com/lutris/web-runner>
- Xsolla: <https://developers.xsolla.com/distribute-game/launcher/features/>
