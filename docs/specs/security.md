# Security specification

Status: draft for Phase 1, 2026-10-25. Normative for `apps/desktop` and the packages. It details the security
invariants of [AGENTS.md](../../AGENTS.md#security-invariants-for-game-sessions) and the data-safety invariants
([AGENTS.md](../../AGENTS.md#data-safety-invariants)); the process model is in [architecture.md](architecture.md), the
archive rules in [snapshot-format.md](snapshot-format.md) and the export machinery in [save-transfer.md](save-transfer.md).
Conventions (MUST, claim tags, `Assumed` for calls made here) are those of
[snapshot-format.md](snapshot-format.md#conventions).

## 1. Assets

| Asset | Why it matters |
| --- | --- |
| Game progress: live partition data, snapshots, backups | Losing it is a product failure (PRD anti-goal 2) |
| The user's machine: files, processes, OS integration | Reachable only through the main process |
| Credentials inside game sessions: cookies, tokens of game sites | Never exported, never logged; cookies encrypted on disk |
| Privacy: camera, microphone, location, screen, one game's data from another, the local network | Denied to games |
| The library database and settings | Integrity of the library and of the honest badges |
| The installed app (asar, binaries) | Code integrity: fuses, later code signing |

## 2. Trust boundaries

| Id | Boundary | Untrusted side |
| --- | --- | --- |
| TB1 | Game window ↔ main process | Game content (pages, iframes, workers) |
| TB2 | Game ↔ game | Every other game's session |
| TB3 | Launcher renderer ↔ main process | The renderer, which shows untrusted strings (titles, URLs, snapshot metadata) |
| TB4 | Snapshot file ↔ snapshot worker and main | Any `.wgsnap` file, including our own after it left the machine |
| TB5 | OS ↔ main process | Deep links, launch arguments, shortcut files, second-instance messages |
| TB6 | Quiescent window ↔ main process and worker | The game origin's storage contents and anything the game left registered (service workers) |
| TB7 | Network ↔ game window | Game servers and anything on the path |
| TB8 | Development servers ↔ development builds | Other local pages and processes |
| TB9 | Logs and diagnostics → the user, bug reports | Readers of a log file |

## 3. Threats

STRIDE-lite: S spoofing, T tampering, R repudiation, I information disclosure, D denial of service, E elevation of
privilege. `Assumed` for the analysis; the mitigations cite where they are specified.

| Id | TB | Threat | Mitigation | Test |
| --- | --- | --- | --- | --- |
| T1 | 1 | E: game code reaches Node, the filesystem or launcher IPC | Sandboxed window without preload or IPC; window factory ([architecture.md](architecture.md#5-game-windows-and-sessions)) | AC-3, S-1, S-2 |
| T2 | 2 | I: a game reads another game's storage, cookies or HTTP cache | `persist:game:<gameId>` per entry, never shared with the UI | AC-2, S-3 |
| T3 | 1 | I: camera, microphone, location, notifications, screen capture | Deny in request and check handlers (section 5); no macOS usage descriptions | AC-4, S-4 |
| T4 | 1 | S/E: top-level navigation to a phishing site, `file:` or a custom scheme | Same-site rule with a URL parser; subframe scheme allowlist (section 5) | AC-5, S-5 |
| T5 | 1 | E: popups or `shell.openExternal` with a dangerous URL | Window opens denied; http and https only after confirmation (section 5) | AC-5, S-5 |
| T6 | 1 | T: drive-by downloads, File System Access writes | Downloads cancelled; `fileSystem` denied | AC-5 |
| T7 | 1 | D: dialog loops, `beforeunload` traps, hung renderer | `safeDialogs`; `will-prevent-unload` asks the user; "Force close" | S-7 |
| T8 | 1 | D/I: game processes survive the window (service workers) | Close procedure ([architecture.md](architecture.md#4-game-session-lifecycle)) | AC-13, S-9 |
| T9 | 1 | E: game code runs with Node via a misconfigured window | `app.on("web-contents-created")` baseline; no `<webview>`; fuses | S-1, S-14 |
| T10 | 6 | T/I: game code (scripts, service workers) runs during export | Stub, CSP, service worker bypass, canary, fail-closed interceptor ([save-transfer.md](save-transfer.md#5-quiescent-window)) | AC-7, S-13 |
| T11 | 4 | T/D/E: hostile archive: traversal, links, devices, bombs, parser bugs | Entry rules, limits, canonical decoding, validation in the worker before any write ([snapshot-format.md](snapshot-format.md#3-entries)) | AC-9, S-6, S-8 |
| T12 | 4 | T: a snapshot writes into another origin's storage | Storage keys checked; mapping only after a native confirmation naming both keys | AC-24, S-16 |
| T13 | 4 | T: an import destroys existing saves | Backup, wipe, import, verify, rollback ([save-transfer.md](save-transfer.md#6-restore-protocol)) | AC-8, S-7 |
| T14 | 6 | I: a snapshot carries cookies or tokens | Cookies and credentials never read; only declared data; tokens in localStorage are a residual risk (section 12) | AC-20, S-17 |
| T15 | 5 | S/E: malformed deep link or argument, switch injection | Exact pattern; unknown id shows the library; no navigation ([architecture.md](architecture.md#8-shortcuts-and-deep-links)) | AC-19, S-11 |
| T16 | 3 | E: XSS in the launcher through titles, URLs or metadata | React text rendering only, no `dangerouslySetInnerHTML`, strict CSP with Trusted Types (section 6) | S-15 |
| T17 | 3 | E: a compromised renderer abuses IPC (paths, URLs, destructive calls) | No paths or URLs to open over IPC; zod; native confirmations in main ([architecture.md](architecture.md#6-ipc-contract)) | S-10 |
| T18 | 1, 6 | S: a game frame or stub sends IPC as if it were the launcher | Sender frame and origin checks; quiescent nonce handshake | S-10 |
| T19 | 9 | I: logs leak tokens, cookies, save contents | Redaction (section 9) | AC-20, S-12 |
| T20 | — | E: the installed app is modified or run as Node | Fuses (section 4); code signing later (section 10) | S-14 |
| T21 | 8 | I/T: other local pages talk to development servers | Loopback only; the spike server needs a per-run token and checks `Origin`; dev origins refused by every production-flavor policy call, which receives the compile-time `FLAVOR` (Assumed design; the refusal is unit-tested, section 5 "Implementation") | S-18 |
| T22 | 7 | S: TLS errors bypassed or a client certificate leaked | Certificate errors never overridden; no client certificate selected (section 5) | S-5 |
| T23 | — | E: a malicious dependency | Dependency policy, exact versions, `allowBuilds`, few dependencies in security code (section 10) | `pnpm licenses:check` |
| T24 | — | R: nobody can tell what happened to a save | Restore journal, logged job steps without content, backups kept | AC-8 |

## 4. Fuses

Set on every packaged build through electron-builder's `electronFuses` setting (ADR-0004), which uses `@electron/fuses`:
`app-builder-lib` 26.18.0 depends on `@electron/fuses` ^1.8.0 and its schema has `electronFuses`. Verified (2026-10-25,
`package.json` and `scheme.json` of `app-builder-lib` in the spike's dependencies). Names and defaults Verified (2026-10-25,
<https://www.electronjs.org/docs/latest/tutorial/fuses>); the off and on choices for the first seven come from the
research. Verified (2026-10-24, [runtime-and-storage.md](../research/runtime-and-storage.md) section 2.4).

| Fuse | Setting | Reason |
| --- | --- | --- |
| `runAsNode` | Off | No `ELECTRON_RUN_AS_NODE`; background work uses `utilityProcess` |
| `nodeOptions` | Off | No `NODE_OPTIONS` injection |
| `nodeCliInspect` | Off | No `--inspect` attach (e2e builds are unfused, [architecture.md](architecture.md#14-testing-notes-from-the-spike-must)) |
| `grantFileProtocolExtraPrivileges` | Off | Nothing is served from `file://` |
| `cookieEncryption` | On | Game cookies encrypted with OS keys; one-way, and macOS needs a signed app |
| `embeddedAsarIntegrityValidation` | On (macOS, Windows) | `app.asar` validated on load |
| `onlyLoadAppFromAsar` | On | No code outside the validated asar |
| `loadBrowserProcessSpecificV8Snapshot` | Default (off) | Not needed. `Assumed` |
| `wasmTrapHandlers` | Default (on) | Turning it off adds bounds checks and slows WebAssembly games. `Assumed` |

A release check reads the fuses of the packaged app and fails on any difference (S-14). `Assumed`

## 5. Permission and navigation policy

**Permissions (AC-4).** Electron approves every permission unless a handler denies it. Verified (2026-10-24,
<https://www.electronjs.org/docs/latest/api/session>). Electron 45's handlers receive these names, among others:
`fullscreen`, `pointerLock`, `keyboardLock`, `media`, `display-capture`, `geolocation`, `notifications`,
`clipboard-read`, `clipboard-sanitized-write`, `persistent-storage`, `storage-access`, `top-level-storage-access`,
`fileSystem`, `openExternal`, `midi`, `midiSysex`, `hid`, `serial`, `usb`, `local-network-access`, `loopback-network`,
`screen-wake-lock`, `window-management`, `idle-detection`, `unknown`. Verified (2026-10-25, `electron.d.ts` in the
`electron@45.0.0` package).

| Permission | Request handler | Check handler |
| --- | --- | --- |
| `fullscreen`, `pointerLock`, `keyboardLock` | Allow | Allow |
| Every other name, including future ones | Deny and log | Deny and log |

- Both handlers are installed on every game session (the request handler alone is incomplete: most APIs check first).
  Verified (2026-10-25, same `electron.d.ts`). `Owner` for the allowlist (AGENTS.md security invariant 3).
- Also on every game session: `setDevicePermissionHandler` returns `false`; `select-hid-device`, `select-serial-port`
  and `select-usb-device` are answered with no device; the Bluetooth pairing handler and `select-bluetooth-device`
  cancel; no display-media handler is installed. `Assumed`
- Denials are logged with the permission name and the requesting origin, at most once a minute per game and
  permission, because checks can repeat. `Assumed`
- In the spike, camera, geolocation, notifications and display capture were denied by these handlers, and the three
  allowed ones succeeded. Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H12).
- **Media before the OS prompt (MUST, spike finding H12).** With macOS microphone access undecided, a microphone request
  never reached the handler (stalled 8 s); after the OS permission was granted, it reached the handler and was denied.
  Verified (2026-10-24, RESULTS.md H12). The prebuilt Electron 45 app's `Info.plist` contains
  `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` and two Bluetooth usage
  descriptions. Verified (2026-10-25, `plutil -p` on `Electron.app` of `electron@45.0.0`). Therefore:
  1. `media` and `display-capture` are denied in both handlers;
  2. the packaged `Info.plist` MUST NOT contain the camera, microphone, audio-capture or Bluetooth usage descriptions
     unless an ADR adds a feature that needs one; the packaging step removes them and the release check asserts their
     absence;
  3. on the packaged app, with the macOS microphone and camera permissions undecided, denied and granted, a game's
     `getUserMedia` MUST reject with `NotAllowedError`, MUST NOT show an OS prompt, and the app MUST keep running. What
     macOS does when a process without a usage description touches the device is Unverified (see Open questions).

**Navigation and windows (AC-5).** URL decisions are pure functions on WHATWG `URL` objects, never string prefixes.

| Event | Rule |
| --- | --- |
| `will-navigate`, `will-redirect` (main frame) | Allowed only for `https` (and development origins, PRD OQ-3) with `siteOf(url)` equal to the site of the entry's URL; otherwise prevented, and for http or https the user is asked "Open in browser?" |
| `will-frame-navigate` (subframes) | Allowed for `https`, `http`, `about:blank`, `about:srcdoc`, `blob:`, `data:`; every other scheme prevented |
| `setWindowOpenHandler` | Always `{action: "deny"}`; an http or https URL is offered to the system browser after confirmation |
| `will-download` | Prevented (`event.preventDefault()` cancels) and logged |
| `will-attach-webview` | Prevented |
| `login`, `certificate-error` | No credentials; certificate errors are never overridden |
| `select-client-certificate` | Prevented with no certificate (by default Electron picks the first one: Verified (2026-10-25, `electron.d.ts`)) |

- **`shell.openExternal`** receives only a URL that passes `isExternalUrlAllowed`: it parses, the scheme is `https:` or
  `http:`, there is a host and no user info, and it is at most 2048 characters. The confirmation is a native dialog that
  shows the host in its punycode form, so a lookalike name is visible. One confirmation per window at a time; others
  are dropped and logged; after a Cancel, that window's requests are dropped and logged for 10 s
  (`EXTERNAL_COOLDOWN_MS`, Assumed), so a game cannot re-ask forever. `window.open` is not gated on a user gesture:
  Electron 45's window-open handler details have no activation flag (Verified, 2026-10-25 `electron.d.ts`
  `HandlerDetails`), and a `window.open` without a gesture reached the handler and was offered (Verified, 2026-10-28,
  `apps/desktop/e2e/game-isolation.spec.ts`). Never any other scheme (AGENTS.md security invariant 5). `Owner` for the rule, `Assumed` for
  the details.
- The unit tests (S-5) cover at least: `javascript:`, `file:`, `wglauncher:` and `app:` URLs; `https://user:pass@host`
  and `https://good.example@evil.example`; an IDN lookalike; `https://example.com.evil.net` and `https://evil-example.com`
  against `https://example.com`; `http` against `https` (schemeful site); two hosts under a public suffix such as
  `co.uk`; leading spaces and upper case; over-long URLs.
- **Implementation (Phase 1 Task 7a).** The rules are pure functions in `apps/desktop/src/main/policy/`
  (`url-rules.ts`, `site.ts`, `permissions.ts`) with their tests beside them; the build flavor is a parameter, and the
  app passes the compile-time `FLAVOR`. Details settled there, `Assumed`:
  - An http or https input is refused before parsing when its raw text has a shape the WHATWG parser would silently
    repair, because a repair is where two parsers can disagree: control characters, spaces or DEL anywhere (also
    leading and trailing ones; nothing is trimmed), a backslash anywhere (`https:\\evil.com`,
    `https://evil.com\.example.com`), a scheme not followed by exactly `//` and a host (`https:evil.com`,
    `https:///evil.com`), and `@` or `%` in the authority (user info in any form, also an empty one such as
    `https://@evil.com`, which the parser drops silently; percent-encoded host characters such as `exa%2Emple.com`,
    which the parser decodes into `exa.mple.com`). This applies to the whole text of entry URLs and of
    `isExternalUrlAllowed` (one is typed by the user, the other goes to another program), but only to the scheme and
    authority of a main-frame target (ruling R25, Task 8): Chromium hands `will-navigate` a canonical URL that may
    keep a raw backslash in its path, query or fragment, and repairing what comes after the authority cannot change
    the host, so `?q=a\b%20c#x\y%20z` on the entry's site is allowed while `https://evil.com\.example.com/` is still
    blocked. Not to subframes either (a `data:` frame URL may contain spaces).
  - After parsing, a host with an empty label (`example..com`, `.example.com`, `example.com..`) is refused: tldts
    7.4.19 gives such hosts a domain such as `.com`, which would merge unrelated hosts into one site. `siteOf` itself
    also uses the whole host for them.
  - Lengths are measured on the raw input before parsing and again on `href`, which percent-encoding can lengthen. A
    same-site main-frame target has no length limit; only entry URLs and external opening do.
  - `decideTopNavigation` returns `allow`, `ask-external` (another http or https site, or plain http other than a
    development origin; the caller then checks `isExternalUrlAllowed` and confirms) or `block` (every other scheme, a
    malformed or credential-carrying target, or an entry that is not an allowed entry URL in this flavor, so a
    production build never navigates a stored development entry).
  - Development origins are only the literal hosts `localhost` and `127.0.0.1` in the raw text (any port), in dev and
    test builds; other spellings that the parser maps to `127.0.0.1` (`2130706433`, `0x7f.0.0.1`, `127.1`), `[::1]`,
    `localhost.` and `sub.localhost` are not. A production-flavor call refuses them all (Verified, 2026-10-28,
    `url-rules.test.ts`); Task 8 passes the compile-time `FLAVOR` (`apps/desktop/src/main/index.ts` and `games/lifecycle.ts`); the dev-origin strings are
    still in the prod bundle, because the flavor is a parameter, so `pnpm bundle:check` asserts nothing about them.
  - Subframes: `about:blank` and `about:srcdoc` are matched on the parsed path, so a query or fragment does not
    matter; `about:BLANK` and every other `about:` page are blocked.
  - Permissions: a `Set` lookup with exact case, so `Fullscreen`, `__proto__` or an empty name are denied.
- **Wired in Phase 1 Task 8** (`apps/desktop/e2e/game-isolation.spec.ts`; Verified, 2026-10-28, Electron 45.0.0, macOS
  arm64, one machine, with the macOS screen locked; the allowed-permission bullet below was rerun unlocked, see there):
  - camera `getUserMedia` got no stream (`NotFoundError` on this run; the cause, that Chromium offered no camera
    because the check handler denies `media`, is Assumed), `permissions.query({name: "microphone"})` gave `denied` (the check handler; no
    `getUserMedia` for audio is ever made in e2e, so no OS prompt can appear), geolocation error code 1, notifications
    `denied`, display capture and `getScreenDetails` `NotAllowedError`; each name was logged once
    (`game.permission-denied`, origin only), `media` once although it was requested and checked. Chromium also checks
    `automatic-fullscreen` on `requestFullscreen()`; it is denied like any other name and fullscreen still works.
  - fullscreen and keyboard lock succeeded after their own clicks; with the screen locked, pointer lock failed with
    `WrongDocumentError` (MEMORY.md, H13), so that run did not verify it. Rerun with the screen unlocked (Verified,
    2026-10-28, `e2e/game-isolation.spec.ts` "permissions", 3 runs plus the full desktop suite, Electron 45.0.0, macOS
    arm64): pointer lock, fullscreen and keyboard lock all succeeded in a game window, each after its own injected
    click, pointer lock first and released (`pointerlockchange`) before the next click, with the window focused. The
    test checks the `WrongDocumentError` outcome, annotated "pointer lock not verified", when the screen is locked.
  - an off-site link and a `window.open` to an https URL were prevented and offered through the queued dialog; only
    the confirmed one reached the `shell.openExternal` stub; `window.open("file:...")` asked nothing; a download was
    cancelled and logged; a same-site redirect at start loaded and a cross-site one was offered and ended the launch.
  - Task 7a carry: Chromium escapes spaces in the query and fragment before `will-navigate` (`?q=a%20b#x%20y`) but
    hands over a backslash there raw (`?q=a\b%20c#x\y%20z`). The first Task 8 run showed the raw-shape rule
    blocking such a same-site navigation; after ruling R25 (rule above) the e2e test loads both.

## 6. Launcher renderer

- **Scheme.** `protocol.registerSchemesAsPrivileged` runs once before `ready` with `app` and only `standard`, `secure`,
  `supportFetchAPI` and `codeCache`; not `bypassCSP`, `corsEnabled`, `allowServiceWorkers`, `stream` or
  `allowExtensions`. Those privilege names exist in Electron 45. Verified (2026-10-25, `electron.d.ts`). `Assumed` for
  the choice.
- **Handler.** `protocol.handle("app")` on the launcher's session only (the in-memory partition `launcher`, never the
  default session; `apps/desktop/src/main/app-protocol.ts`). Host `launcher`; files only from the packaged
  renderer directory inside the asar (normalized path, containment check) and covers from `covers/` with the exact
  name pattern; everything else is 404. Headers on every response: the CSP below, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy:
  no-referrer`. `Assumed`
- **CSP (production):** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
  connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';
  require-trusted-types-for 'script'; trusted-types 'none'`. The renderer talks to main only through the bridge and
  loads no remote content; covers are local files. Development builds load from the Vite server with a looser CSP and
  check the sender against that origin, a build-time constant. The dev CSP (`apps/desktop/electron.vite.config.ts`,
  sent by the Vite server) adds what Vite needs: `'unsafe-inline'` for scripts (the React refresh preamble) and
  styles, `connect-src` to the dev server's WebSocket, `img-src app://launcher` for covers, and no Trusted Types (the
  Vite error overlay uses `innerHTML`); the test and prod builds never use it. Verified (2026-10-28, one
  `electron-vite dev` run on macOS arm64 with a scratch `WG_USER_DATA`, read over CDP): the dev server sends exactly
  that header, the launcher renders with the bridge connected, the HMR WebSocket connects, a reload logs no CSP
  violation, `eval` is refused (`EvalError`), and a control image from another origin is blocked and logged as a
  `security` error. That `'unsafe-inline'` is needed at all (the refresh preamble) is Assumed, not tested by removal. React 19.3.1 runs under the production
  CSP, `trusted-types 'none'` included, with no CSP or Trusted Types violation during start-up: Verified (2026-10-28,
  `apps/desktop/e2e/launcher.spec.ts` on Electron 45.0.0, macOS arm64; the test records every console message of the
  launcher from before its first load, and its control, an `innerHTML` assignment, is refused with a `TypeError` and
  recorded as "This document requires 'TrustedHTML' assignment"). So the plan's fallback (one named policy) is not
  needed. `Assumed` for the rest of this bullet.
- **Rendering rules:** no `dangerouslySetInnerHTML`, no `innerHTML`; titles, URLs, origins, snapshot metadata, adapter
  text and error messages are rendered as text; the UI never puts a game URL into `href` or `src` (opening is a main
  action). The launcher's own `webContents` denies all navigation, new windows and permissions.
- **Bridge:** `contextBridge.exposeInMainWorld` with one function per channel; `ipcRenderer` itself is never exposed
  (checklist item 20).

## 7. Electron security checklist

The tutorial's 20 items. Verified (2026-10-25, <https://www.electronjs.org/docs/latest/tutorial/security>).

| # | Item | How we comply |
| --- | --- | --- |
| 1 | Only load secure content | Entries must be https; development origins only in development builds |
| 2 | No Node.js integration for remote content | Game windows: `nodeIntegration`, `nodeIntegrationInWorker`, `nodeIntegrationInSubFrames` false |
| 3 | Context isolation | On for every window |
| 4 | Process sandboxing | On for every window |
| 5 | Handle session permission requests | Section 5, on every session |
| 6 | Do not disable `webSecurity` | Never disabled; asserted by the window factory test |
| 7 | Content Security Policy | Launcher CSP (section 6); stub CSP (QW-10); game pages keep their own |
| 8 | No `allowRunningInsecureContent` | False everywhere |
| 9 | No experimental features | False; `enable-unsafe-webgpu` not shipped without an ADR (PRD OQ-7) |
| 10 | No `enableBlinkFeatures` | Never set |
| 11 | No `allowpopups` for WebViews | N/A: no `<webview>` (`webviewTag: false`, attachment prevented) |
| 12 | Verify WebView options | N/A, same reason |
| 13 | Limit navigation | Section 5 |
| 14 | Limit new windows | Section 5 |
| 15 | No `shell.openExternal` with untrusted content | `isExternalUrlAllowed` plus confirmation |
| 16 | Current Electron | A supported major; the fatal hypotheses re-run on every major upgrade (ADR-0002) |
| 17 | Validate IPC senders | Every handler ([architecture.md](architecture.md#6-ipc-contract)); quiescent handshake (QW-4) |
| 18 | Avoid `file://`, prefer custom protocols | `app://launcher`; `grantFileProtocolExtraPrivileges` off |
| 19 | Check fuses | Section 4 |
| 20 | Do not expose Electron APIs to untrusted content | Games get no preload; the launcher bridge exposes typed functions only |

## 8. Archive safety and resource limits

- Every rule of [snapshot-format.md](snapshot-format.md#3-entries) applies, with its limits
  ([section 8 there](snapshot-format.md#8-limits-and-error-codes)). Validation runs in the snapshot worker, so a parser
  crash or memory exhaustion cannot take down the main process. `Assumed`
- An imported file is first copied into `tmp/` (the size limit enforced while copying); validation, import and the
  final rename all use that private copy, so the user's file cannot change between checks. `Assumed`
- Other limits: one task per game and at most two snapshot jobs at once; a watchdog per job
  ([save-transfer.md](save-transfer.md#5-quiescent-window)); 64 KiB per launcher IPC message; one pending external-link
  confirmation per game window; rate-limited denial logs. `Assumed`

## 9. Logging and redaction

- Logs are local files (`logs/`, rotated); nothing is sent anywhere, and there is no telemetry (PRD OQ-4 stays open,
  default none). `Assumed`
- A single `redact()` function runs on every log record and is unit-tested (S-12, AC-20): game URLs are reduced to their
  origin (paths and query strings can hold tokens); the home directory becomes `~`; storage values, localStorage key
  names, record contents, snapshot bytes, cookie and `Authorization` headers are never passed to the logger at all;
  deep-link input is logged only as "valid" with the id or "invalid" with its length. `Assumed`
- Logged events: lifecycle, permission denials, navigation refusals, job steps with counts, sizes and error codes,
  migrations, recovery. Errors shown in the UI follow the same rules.

## 10. Secrets, dependencies, updates and signing

- **Secrets:** the client needs none and contains none. Signing credentials, when they exist, live only in CI secrets.
  secretlint runs on staged files (AGENTS.md); the repository is public. `Owner`
- **Dependencies:** the policy of [AGENTS.md](../../AGENTS.md#dependency-and-license-policy) (permissive shipped
  dependencies, exact versions, deliberate `allowBuilds`, `pnpm licenses:check`). Security-critical parsing (ustar,
  CBOR) is our own small code with golden vectors rather than general-purpose libraries. `Owner` for the policy,
  `Assumed` for the own-code choice.
- **Updates and signing (later):** macOS hardened runtime, signing and notarization; Windows Authenticode; any
  auto-update only over HTTPS with signature verification. The MVP has no auto-update. Electron ships a major every 8
  weeks and supports the latest three. Verified (2026-10-24,
  <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>). `Assumed` for the plan.

## 11. Security tests

| Id | Test | AC |
| --- | --- | --- |
| S-1 | Window factory unit test asserts every `webPreferences` value of [architecture.md](architecture.md#5-game-windows-and-sessions) | AC-3 |
| S-2 | e2e: in a game window `typeof require`, `typeof process` and the launcher bridge are `undefined`, and no IPC reaches main | AC-3 |
| S-3 | e2e: two entries (also with the same URL) do not see each other's localStorage, IndexedDB and cookie markers; the UI session shares nothing with them | AC-2 |
| S-4 | Unit: permission decision table; e2e: the five denied and three allowed; packaged macOS: media requests under undecided, denied and granted OS permission (section 5) | AC-4 |
| S-5 | Unit: URL decision tables (section 5); e2e: off-site navigation, `window.open` and a download are blocked or routed | AC-5 |
| S-6 | Unit: every golden vector gives its expected result | AC-9 |
| S-7 | Integration: failed imports at every step keep the original state and a valid backup; a `beforeunload` trap does not block closing | AC-8 |
| S-8 | Unit: traversal, absolute, link and device entries are rejected before any data is read and nothing is written | AC-9 |
| S-9 | e2e and manual: no process of a game remains 5 s after its window closes or the app quits | AC-13 |
| S-10 | Unit: handlers reject a wrong sender, a subframe, a wrong origin, unknown keys and oversize payloads; the quiescent handshake rejects a wrong frame or nonce | (security) |
| S-11 | Unit: malformed, unknown and hostile deep links and arguments; on Windows, a link with spaces or `--` text cannot add switches (Unverified until run on Windows) | AC-19 |
| S-12 | Unit: `redact()`; integration: a run with tokens in URLs and cookies leaves none in the logs | AC-20 |
| S-13 | e2e: the canary flags an injected main-world script and a started service worker, including the no-bypass iframe control | AC-7 |
| S-14 | Release check on the packaged app: fuses, `Info.plist` usage descriptions, `CFBundleURLTypes` | (security) |
| S-15 | e2e: the launcher's responses carry the CSP and no CSP violation occurs; untrusted titles render as text | (security) |
| S-16 | Integration: a restore under changed storage keys is refused naming both keys and writes nothing | AC-24 |
| S-17 | Integration: a snapshot contains no cookies, HTTP cache, Cache Storage, service workers or shader cache | AC-20 |
| S-18 | Unit (existing spike code is throwaway): Phase 1 development servers bind to loopback only | (security) |

## 12. Residual risks

- A site's own tokens kept in localStorage end up in a generic export (cookies never do). Mitigation: the export dialog
  lists origins and counts, snapshots stay local unless the user moves them, adapters narrow the scope. `Assumed`
- A game in fullscreen can draw a fake launcher dialog; launcher confirmations are native dialogs, which a page cannot
  draw over. `Assumed`
- All games share Chromium's GPU and network service processes; side channels between games are not addressed.
  `Assumed`
- A heavy or hostile game can exhaust CPU, GPU or memory; the user closes it ("Force close"). `Assumed`

## Open questions

- If removing the macOS usage descriptions makes the system terminate a process that touches the camera or microphone,
  the fallback is to keep the descriptions and rely on the handlers, accepting a possible OS prompt; the owner decides
  after the packaged test. `Assumed`
- Should `persistent-storage` be allowed? It protects a game's data from eviction under disk pressure and exposes
  nothing, but the owner's allowlist has only three permissions. Default: denied. Whether Electron evicts best-effort
  storage at all is Unverified.
- Should `clipboard-sanitized-write` (copy buttons for save codes) or `screen-wake-lock` (gamepad play) be allowed?
  Default: denied, as decided by the owner's allowlist. `Assumed`
- OAuth and other login popups and cross-site redirects are blocked by the navigation rules; games that need them stay
  "Compatibility not verified". `Assumed`
