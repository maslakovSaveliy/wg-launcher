# progress-lab

A controlled test game: a page with two buttons that leaves verifiable, persisted progress in browser storage. **It is
not a real game and exists for tests only.** The runtime spike (`spikes/runtime-compat/`) uses it to check session
isolation and save export and restore, and later end-to-end tests of the launcher can reuse it. Nothing in `public/`
loads third-party code or makes a network request.

## Run

From the repository root, after `pnpm install`:

```sh
pnpm --filter @wg-launcher/fixture-progress-lab exec playwright install chromium   # once
pnpm test:e2e                      # bundled Chromium and, locally, installed Google Chrome
pnpm test:e2e --project=chromium   # what CI runs
```

By hand: `node fixtures/test-games/progress-lab/server.mjs --port 4317`, then open `http://localhost:4317/`. The tests use
port 4317 unless `PROGRESS_LAB_PORT` is set. `--repeat-each=3` and other Playwright options pass through `pnpm test:e2e`.

## Interface contract

Other code (the spike, Phase 1 end-to-end tests) depends on these names. Change them only together with their users.

### Server: `node server.mjs --port <n>`

- Needs no dependencies. Serves `public/` on `127.0.0.1` and `[::1]` at the same port, so both `http://127.0.0.1:<n>/`
  and `http://localhost:<n>/` work whichever address `localhost` resolves to. If the IPv6 loopback does not exist the
  server serves `127.0.0.1` only and prints a warning. It listens on loopback only.
- `127.0.0.1` and `localhost` are different sites. `iframe-host.html` on one embeds the game cross-site on the other.
- Content types for `.html`, `.js`, `.mjs`, `.json`, `.wasm`, `.css`, `.svg` and `.png`; anything else is
  `application/octet-stream`. Only `GET` and `HEAD`.
- Paths under `/coi/` serve the same files with `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`, so `crossOriginIsolated`
  is `true` there. `/coi/` serves `index.html`. Other paths send none of these headers. `iframe-host.html` is meant for
  the plain paths: under `/coi/` its cross-origin iframe would be blocked by `require-corp`.
- A request that resolves outside `public/` gets 403 (a malformed or NUL or backslash path gets 400). The check works on
  the raw path decoded once, so `..`, `%2e%2e`, `..%2f` and `//..` are refused.
- Every request is logged to stdout as `<ISO time> <method> <Host header> <url> <status>`. The spike reads this log to
  show that no request for `game.js` or `sw.js` reached the server (hypothesis H14, variant b).
- Without a valid `--port` (1 to 65535) it exits with status 2 and a usage line.

### Page: `index.html`

| Element | Meaning |
| --- | --- |
| `#play-step` | Advances the game by one step and saves it |
| `#reset` | Deletes all fixture storage and returns to the initial state |
| `#progress-hash` | SHA-256 (64 hex digits) of the canonical persisted state, read back from storage, never from memory |
| `#progress-hash[data-ready]` | `true` once the hash matches what is shown, `false` while a step or reset is running or before load, `error` after a failure |
| `#level`, `#coins`, `#inventory` | The state, updated together with the hash |
| `#error` | Hidden unless something failed |

- Both buttons are disabled until the first hash is computed. Level, coins and hash change in the same task as
  `data-ready` becoming `true`, so a test can wait for either.
- Loading never writes. A restored or damaged storage is shown as it is, and the hash is recomputed from it.
- `?ephemeral=1` deletes all fixture storage (the `progress-lab:` localStorage keys and both IndexedDB databases)
  before anything is rendered. It wipes on load only: progress made in that session is saved and a later normal load
  sees it.
- `window.progressLab` is `{ version }` and read-only. Nothing else global is part of the contract.
- The service worker `sw.js` is registered at `./sw.js` (scope `/` or `/coi/`), precaches `./`, `index.html` and
  `game.js` and answers cache-first with `ignoreSearch`. Change `CACHE_NAME` when a precached asset changes, or an
  existing session keeps serving the old one.

### `iframe-host.html?src=<url>`

Embeds `<url>` in `<iframe id="game-frame">`. Only absolute `http` and `https` URLs are embedded; anything else leaves
the frame empty and shows `#host-error`.

