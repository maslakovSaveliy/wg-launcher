# ADR-0006: Licensing model

**Status:** Accepted. Not legal advice; [CLA.md](../../CLA.md), [LICENSING.md](../../LICENSING.md) and
[TRADEMARKS.md](../../TRADEMARKS.md) await a lawyer's review.

**Date:** 2026-10-24

**Deciders:** owner (maslakovSaveliy); drafted by AI agent

Conventions: [ADR-0000](0000-template.md#conventions). The option tables use the template's dimensions, read for a
license: "Security" becomes the protection the license gives against closed or hosted forks.

## Context

- The repository is public and fully open source; the owner wants to keep a commercial option (dual licensing) and
  possible paid extras later, while the core stays free. `Owner` (Phase 0 plan, "Owner decisions")
- `LICENSE` is the canonical AGPL-3.0 text; its section 13 covers remote network interaction and section 7(e) lets a
  licensor decline trademark rights. Verified (2026-10-25, `grep -n` on [LICENSE](../../LICENSE): lines 367 and 540)
- bitwarden/server uses AGPL-3.0 by default, keeps its source-available Bitwarden License only in the
  `bitwarden_license` directory and grants no trademark rights. Verified (2026-10-24,
  [foundations.md](../research/foundations.md) section 6, `gh api repos/bitwarden/server/contents/LICENSE.txt`)

## Decision

- **Default license** `AGPL-3.0-or-later` for the whole repository. `Owner`
- **Dual licensing:** any use on other terms only under a separate written agreement with the copyright holder; no
  standard commercial offer exists. `Owner` ([LICENSING.md](../../LICENSING.md))
- **CLA** for outside contributors, so the owner can relicense: an individual CLA adapted from the Harmony HA-CLA-I
  template (CC BY 3.0, Verified (2026-10-24, <https://www.harmonyagreements.org/>)). Counterparty: Savelii Maslakov
  (passport spelling), the project owner, as an individual; governing law: the Russian Federation. `Owner` (confirmed
  2026-10-25). The CLA stays inactive, and no outside code is accepted, until a lawyer has reviewed it and the signing
  app is set up. `Owner`. Both values are written into [CLA.md](../../CLA.md): the party in its preamble (line 21) and
  the governing law in section 6.1 (lines 135 and 136); the file is marked a draft that is not in effect. Verified
  (2026-10-25, CLA.md lines 3 to 6, 21 and 135 to 136)

  *Correction (2026-10-25):* the first draft of this ADR said the party and the law were still placeholders in CLA.md;
  they were filled in by the commit `docs: fill in the CLA party and governing law`.
- **Future paid features** live only in a dedicated directory under a source-available license whose text is stored
  there; everything else stays AGPL; no such directory exists. `Owner` (Phase 0 plan, "Owner decisions"). That the
  directory is top-level, that its name and license text are fixed later, and that the change is announced before the
  directory is created are not owner decisions: [LICENSING.md](../../LICENSING.md) says "one clearly named directory",
  "will be announced" and leaves the details to a future ADR, and LICENSING.md wins over this ADR. `Assumed`

  *Correction (2026-10-25):* the first draft tagged "one dedicated top-level directory" and "announced before it is
  created" as `Owner`; the owner decided only "a dedicated directory".
- **Core always free:** the game library, launching games, local saves and snapshots (export and restore), progress
  tracking. `Owner`
- **Trademark policy:** the AGPL grants no right to the name or logo; forks use their own name. `Owner`
  ([TRADEMARKS.md](../../TRADEMARKS.md))
- **Dependency policy:** shipped dependencies permissive only (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD,
  BlueOak-1.0.0, MPL-2.0 file-level and unmodified), because third-party copyleft code in the product would limit what
  the owner may relicense; dev-only dependencies are reported, not blocking; enforced by `pnpm licenses:check`. `Owner`
  for the policy ([AGENTS.md](../../AGENTS.md#dependency-and-license-policy)); the reason is Assumed (not legal advice).

## Options considered

### Option A: AGPL-3.0-or-later with a CLA (chosen)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: a CLA process and a dependency gate. Verified for the gate (2026-10-25, `pnpm licenses:check` reported all production dependencies allowed) |
| Cost | Lawyer review before outside contributions. Assumed |
| Compatibility | OSI-approved copyleft; permissive dependencies only. Assumed (OSI status general knowledge) |
| Security (fork protection) | Section 13 extends the source obligation to modified versions used over a network. Verified (2026-10-25, LICENSE line 540) |
| Team familiarity | Same model as bitwarden/server. Verified (2026-10-24, foundations.md section 6) |
| Reversibility | High while all code is the owner's or CLA-covered. Assumed |
| Pros | Open source, keeps dual licensing and a paid directory possible. Assumed |
| Cons | Some companies avoid AGPL code; a CLA deters some contributors. Assumed |

### Option B: GPL-3.0 with a CLA

| Dimension | Assessment |
| --- | --- |
| Complexity, cost | As Option A. Assumed |
| Security (fork protection) | No network clause: a hosted modified version need not publish its source. Assumed (general knowledge; LICENSE is AGPL, GPL text not read here) |
| Compatibility, familiarity, reversibility | As Option A. Assumed |
| Pros and cons | Slightly more acceptable to companies, weaker against hosted forks (the later cloud stage). Assumed |

### Option C: MPL-2.0

| Dimension | Assessment |
| --- | --- |
| Complexity, cost | Low; but a commercial license would offer little that MPL does not already allow. Assumed |
| Security (fork protection) | File-level copyleft only: a closed product can embed the files unchanged. Assumed (general knowledge) |
| Compatibility, familiarity, reversibility | Friendly to commercial reuse; easy to adopt; hard to tighten later. Assumed |
| Pros and cons | Most contributor-friendly, but little leverage for a commercial license. Assumed |

### Option D: FSL-1.1 (Functional Source License)

| Dimension | Assessment |
| --- | --- |
| Compatibility | Its authors present it as a "Fair Source" license that allows almost any use except undermining the producer, and each version converts to Apache-2.0 or MIT after two years; the site does not claim OSI approval. Verified (2026-10-25, <https://fsl.software/>) |
| Security (fork protection) | Strong for two years per version. Assumed |
| Complexity, cost, familiarity, reversibility | Simple text; unusual for contributors; conversion cannot be undone. Assumed |
| Pros and cons | Protects a business, but is not open source, against the owner's "fully open source" goal. `Owner` for the goal |

## Trade-off analysis

AGPL plus a CLA is the only option that is open source, protects against closed hosted forks and keeps the owner's
commercial options; its costs are the CLA process and companies' AGPL reluctance. Assumed

## Consequences

- **Easier:** commercial licensing on request; a paid directory later without relicensing the core. Assumed
- **Harder:** every outside contribution waits for the CLA; every shipped dependency needs a permissive license.
  `Owner` for the rules

### Revisit triggers

- The lawyer's review requires changes; a paid feature is planned (announce, then create the directory); a needed
  dependency is copyleft; the owner's jurisdiction or legal entity changes. Assumed

## Evidence

- [LICENSE](../../LICENSE), [LICENSING.md](../../LICENSING.md), [CLA.md](../../CLA.md),
  [TRADEMARKS.md](../../TRADEMARKS.md); [foundations.md](../research/foundations.md) section 6;
  [AGENTS.md](../../AGENTS.md#dependency-and-license-policy); `scripts/check-licenses.mjs`.

## Facts versus assumptions

- **Facts** (tagged where they appear above): the license text and its sections 7(e) and 13; the Bitwarden structure;
  the Harmony template license; the CLA party and governing law as written in CLA.md; the FSL authors' description.
- **Assumptions** (Assumed): that copyleft dependencies would block relicensing; how companies and contributors react;
  the GPL and MPL properties stated from general knowledge. None of this is legal advice.

## Action items

- [x] Write the owner-confirmed party (Savelii Maslakov, individual) and governing law (Russian Federation) into the
  `CLA.md` placeholders (agent; done 2026-10-25).
- [ ] Lawyer review of `CLA.md`, `LICENSING.md` and `TRADEMARKS.md`, then set up the CLA signing app (owner).
