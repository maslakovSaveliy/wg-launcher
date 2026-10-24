# Contributing to wg-launcher

This guide is the short version of [AGENTS.md](AGENTS.md), which is the source of truth for every rule here. The same
rules apply to humans and AI agents.

## Before you start

- **Pull requests from outside contributors are not accepted yet.** The contributor agreement ([CLA.md](CLA.md)) is a
  draft that a lawyer has not reviewed, and the CLA Assistant app that collects signatures is not set up. Both are owner
  actions. Until they are done, please open an issue instead of a pull request.
- Issues are welcome: use the bug form or the compatibility report form. A compatibility report records one real run, and
  anything you did not try is "Not tested".
- Security problems are never reported in public issues or pull requests. Use the private channel described in
  [SECURITY.md](SECURITY.md).
- Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Phase 0 contains no launcher client code and none may be added. Phase 1 gets its own plan.

## Setup

Prerequisites: Git, Node 24 (`.nvmrc`; `nvm use`) and pnpm. The `packageManager` field pins the pnpm version and pnpm
switches to it by itself inside the repository.

```sh
nvm use
pnpm install      # also installs the git hooks
pnpm check        # must be green before you push
```

The command table is in the [README](README.md#quick-start-for-contributors). Always run tools through `pnpm` or
`pnpm exec`, never a globally installed copy. `pnpm test:e2e` (the `progress-lab` Playwright suite) needs
`pnpm --filter @wg-launcher/fixture-progress-lab exec playwright install chromium` once, and is not part of
`pnpm check`.

## Workflow

1. Non-trivial work starts with a short design and a written plan in `docs/plans/` (`YYYY-MM-DD-<topic>.md`).
2. Work on a branch and open a pull request. Never commit directly to `main` and never force-push. Merging to `main`
   needs the owner's approval.
3. Where code exists, write the failing test first, watch it fail for the right reason, write the minimal code, watch it
   pass. Prefer a few meaningful tests of security and data-safety boundaries (a malformed snapshot, an import refused
   without losing the original, illegal archive paths, game isolation) over tests that restate the implementation.
4. When something fails, find the root cause: reproduce it, test one hypothesis at a time. No guess-and-retry loops.
5. Verify before you claim. Run the command, read the real output, and paste it into the pull request.
6. Spikes are throwaway experiments. They live in `spikes/`, are labeled THROWAWAY, keep their own lockfiles and stay
   outside the pnpm workspace. Phase 1 starts no new spikes.

### Commits

Small, logical commits in the [Conventional Commits](https://www.conventionalcommits.org/) form `type(scope): subject`.
Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore` and `spike` (the project's
addition for throwaway experiments). A commit made with AI help ends with a blank line and a `Co-Authored-By:` trailer
naming the model.

The git hooks (lefthook) run for you:

- pre-commit formats staged files with Biome (and re-stages them), scans them with secretlint and lints staged Markdown;
- commit-msg enforces Conventional Commits;
- pre-push runs `pnpm typecheck` and `pnpm test`.

CI repeats the checks on every pull request (lint, typecheck, license gate, Markdown lint, unit tests on macOS and
Windows, and the fixture's Playwright suite on Ubuntu and macOS), so skipping a hook only delays the failure.

## Definition of Done

A change is done only when all of these hold:

- Verification was run and its real output is recorded (tests, `pnpm check`, manual steps for UI).
- Behavior changes have tests that were written first.
- Docs are updated, claims are tagged, and [MEMORY.md](MEMORY.md) reflects new verified facts, decisions and gotchas.
- No secrets, personal data or machine paths are in the diff. The repository is public.
- The security and data-safety invariants in [AGENTS.md](AGENTS.md#hard-rules) are respected: game content is untrusted,
  and a failure must never destroy existing saves.
- No fake or empty artifacts were added: no placeholder packages, no rules for folders that do not exist, no UI that does
  not reflect real state.
- Dependencies follow the policy below, and commit messages are conventional.

The [pull request template](.github/pull_request_template.md) repeats this list.

## Dependencies and licenses

- Dependencies shipped in the product must be permissive: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD,
  BlueOak-1.0.0, or MPL-2.0 (file-level, unmodified). No GPL, AGPL or LGPL code among the resolved dependencies. Dev-only
  dependencies are reported, not blocking. `pnpm licenses:check` enforces it.
- Before adding a dependency, check its license, maintenance, size and whether it is needed at all. Check the current
  version and API in the official documentation. Install exact versions (`saveExact` is on). Dependency build scripts
  run only if the package is listed under `allowBuilds` in `pnpm-workspace.yaml`, so allow one deliberately.
- GPL games are used only as external test URLs and are never vendored. Never copy code from GPL projects; other open
  projects are a source of ideas only.
- The Electron and Chromium runtime brings its own bundled components; they are handled when the app is packaged, not by
  the gate above.

## Documentation

- Everything is in English: docs, rules, code, comments, commits and issues.
- Tag every factual claim: `Verified (YYYY-MM-DD, source)` with a URL, command or commit as the source, `Assumed`
  (reasoned, not checked) or `Unverified` (reported, not checked). In `MEMORY.md` the short forms `[V]`, `[A]` and `[U]`
  are allowed. Keep facts and assumptions visibly separate. An untested operating system is never called verified.
- No `TODO` or `TBD` outside a section named "Open questions". There, write one concrete question with a default.
- Use relative links between documents, cite external sources as full URLs with the date you read them, and keep the
  Markdown lint-clean (`pnpm docs:lint`).
- **Architecture decisions** are recorded as ADRs in `docs/adr/`. Copy [the template](docs/adr/0000-template.md) to the
  next free `NNNN-short-title.md` and fill every section: status (`Proposed`, `Accepted` or `Superseded by ADR-NNNN`),
  context, options with evidence tags, decision, consequences, revisit triggers, and facts versus assumptions. An
  accepted ADR changes only through a new ADR, except for dated corrections of fact. Mark each decision `Owner` (the
  owner made it) or `Assumed` (a call made in the document that the owner can override).
- Specifications in `docs/specs/` state exact values and limits, so another agent can implement them without guessing.
- The documentation index is [docs/README.md](docs/README.md).

## Licensing of contributions

The repository is `AGPL-3.0-or-later` ([LICENSING.md](LICENSING.md)). Contributors keep the copyright in their work, and
the CLA grants the project the right to license contributions under the AGPL and under other licenses, including
commercial ones. Once outside contributions open, the CLA Assistant bot will ask you to sign on your first pull request.
