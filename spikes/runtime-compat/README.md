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
| `server.mjs` | Spike server, no dependencies: serves `probe/`, `/coi/` prefix with COOP/COEP, `POST /results/<runtime>` |
| `probe/` | Shared probe pages (Electron now, Chrome and Tauri in Task 6): capabilities, frame-time scene, cold start, storage markers, permissions |
| `results.schema.json`, `validate.mjs` | JSON Schema for every result file and its validator (`ajv` from `electron/node_modules`) |
| `run.mjs` | Orchestrator: fixture server + spike server + one Electron launch per check, verdicts, schema validation |
| `electron/` | Electron 45.0.0 spike app with its own `package-lock.json` (npm, outside the pnpm workspace) |
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
  If a run is interrupted, do the same by hand.
- Ports 4417 (fixture) and 4418 (spike server) must be free; `--fixture-port` and `--spike-port` change them.
- To retry H3 or H4 on Electron 44.9.x (only if they fail on 45.0.0): copy `electron/` to `electron-44/`, run
  `npm install --save-exact electron@44.9.3` there and pass `--electron-dir=electron-44`.

Every run records the OS version, CPU, GPU, display refresh rate (Electron `screen.getPrimaryDisplay().displayFrequency`),
power source and screen-lock state in the aggregate file. Home directory, repository path, temp paths and the user name
are replaced by `~`, `<repo>`, `<tmp>` and `<user>` before anything is written to `results/`.
