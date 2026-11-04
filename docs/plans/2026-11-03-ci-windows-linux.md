# CI for Windows and Linux builds (2026-11-03)

> Approved by the owner on 2026-11-03 ("start with CI"). Small plan, one branch, one pull request.

**Goal:** CI proves that the desktop app packages on Windows and Linux, that the packaged app carries the release fuses
and a clean `app.asar`, and runs the desktop e2e suite on Windows. This proves the build and the tests on hosted runners
without a GPU; it is never a compatibility claim for games (AGENTS.md honesty rule 3). A run on real Windows hardware
comes later, by hand.

## Decisions

- Targets: `dir` for Windows x64 and Linux x64 (no installer, no signing), next to the existing macOS arm64 `dir`.
  Linux gets `executableName: wglauncher`, so the binary has a fixed name.
- The release check reads any of the three layouts: a macOS `.app` (fuses, `Info.plist`, `Contents/Resources/app.asar`)
  or a `*-unpacked` directory (fuses of the executable, `resources/app.asar`). The `Info.plist` rules are macOS only;
  Windows and Linux have no usage descriptions to strip, and they register the `wglauncher` scheme through an
  installer, which a `dir` build does not have. The layout choice is a pure function with unit tests, written first.
- A new CI job `package` (macOS, Windows, Ubuntu) packages the app and runs the release check. It needs the `changes`
  job, like the other test jobs.
- The desktop e2e job gains `windows-latest`, non-blocking (`continue-on-error`) until it has passed: its failures are
  reported in the run, they do not fail the pull request. Making it blocking is a later, separate change.

## Steps

- [x] Unit tests for the packaged layout (macOS, Windows, Linux paths; an unknown path is refused), then the code in
  `apps/desktop/scripts/release-check.mjs`.
- [x] `electron-builder.yml`: `win` and `linux` `dir` targets; `package:win`, `package:linux` and a release check that
  takes the packaged path.
- [x] `.github/workflows/ci.yml`: the `package` job and Windows in the desktop e2e matrix.
- [x] Docs: AGENTS.md "Commands" and the CI paragraph, README platform rows, MEMORY.md.
- [ ] Verify: unit tests, lint, typecheck, `actionlint`, a local Linux `dir` package and its release check on the Mac,
  then CI on the pull request (the only place Windows packaging and Windows e2e run).

## First CI run (2026-11-03)

- Windows packaging built, but the release check found no `/out/main/index.js`: `@electron/asar` lists archive paths
  with backslashes on Windows. The check now normalizes them (unit test with Windows paths, written first).
- Desktop e2e on Windows (non-blocking): 58 of 60 passed. Failed: `delete.spec.ts` "delete local saves backs up and
  verifies first..." (the app closed during the test) and `shortcut.spec.ts` "Create shortcut writes an .inetloc..."
  (the test expects the macOS file). Both are follow-ups before the Windows job becomes blocking. Verified (2026-11-03,
  CI run 41655557130)
