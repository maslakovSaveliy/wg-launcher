# THROWAWAY spike — not product code

Runtime-compatibility spike for ADR-0002 (desktop runtime) and ADR-0005 (save transfer). It produces evidence for the
frozen, pre-registered hypotheses in [HYPOTHESES.md](HYPOTHESES.md); the verdicts and their evidence files are in
[RESULTS.md](RESULTS.md). After ADR-0002 is decided this directory is deleted or archived and only the results are kept.
Nothing here is reused by the launcher.

## Layout

| Path | What it is |
| --- | --- |
| `HYPOTHESES.md` | Frozen hypotheses, thresholds and decision rules (never edited; amendments only in its last section) |
| `RESULTS.md` | One row per hypothesis: status, evidence file, deviations from the method |
| `server.mjs` | Spike server, no dependencies: serves `probe/`, `/coi/` prefix with COOP/COEP, token-protected `POST /results/<runtime>` |
| `probe/` | Shared probe pages (Electron, Chrome, Safari): capabilities, frame-time scene, cold start, storage markers, permissions, and `demo-hooks.js` for the public demos |
| `results.schema.json`, `validate.mjs` | JSON Schema for every result file and its validator (`ajv` from `electron/node_modules`) |
| `run.mjs` | Orchestrator for Electron: fixture server + spike server + one Electron launch per check, verdicts, schema validation |
| `electron/` | Electron 45.0.0 spike app with its own `package-lock.json` (npm, outside the pnpm workspace) |
| `common.mjs`, `run-compare.mjs`, `groups/` | Task 6: shared helpers; the non-timing checks of Chrome (Playwright), Chrome `--app`, the Safari WebKit proxy and the public demos |
| `run-timing.mjs`, `timing-logic.mjs` | Task 6: the hands-off measurements (frame time calibration and H7, cold and warm start, memory, demo frame samples), built but not run: deferred to Phase 1 |
| `demos.json` | The six public demos of H21, fixed before any demo run |
| `matrix.mjs` | Generates `docs/compat/matrix.md` from `results/*.json` (see `docs/compat/methodology.md`) |
| `results/` | Committed result JSON: `<runtime>-<version>-<UTC timestamp>.json` (probe payloads and run aggregates) |

`electron/main.mjs` runs one check per launch (`--mode=...`). Game and probe windows always have sandbox and context
isolation on and no preload; the only preload (`quiescent-preload.cjs`) belongs to the hidden export/restore window,
whose documents are our own empty stubs. `isolated-snapshot.js` is the exporter/importer that runs in an isolated world.
`deeplink.mjs` is the entry point of the packaged app used only for H15.

## Run

Requirements: macOS arm64, Node 24, the repository checked out. The progress-lab fixture needs no install.

```sh
cd spikes/runtime-compat/electron && npm ci && cd ..
node run.mjs --runtime=electron                       # every group, about 12 minutes
node run.mjs --runtime=electron --only=h14            # one or more groups
node validate.mjs results/*.json                      # schema check of committed results
```

Groups: `storage` (H1, H2, H2b), `coi` (H3, H4), `gpu` (H5, H6), `sqlite` (H10), `playwright` (H11 and storage
partitioning under Playwright), `h14`, `h16`, `package` (H15), `permissions` (H12, H13), `coldstart` (H8),
`frametime` (H7, H7b), `memory` (H9).

- Windows appear on screen. The timing groups and `permissions` need the window visible and focused, so they are skipped
  while the macOS screen is locked (`--allow-locked` runs them anyway; the runs are then INVALID, never PASS).
- `frametime` first runs a short provisional calibration sweep in Electron with vsync off; the calibration that counts is
  the one in Chrome (Task 6). `--load=<n>` skips the sweep.
- `package` builds `electron/dist/mac-arm64/wgspike.app` with electron-builder (`identity: null`), signs it ad hoc with
  `codesign --force --deep --sign -`, runs the deep-link cases, then unregisters the `wgspike://` scheme
  (`lsregister -u <app>`), deletes `electron/dist/` and the app's user data in `~/Library/Application Support/wgspike`.
  If a run is interrupted, do the same by hand. `setAsDefaultProtocolClient` also leaves a LaunchServices handler
  preference for `wgspike` that these steps do not remove; it is harmless, and RESULTS.md (H15) has an untested
  removal recipe.
- Ports 4417 (fixture) and 4418 (spike server) must be free; `--fixture-port` and `--spike-port` change them.
- Results are written only with the per-run token. `run.mjs` makes a random token, starts the server with
  `--token <token>` and hands it to every Electron launch, which adds `token=<token>` to the probe URL. The probe sends
  it back in an `X-WG-Token` header, and it is removed from the recorded URL (`page.url`) and replaced by `<token>`
  anywhere else before a file is written. The server also refuses a POST whose `Origin` is not its own
  (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://[::1]:<port>`) and sends no CORS headers, so other pages
  open in a browser cannot write into `results/`. Run by hand, `node server.mjs --port 4418` prints `TOKEN <token>`;
  open the probe as `http://localhost:4418/?token=<token>`. A probe served from another origin (Tauri packaged assets,
  Task 6) needs `--allow-origin <that origin>` plus `?server=http://localhost:4418&token=<token>`.
- To retry H3 or H4 on Electron 44.9.x (only if they fail on 45.0.0): copy `electron/` to `electron-44/`, run
  `npm install --save-exact electron@44.9.3` there and pass `--electron-dir=electron-44`.

### Chrome, Safari proxy, demos and timing (Task 6)

Tauri was not built (RESULTS.md, H17 and H18: N/A). Google Chrome must be installed in `/Applications`; Safari is only used for
the capability proxy. Both runners reuse `electron/node_modules` (Playwright, ajv).

```sh
node run-compare.mjs                              # chrome, chromium, app, safari, demos: about 6 minutes, windows appear
node matrix.mjs > ../../docs/compat/matrix.md     # regenerate the matrix (run twice and diff: identical)
node run-timing.mjs --smoke --runs=1              # wiring check of the timing runner with tiny durations (scratch results)
```

- `run-compare.mjs` opens the probe in the owner's Safari (a new tab in the running window) and closes only the tabs it opened
  (AppleScript, needs the Automation permission once). The `app` group starts and quits several Chrome instances with
  temporary profiles under the system temp directory and removes them; a screenshot of the app window is taken with
  `screencapture` and not stored (use `--keep-temp` to look at it, then delete the temp directory).
- `run-timing.mjs` (with `timing-logic.mjs`) is the **hands-off** runner for H7, H8, H9, H20-6 and the demo frame samples. **It
  was never run for a result: the owner deferred those measurements to Phase 1 (2026-10-25).** It was only wiring-checked with
  tiny durations and mocked inputs. If it is ever used: nobody may touch keyboard or trackpad, switch apps or let the display
  sleep; the machine must be on AC power (it refuses to start otherwise unless `--allow-battery`, and refuses while the screen
  is locked); it waits for 30 s without input before every group, holds the display awake with `caffeinate`, and marks runs
  that lose focus or visibility, see input, run on battery or report a thermal limit as INVALID (retried at most twice).
  Smoke results are not evidence: delete the scratch directory it prints.

Every run records the OS version, CPU, GPU, display refresh rate (Electron `screen.getPrimaryDisplay().displayFrequency`),
power source and screen-lock state in the aggregate file. Home directory, repository path, temp paths and the user name
are replaced by `~`, `<repo>`, `<tmp>` and `<user>` before anything is written to `results/`.