## Game rules

State is `{level, coins, inventory, steps}` and starts as `{1, 0, [], 0}`. One step adds 10 coins. Every third step also
adds one level and one item named `<item>-<n>` (`wooden-sword-1`, `iron-shield-1`, ... then `wooden-sword-2`).

All timestamps are synthetic: step `N` happens `N` minutes after `2026-01-01T00:00:00.123Z`. Binary values are
deterministic. So the persisted state, and the hash, depend only on the number of steps. Two independent sessions that
play the same steps get the same hash.

## Storage shapes

| Where | Contents |
| --- | --- |
| `localStorage` `progress-lab:state` | JSON `{"level","coins","inventory","steps"}` |
| `localStorage` `progress-lab:format` | `"1"` |
| IndexedDB `progress-lab`, version 1, store `profile` | `keyPath: "id"`, index `by-level` on `level`. One record `id: "player"` with `level`, `coins`, `inventory`, `updatedAt` (Date), `checksum` (ArrayBuffer: SHA-256 of the `progress-lab:state` string) and `thumbnail` (Blob, `image/svg+xml`) |
| IndexedDB `progress-lab`, store `stepLog` | `autoIncrement: true`, no key path (keys 1, 2, 3, ...). One record per step: `step`, `at` (Date), `coinsGained`, `roll` (Uint8Array of 8 bytes) |
| IndexedDB `/home/web_user`, version 21, store `FILE_DATA` | The shape Emscripten IDBFS uses: no key path, index `timestamp`, keys are absolute paths, values `{timestamp: Date, mode: number, contents?: Uint8Array}`. Three records: `/home/web_user` and `/home/web_user/save` (directories, mode 16877) and `/home/web_user/save/slot1.dat` (file, mode 33206) |

`slot1.dat` is 53 bytes: `PLAB`, a layout byte (`1`), then `level`, `coins`, `steps` and the inventory size as four
little-endian `uint32`, then the 32-byte SHA-256 of the `progress-lab:state` string. Playing a step rewrites the profile
and the three files and appends one log record. A reset (or `?ephemeral=1`) deletes both databases, so the `stepLog` key
generator starts again at 1. Clearing only the store would not: Verified (2026-10-24, Chromium 156 run), keys 1 and 2, then `clear()`, then
the next `add` gets key 3.

## Canonical state and hash

The hash input is one JSON text built from everything the fixture persisted, read back through the storage APIs:

- the `progress-lab:` localStorage entries;
- for each of the two databases, `null` when it does not exist, otherwise its name, version and, in name order, every store
  (name, key path, auto-increment, indexes with key path, unique and multi-entry) and every record with its key in
  key order.

Object keys are sorted, a Date is `{"$date": <ISO string>}`, an ArrayBuffer `{"$arraybuffer": <hex>}`, a typed array
`{"$view": <type>, "hex": <hex>}` and a Blob `{"$blob": {"type", "hex"}}`. A value of another type is an error, never
skipped. The text is hashed with `crypto.subtle.digest("SHA-256")`.

Because the schema is part of the hash, a restore that loses an index, a key path or the auto-increment flag changes it
just as a lost record does. The origin is not part of it: the same state has the same hash on any origin.

## Tests

`tests/progress.spec.ts` runs in two Playwright projects, `chromium` (bundled) and `chrome` (`channel: "chrome"`, needs
Google Chrome installed, local only). It covers persistence across reload, ephemeral mode, byte-equal binary
roundtrip with Date types, cross-site iframe partitioning (with a same-site control), reset, hash determinism and
sensitivity, cross-origin isolation, the service worker, `iframe-host.html` validation and the server's own behavior
(traversal, hosts, content types, logging, arguments). Every test also fails on an uncaught page error or a console error.

Gotcha, Verified (2026-10-24, Playwright 1.64.1 `chromiumSwitches` source and a run of this suite with and without the
override): Playwright starts Chromium with `ThirdPartyStoragePartitioning` disabled (issue 32230), so by default a
cross-site iframe shares storage with the top-level page, unlike stock Chrome. `playwright.config.ts` replaces the
`--disable-features` switch to turn partitioning back on. Any other Playwright-driven check of iframe storage needs the
same.
