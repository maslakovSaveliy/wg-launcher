# ADR-0004: Toolchain and repository layout

**Status:** Accepted. The Electron-specific rows (`electron`, `electron-vite`, `electron-builder`, Playwright
`_electron.launch`) follow ADR-0002 and are reopened with it.

**Date:** 2026-10-24

**Deciders:** owner (maslakovSaveliy); drafted by AI agent

Conventions: [ADR-0000](0000-template.md#conventions).

## Context

- Phase 0 set up the quality toolchain; Phase 1 adds the client. The process model and module map are in
  [architecture.md](../specs/architecture.md) sections 1 and 2. `Owner` (Phase 0 plan)
- The dependency policy allows only permissive shipped dependencies, exact versions and deliberate build scripts.
  `Owner` ([AGENTS.md](../../AGENTS.md#dependency-and-license-policy))

### What exists and works

| Tool | Version and role | Tag |
| --- | --- | --- |
| Node | 24 (`.nvmrc`); 24.13.0 on the dev machine | Verified (2026-10-24, [MEMORY.md](../../MEMORY.md) Dev machine) |
| pnpm | 12.15.0 pinned by `packageManager`; workspace `fixtures/test-games/*` | Verified (2026-10-24, MEMORY.md Decisions; `pnpm-workspace.yaml`) |
| TypeScript | 7.0.2; the gate passed with the whole toolchain, no fallback to 6.0.3 | Verified (2026-10-24, MEMORY.md Tooling versions) |
| Biome | 2.6.2 for JS, TS, JSON and CSS only; markdownlint-cli2 0.24.0 owns Markdown | Verified (2026-10-24, MEMORY.md Tooling versions) |
| Tests | Vitest 5.0.5 (`pnpm test`); Playwright 1.64.1 (`pnpm test:e2e`, fixture suite) | Verified (2026-10-24, MEMORY.md Tooling versions) |
| Hooks and checks | lefthook 2.2.2, commitlint 21.2.4, secretlint 13.0.7, `scripts/check-licenses.mjs` | Verified (2026-10-24, MEMORY.md Decisions) |
| CI | Ubuntu: lint, typecheck, licenses, docs; macOS and Windows: install and unit tests; Ubuntu and macOS: fixture e2e | Verified (2026-10-25, [ci.yml](../../.github/workflows/ci.yml); `gh run list` shows passing runs on this branch) |

## Decision

Phase 1 adds these, each package installed at an exact version and checked with `pnpm licenses:check`. The npm
packages are MIT except `@playwright/test` 1.64.1 (Apache-2.0); `node:sqlite` is built into Node, not a package.
Verified (2026-10-25, `npm view <package> version license`) for versions and licenses; the choices are `Assumed` unless
marked.

| Need | Choice | Reason |
| --- | --- | --- |
| Runtime | `electron` 45.0.0 (ADR-0002), a devDependency of `apps/desktop`; it has no install script, so it needs no `allowBuilds` entry (corrected 2026-10-28: the binary is downloaded on first `require("electron")` or by its `install-electron` command) | Verified (2026-10-28, `package.json` and `index.js` of `electron@45.0.0`; installed under pnpm 12.15.0) |
| Dev server and bundling | `electron-vite` 6.0.0 with `vite` 8.3.5; entries for main, the snapshot worker, two preloads and the renderer | Peer range `vite` ^6, ^7 or ^8. Verified (2026-10-24, [runtime-and-storage.md](../research/runtime-and-storage.md) section 2.3) |
| UI | `react` 19.3.1 | Planned stack. Assumed (approved with the Phase 0 plan) |
| Validation | `zod` 4.6.7 for IPC payloads, the snapshot manifest and adapters | architecture.md section 6 |
| Database | `node:sqlite` in the main process (no dependency) | Option S1 below |
| Packaging | `electron-builder` 26.18.0, fuses through its `electronFuses` setting | Option P1 below |
| End-to-end tests | `@playwright/test` 1.64.1, `_electron.launch`, with the partitioning switch re-appended | H11 PASS. Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H11) |

### Dependency declaration

`scripts/check-licenses.mjs` fails only on production dependencies and never on `devDependencies`. Verified
(2026-10-25, header of `scripts/check-licenses.mjs`). electron-vite bundles a renderer's `dependencies`, and its
documentation recommends installing renderer-only packages as `devDependencies` to keep the package smaller;
`dependencies` of the main process and preload scripts stay external and are packaged with the app. Verified
(2026-10-25, electron-vite documentation, "Dependency Handling", read through Context7,
<https://github.com/alex8088/electron-vite-docs/blob/master/packages/en-US/docs/guide/dependency-handling.md>).

*Correction (2026-10-25), added in the final review of Phase 0:* following that recommendation would put bundled
libraries outside the license gate. The rule is: everything bundled into or packaged with the app MUST be declared in
`dependencies` (prod); `devDependencies` hold build and test tooling only. The Phase 1 desktop package config must
follow this, with the electron-vite externalization and bundling settings checked accordingly (the price is a larger
package unless the packager leaves out the bundled copies). `Assumed` (the rule is in AGENTS.md). Enforcement: the
build-time guard `scripts/prod-deps-guard.mjs` fails a build that bundles a `node_modules` package outside the
production closure of the app (its `dependencies` and their transitive dependencies, read from `pnpm ls --prod
--depth Infinity --json`, the same set `pnpm licenses list --prod` checks); a transitive such as `scheduler` under
`react-dom` passes. Unit-tested with fake module ids and a path-free sample of the pnpm output, not yet run inside a
real build. Verified (2026-10-25, `pnpm test`; JSON shape from pnpm 12.15.0 in a scratch workspace).
*Update (2026-10-28, Phase 1 Task 5):* the guard now checks in a `transform` hook, which Rolldown calls for every
module and every plugin (a `load` hook is "first wins", so another plugin could have hidden a module from it), and it is
wired into the main, preload and renderer builds of `apps/desktop`. In a real build, a temporary
`import { expect } from "@playwright/test"` in the renderer failed `electron-vite build` with `Dependency rule:
"@playwright/test" is bundled into the app but is not a production dependency (it is declared only in devDependencies)`.
Verified (2026-10-28, electron-vite 6.0.0, Vite 8.3.5, run locally; the import was removed again).

### Repository layout

| Path | Content | When it is created |
| --- | --- | --- |
| `apps/desktop` | `main` (with the snapshot worker entry), `preload` (launcher bridge and quiescent preload), `renderer` | Exists since Phase 1 Task 5 (skeleton; the worker and quiescent preload come later) |
| `packages/shared`, `packages/snapshot`, `packages/exporters` | Types and zod schemas; the `.wgsnap` codec and golden vectors; exporters and adapters | `shared` and `snapshot` exist (Phase 1 Tasks 1 to 4); `exporters` when its first code exists |
| `fixtures/` | Controlled test games (`progress-lab` now) | Exists |
| `spikes/` | Throwaway experiments with their own lockfiles, outside the workspace | Exists |
| `crates/` | Rust, only when an ADR-0003 trigger fires | Later |
| `docs/` | Product, specs, ADRs, research, compatibility records, plans | Exists |

The workspace globs grow with the layout (`apps/*`, `packages/*`); no directory is created before its work exists.
`Owner` (AGENTS.md repository map, no empty artifacts)

## Options considered

### Option P1: electron-builder (chosen)

| Dimension | Assessment |
| --- | --- |
| Complexity | Low: one config file; `protocols` wrote `CFBundleURLTypes` and the ad-hoc-signed deep-link build passed H15. Verified (2026-10-24, RESULTS.md H15; `spikes/runtime-compat/electron/electron-builder.json`) |
| Cost and size | Dev dependency only; the NSIS installer stub it ships on Windows has its own license, not checked yet. Unverified |
| Compatibility | `electronFuses`, `extendInfo`, an `afterPack` hook (to strip media usage descriptions, [security.md](../specs/security.md) section 5), `notarize`, NSIS and DMG targets. Verified (2026-10-25, `scheme.json` of `app-builder-lib` 26.18.0 in the spike's `node_modules`; electron-builder docs via context7) |
| Security | Fuses are flipped at package time, before signing. Verified (2026-10-25, electron-builder docs, "Package integrity") |
| Team familiarity | Used in the spike. Verified (2026-10-24, RESULTS.md H15) |
| Reversibility | High: packaging sits at the end of the build. Assumed |
| Pros | The only packager exercised in this repository. Verified (2026-10-24, RESULTS.md H15) |
| Cons | Not the tool Electron's own tutorial recommends. Verified (2026-10-24, runtime-and-storage.md section 2.3) |

### Option P2: Electron Forge 8

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: makers and plugins; `FusesPlugin`, `osxSign` and `osxNotarize` exist; Windows makers include WiX MSI and MSIX. Verified (2026-10-25, Electron Forge docs via context7) |
| Cost and size | Dev dependency; `@electron-forge/cli` 8.0.1, MIT. Verified (2026-10-25, `npm view`) |
| Compatibility | electron-vite documents both Forge and electron-builder, so pairing does not decide it. Verified (2026-10-25, electron-vite docs "Distribution" via context7) |
| Security | Same fuses and signing capabilities. Verified (2026-10-25, Forge docs) |
| Team familiarity | Not exercised here. Verified (2026-10-25, no Forge config in the repository) |
| Reversibility | High. Assumed |
| Pros | Electron's recommended path. Verified (2026-10-24, runtime-and-storage.md section 2.3) |
| Cons | Would need its own spike run of H15 before relying on it. Assumed |

### Option S1: `node:sqlite` (chosen)

| Dimension | Assessment |
| --- | --- |
| Complexity, compatibility | Built in: WAL, `PRAGMA user_version`, close and reopen worked in the main process and a `utilityProcess` with no warning; SQLite 3.53.4. Verified (2026-10-24, RESULTS.md H10) |
| Cost, security | No native addon, no build script, no rebuild per Electron ABI. Assumed |
| Familiarity, reversibility | Synchronous `DatabaseSync` API; raw SQL keeps a switch cheap. Verified for the API (2026-10-25, architecture.md section 7); the rest is Assumed |
| Cons | Its stability label in Node 24.22 is not checked. Unverified (RESULTS.md H10) |

### Option S2: `better-sqlite3` 13.0.3

| Dimension | Assessment |
| --- | --- |
| Complexity, compatibility | Native addon, Node 22 or later; must be rebuilt for Electron's ABI and allowed in `allowBuilds`. Verified for the addon and Node range (2026-10-24, runtime-and-storage.md section 7); the rebuild is Assumed |
| Cost, security, familiarity, reversibility | MIT (Verified (2026-10-25, `npm view`)); a native build per target. Assumed |
| Pros and cons | Mature, but adds the native matrix that ADR-0003 avoids. Assumed |

## Trade-off analysis

electron-builder wins on evidence: it already produced a signed deep-link build that passed H15, and it covers fuses,
`Info.plist` edits and Windows installers. Forge is equally capable on paper but unexercised here. `node:sqlite` removes
the only native dependency the MVP would have had. Assumed

## Consequences

- **Easier:** no native addon in the MVP; one build tool for dev and bundling; packaging config proven once. Assumed
- **Harder:** electron-vite's example `electron-builder.yml` adds camera and microphone usage descriptions, which our
  security spec forbids; the config must not be copied as is. Verified (2026-10-25, electron-vite docs "Distribution")

### Revisit triggers

- electron-builder blocks a signing, notarization, installer or fuse need, or lags an Electron major: run H15 with Forge
  and switch. Assumed
- `node:sqlite` emits an experimental warning or changes its API on an Electron upgrade: move to better-sqlite3. Assumed

## Evidence

- [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H10, H11, H15;
  [runtime-and-storage.md](../research/runtime-and-storage.md) sections 2.3 and 7; [MEMORY.md](../../MEMORY.md) Tooling
  versions and Gotchas; [architecture.md](../specs/architecture.md) sections 2, 6, 7 and 14.

## Facts versus assumptions

- **Facts** (tagged where they appear above): the existing toolchain works at the versions listed; `node:sqlite`, zstd
  and Playwright work with Electron 45 here; electron-builder produced the H15 build; both packagers support fuses and
  notarization.
- **Assumptions** (Assumed): electron-builder keeps up with Electron; the NSIS stub fits the dependency policy;
  electron-vite 6 builds the five entries without trouble (peer range checked, no build run).

## Action items

- [ ] Before the first Windows release, check the license of everything the installer ships (agent).
- [ ] Phase 1 release check: fuses, `Info.plist` usage descriptions and `CFBundleURLTypes` of the packaged app
  (security.md S-14; agent).
- [x] Phase 1: make the desktop package config follow the dependency declaration rule above (electron-vite
  externalization and bundling settings). Done in Phase 1 Task 5: `react` and `react-dom` (bundled into the renderer)
  are `dependencies`; main keeps electron-vite's default externalization of `dependencies`; the preload is one bundle
  (`externalizeDeps: false`); the guard runs in all three builds and failed a real build on a devDependency import
  (see "Dependency declaration"). Leaving the renderer's bundled packages out of the packaged `node_modules` is part of
  the electron-builder config (Task 16) (agent).
- [x] Phase 1: confirm how `pnpm licenses list` treats our own AGPL workspace packages. Done in Phase 1 Task 1. In a
  scratch workspace (package A depends on package B through `workspace:*`, both private and `AGPL-3.0-or-later`, B
  depends on `ms@2.1.3`), `pnpm licenses list --prod --recursive --json` printed only `ms@2.1.3` (MIT): neither A nor B
  was listed, so they cannot trip the production gate, and B's own dependency is not hidden. Verified (2026-10-25,
  pnpm 12.15.0, run locally; recorded in `MEMORY.md`). The gate also takes the workspace package names from
  `pnpm ls -r --depth -1 --json` and exempts a listed workspace package only while its license is
  `AGPL-3.0-or-later`, in case a later pnpm lists them; the unit tests pin that, including that a GPL dependency of a
  workspace package still fails (agent).
