# Documentation index

Everything under `docs/`, plus the documents elsewhere in the repository that a reader needs. Every factual claim in
these documents carries a tag: `Verified (date, source)`, `Assumed` or `Unverified`
([rules](../AGENTS.md#documentation-rules)).

## Where to start

- To understand the product: [PRD](product/prd.md), then [architecture](specs/architecture.md).
- To implement Phase 1: the four specifications below, the ADRs they cite, and
  [MEMORY.md](../MEMORY.md) for gotchas.
- To check what is actually verified: [compatibility matrix](compat/matrix.md) and the spike's
  [RESULTS.md](../spikes/runtime-compat/RESULTS.md).

## Product (`docs/product/`)

| Document | Content |
| --- | --- |
| [prd.md](product/prd.md) | Product requirements for the MVP: features, honest badges, delete semantics, saves, platforms, acceptance criteria AC-1 to AC-25, risks, open questions |
| [sources/concept-v1.0.md](product/sources/concept-v1.0.md) | The owner's concept document (English translation of the Russian original, which it replaced on 2026-10-25) |

## Specifications (`docs/specs/`)

Normative for Phase 1. Status of each: draft, 2026-10-25.

| Document | Content |
| --- | --- |
| [architecture.md](specs/architecture.md) | Process model, module map, on-disk layout, game session lifecycle, IPC contract, SQLite schema, shortcuts and deep links, fullscreen, playtime, badges, delete semantics, testing notes |
| [snapshot-format.md](specs/snapshot-format.md) | The `.wgsnap` container, manifest, entries, record encoding (deterministic CBOR), limits, error codes and golden vectors |
| [save-transfer.md](specs/save-transfer.md) | Export, restore and verify: the quiescent window, restore steps R1 to R8, flush state, adapters |
| [security.md](specs/security.md) | Assets, threats, game windows, permissions, navigation, archive safety and resource limits |

## Architecture decision records (`docs/adr/`)

| ADR | Decision | Status |
| --- | --- | --- |
| [0000](adr/0000-template.md) | Template and conventions | Accepted |
| [0001](adr/0001-own-client-not-fork.md) | Own small client, not a fork | Accepted |
| [0002](adr/0002-desktop-runtime.md) | Desktop runtime: Electron 45.0.0 | Accepted (2026-10-25), on the condition that Phase 1 re-runs the H7 frame-time check against Chrome |
| [0003](adr/0003-native-languages.md) | Native languages: Rust deferred, Go not adopted | Accepted |
| [0004](adr/0004-toolchain-and-repo-layout.md) | Toolchain and repository layout | Accepted; the Electron-specific rows follow ADR-0002 |
| [0005](adr/0005-save-transfer-mechanism.md) | Save transfer mechanism: the quiescent window | Accepted together with ADR-0002, under the same condition |
| [0006](adr/0006-licensing-model.md) | Licensing model: AGPL-3.0-or-later with a CLA | Accepted; awaits a lawyer's review |

## Research (`docs/research/`)

| Document | Content |
| --- | --- |
| [foundations.md](research/foundations.md) | Open-source bases checked, why an own client, test-game candidates, licensing precedent |
| [runtime-and-storage.md](research/runtime-and-storage.md) | Electron, Tauri, iOS and Android, save extraction, Go and Rust, tooling versions; collected on 2026-10-24, before the spike ran |

## Compatibility records (`docs/compat/`)

Real runs only. A platform without a row is not tested.

| Document | Content |
| --- | --- |
| [matrix.md](compat/matrix.md) | Generated from the spike's result files; do not edit by hand |
| [methodology.md](compat/methodology.md) | How the runs are made and what the numbers do not mean |

## Plans (`docs/plans/`)

| Document | Content |
| --- | --- |
| [2026-10-24-phase-0-foundation.md](plans/2026-10-24-phase-0-foundation.md) | The Phase 0 plan. Phase 1 gets its own plan |

## Runtime spike and test game

| Document | Content |
| --- | --- |
| [spikes/runtime-compat/README.md](../spikes/runtime-compat/README.md) | The throwaway runtime experiment: layout, how to run it |
| [HYPOTHESES.md](../spikes/runtime-compat/HYPOTHESES.md) | Hypotheses H1 to H21, thresholds and decision rules, frozen before any run |
| [RESULTS.md](../spikes/runtime-compat/RESULTS.md) | Outcome of each hypothesis, with evidence files and deviations |
| [fixtures/test-games/progress-lab/README.md](../fixtures/test-games/progress-lab/README.md) | The controlled test game: how to run it and its interface contract |

## Repository-level documents

| Document | Content |
| --- | --- |
| [README.md](../README.md) | Overview, status, commands, platforms, limitations |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, workflow, Definition of Done, dependency policy, documentation rules |
| [AGENTS.md](../AGENTS.md), [MEMORY.md](../MEMORY.md) | The rules, and the verified facts, decisions and gotchas |
| [LICENSING.md](../LICENSING.md), [CLA.md](../CLA.md), [TRADEMARKS.md](../TRADEMARKS.md) | Licensing model, contributor agreement (draft), trademark policy |
| [SECURITY.md](../SECURITY.md), [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Vulnerability reporting, community rules |
