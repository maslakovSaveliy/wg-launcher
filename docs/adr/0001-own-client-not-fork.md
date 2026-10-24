# ADR-0001: Own small client, not a fork

**Status:** Accepted

**Date:** 2026-10-24

**Deciders:** owner (maslakovSaveliy); drafted by AI agent

Conventions: [ADR-0000](0000-template.md#conventions).

## Context

- wg-launcher opens arbitrary HTTPS web games, each in its own window with its own persistent session, and exports and
  restores their saves. `Owner` ([PRD](../product/prd.md) sections 1 and 5)
- Game windows must run with `sandbox: true`, context isolation, no preload, no IPC and `webSecurity` on, one persistent
  session per game, and shipped dependencies must be permissive. `Owner` ([AGENTS.md](../../AGENTS.md#hard-rules))
- Four open-source launchers were checked as possible bases, by reading repositories, licenses and code through the
  GitHub API; none was built or run. Verified (2026-10-24, [foundations.md](../research/foundations.md) "Reading this
  document").

## Decision

- Write a small own client. Fork none of itchio/itch, FlashpointProject/launcher, arhitekt86/pixens-launcher or
  lutris/web-runner. `Owner` (Phase 0 plan approved by the owner; [MEMORY.md](../../MEMORY.md) Decisions)
- Copy no code from any of them; other projects are a source of ideas only. Ideas taken: one persistent partition per
  game (itch's `persist:gamesession_${game.id}`, Ferdium's `persist:service-${id}`), which becomes
  `persist:game:<gameId>` with a URL-independent UUIDv7; and a custom protocol handled per session (itch's
  `itch-cave://` through `session.protocol.handle`), which becomes the launcher's `app://` scheme and the quiescent stub
  of ADR-0005. `Owner` for "ideas only" (AGENTS.md dependency policy), `Assumed` for the list.
- The decision does not depend on the runtime: the runtime is ADR-0002's. All four bases happen to use Electron.
  Verified (2026-10-24, foundations.md section 2.1).

## Options considered

### Option A: fork itch

| Dimension | Assessment |
| --- | --- |
| Complexity | High: about 690 files and 1.6 MB of TS and JS in `src`, Redux, plus butler (Go) and the itch.io API. Verified (2026-10-24, foundations.md sections 2.1 and 2.3) |
| Cost and size | Removing catalog, install, update and Redux logic is judged to cost more than writing the small core. Assumed (no trial build) |
| Compatibility | Per-game session and per-session protocol fit, but it does not load remote HTTPS URLs as games. Verified (2026-10-24, foundations.md section 2.2) |
| Security | Game window has `sandbox:false` and `webSecurity:false`, against our invariants. Verified (2026-10-24, foundations.md section 2.2) |
| Team familiarity | None with its codebase. Assumed |
| Reversibility | Low once the fork diverges. Assumed |
| Pros | MIT, very active, Electron ^44.5.1 inside the support window. Verified (2026-10-24, foundations.md section 2.1) |
| Cons | Size, security posture, external services. Verified (2026-10-24, foundations.md section 2.4) |

### Option B: fork the Flashpoint launcher

| Dimension | Assessment |
| --- | --- |
| Complexity | High: about 430 files and 1.8 MB plus an extension system; mostly launches external programs from a Node backend. Verified (2026-10-24, foundations.md sections 2.1 and 2.2) |
| Cost and size | Needs a Flashpoint data folder, 7zip and a Rust library binding. Verified (2026-10-24, foundations.md section 2.3) |
| Compatibility | Electron 19.1.9, far outside the supported window; one default session, no per-game partitions. Verified (2026-10-24, foundations.md sections 2.1 and 2.2) |
| Security | Shared default session; `plugins:true` for Flash. Verified (2026-10-24, foundations.md section 2.2) |
| Team familiarity | None. Assumed |
| Reversibility | Low. Assumed |
| Pros | MIT own code; the package and extension idea may help the later local-packages stage. Verified for the license (2026-10-24, foundations.md section 2.1); the idea is Assumed |
| Cons | Bundles LGPL 7zip, which the dependency policy forbids in the product. Verified (2026-10-24, foundations.md section 2.1, [AGENTS.md](../../AGENTS.md#dependency-and-license-policy)) |

### Option C: fork pixens-launcher

| Dimension | Assessment |
| --- | --- |
| Complexity | Low size (about 60 files, 200 KB, mostly one JSX file) but hard-wired to pixens.io and Supabase. Verified (2026-10-24, foundations.md sections 2.1 and 2.3) |
| Cost and size | Rewriting the wiring is most of the work. Assumed |
| Compatibility | Electron ^33.2.0, outside the support window; `webviewTag` on. Verified (2026-10-24, foundations.md sections 2.1 and 2.2) |
| Security | One session shared by launcher and games. Verified (2026-10-24, foundations.md section 2.2) |
| Team familiarity | None. Assumed |
| Reversibility | Medium (small code). Assumed |
| Pros | MIT, small, electron-vite stack. Verified (2026-10-24, foundations.md section 2.1) |
| Cons | 2 commits in total, 0 stars; nothing reusable. Verified for the activity (2026-10-24, foundations.md section 2.1); "nothing reusable" is Assumed |

### Option D: fork lutris/web-runner

| Dimension | Assessment |
| --- | --- |
| Complexity | Low: about 10 KB of JS in 3 files. Verified (2026-10-24, foundations.md section 2.1) |
| Cost and size | Effectively a rewrite. Assumed |
| Compatibility | Electron 4.2.12 and the removed `new-window` API. Verified (2026-10-24, foundations.md sections 2.1 and 2.2) |
| Security | One default session; CLI flags inject JS and CSS. Verified (2026-10-24, foundations.md section 2.2) |
| Team familiarity | None. Assumed |
| Reversibility | Not applicable: no code may be copied. Assumed |
| Pros | Shows that a launcher can be tiny. Assumed |
| Cons | GPL-3.0: copying its code is forbidden by our policy and would block dual licensing (ADR-0006). Verified for the license (2026-10-24, foundations.md section 2.1) |

### Option E: own small client (chosen)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: only the core the PRD needs (library, game windows, sessions, snapshots). Assumed |
| Cost and size | Written from scratch in Phase 1; specs exist ([architecture.md](../specs/architecture.md)). Verified (2026-10-25, the file exists) |
| Compatibility | Built for arbitrary HTTPS entries and per-game partitions from the start. Assumed |
| Security | Our invariants are designed in, not retrofitted ([security.md](../specs/security.md)). Assumed |
| Team familiarity | The owner's own design and docs. Assumed |
| Reversibility | High: nothing upstream to track. Assumed |
| Pros | Small, secure by design, no license constraints from upstream code. Assumed |
| Cons | Every feature is ours to write and maintain; no community from day one. Assumed |

## Trade-off analysis

The bases that are small (Pixens, web-runner) are outdated or tied to one site, and the one that is current and closest
in pattern (itch) carries a large catalog-driven codebase whose game window contradicts our security rules. Three of the
four run Electron versions outside the support window. Verified (2026-10-24, foundations.md section 4). The cost of an
own core is judged lower than the cost of stripping and re-securing a fork. Assumed

## Consequences

- **Easier:** security review of a small codebase; dual licensing, since all code is the owner's or CLA-covered
  (ADR-0006); following the Electron support window without inherited upgrade debt. Assumed
- **Harder:** no inherited features such as download, patching or update infrastructure. Assumed

### Revisit triggers

- The local-packages stage needs patching and downloads at scale: then study itch's butler and wharf (Go, MIT) as
  ideas or a separate tool (ADR-0003). Assumed
- Phase 1 turns out to need most of itch's library infrastructure. Assumed

## Evidence

- [foundations.md](../research/foundations.md): comparison with checked commits, licenses, session handling,
  dependencies and the reuse verdict per base (sections 2 to 4).
- [AGENTS.md](../../AGENTS.md#hard-rules): the security and dependency rules the bases were judged against.

## Facts versus assumptions

- **Facts** (tagged where they appear above): licenses, commits, Electron versions, session handling and itch's disabled
  sandbox and web security, all read through the GitHub API on 2026-10-24 (foundations.md). No base was built or run.
- **Assumptions** (Assumed): that stripping a fork costs more than writing the core; that a small own codebase is easier
  to keep secure and current; that no base has save export (foundations.md section 3 marks this Unverified).

## Action items

- [ ] Phase 1 builds the client from [architecture.md](../specs/architecture.md); no file of any base is copied
  (agent; checked in code review).
