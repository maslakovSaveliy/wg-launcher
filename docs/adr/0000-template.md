# ADR-0000: Template and conventions for architecture decision records

**Status:** Accepted

**Date:** 2026-10-24

**Deciders:** owner (maslakovSaveliy); drafted by AI agent

Copy this file to `NNNN-short-title.md` (next free number, lowercase, hyphens) and replace every bracketed part. Keep an
ADR at about 150 lines; long reasoning belongs in `docs/research/` and exact values in `docs/specs/`.

## Conventions

- **Status** is `Proposed` (not decided yet; the ADR says exactly what evidence decides it), `Accepted` (decided; the
  evidence below is enough for it) or `Superseded by ADR-NNNN` (kept, never deleted). An accepted ADR changes only
  through a new ADR, except for dated corrections of fact.
- **Claim tags** follow [AGENTS.md](../../AGENTS.md#documentation-rules): every factual statement ends with `Verified
  (YYYY-MM-DD, source)` (a URL, command, commit or repository file), `Assumed` (reasoned, not checked) or `Unverified`
  (reported, not checked). A tag at the end of a bullet or table row covers that whole bullet or row, unless a second
  tag inside it says otherwise.
- **Decision markers** are those of the [PRD](../product/prd.md#how-to-read-this-document): `Owner` marks a decision the
  owner made (with its source); every other decision is a call made in the ADR, marked `Assumed`, and the owner can
  override it. A decision is not a fact, so it never carries `Verified`.
- An ADR never claims more than its evidence shows: INVALID, INCONCLUSIVE, N/A and not-run results are reported as such
  and never counted as a pass. An untested OS is never "verified".
- Undecided items appear only in "Open questions", each as one concrete question with a default.
- English, relative links, no machine paths or personal data (the repository is public).

## Context

[The situation and the forces at play: requirements, constraints, what is known. Tag every fact.]

## Decision

[What is decided, stated so that another agent can act on it. Mark each item `Owner` or `Assumed`.]

## Options considered

### Option A: [name]

| Dimension | Assessment |
| --- | --- |
| Complexity | [Low, Medium or High, and why; tag] |
| Cost and size | [Effort, binary or dependency weight; tag] |
| Compatibility | [With the platforms, games and the rest of the design; tag] |
| Security | [Effect on the invariants in AGENTS.md; tag] |
| Team familiarity | [Tag] |
| Reversibility | [How hard it is to undo later; tag] |
| Pros | [Tag] |
| Cons | [Tag] |

### Option B: [name]

[Same table.]

## Trade-off analysis

[The trade-offs that decided it, with reasons.]

## Consequences

- **Easier:** [What becomes easier.]
- **Harder:** [What becomes harder or is given up.]

### Revisit triggers

- [Observable events that reopen this decision.]

## Evidence

- [Links to repository files (research, spike results by file name, specs), each with what it shows.]

## Facts versus assumptions

- **Facts** (tagged where they appear above): [Verified or Unverified statements the decision rests on.]
- **Assumptions** (Assumed): [Assumed statements the decision rests on; each one is a risk.]

## Action items

- [ ] [Step, owner of the step (agent or owner), and where it is recorded when done.]

## Open questions

- [Optional. One concrete question per item, with the default that applies until it is answered.]
