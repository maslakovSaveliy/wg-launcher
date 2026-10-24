# ADR-0003: Native languages: Rust deferred, Go not adopted

**Status:** Accepted

**Date:** 2026-10-24

**Deciders:** owner (maslakovSaveliy); drafted by AI agent

Conventions: [ADR-0000](0000-template.md#conventions).

## Context

- The MVP moves save data, not game assets: snapshot limits are sized for saves (1 GiB compressed file, 512 MiB per
  entry, [snapshot-format.md](../specs/snapshot-format.md) section 8, `Assumed`), and Unity stores at most 1 MB of
  PlayerPrefs. Verified (2026-10-24, [runtime-and-storage.md](../research/runtime-and-storage.md) section 5.4)
- Everything the MVP codec needs exists without native code: zstd works in the Electron 45 main process and in a
  `utilityProcess` (Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H10)), SHA-256 is in
  `node:crypto` and Web Crypto (`crypto.subtle.digest`). Verified (2026-10-25, Node 24.13.0, run locally:
  `node -e` calling `createHash("sha256")` and checking `typeof crypto.subtle.digest`)
- Electron 45 builds only for x64 and arm64. Verified (2026-10-24, runtime-and-storage.md section 2.2). A native binary
  must therefore be built and signed for darwin-arm64, darwin-x64, win32-x64 and win32-arm64 at least. Assumed
- Rust does not make a web game render faster: rendering, shaders and game logic stay in the browser engine. Assumed
  (runtime-and-storage.md section 6)
- Rust 1.98.1 and Go 1.27.1 are installed on the dev machine. Verified (2026-10-24, runtime-and-storage.md section 6)

## Decision

- **Rust is deferred** to the local-packages stage. The MVP snapshot codec is TypeScript (`packages/snapshot`), with a
  language-neutral spec and golden vectors that a later Rust codec must pass unchanged. No crate exists before then.
  `Owner` ([MEMORY.md](../../MEMORY.md) Decisions)
- **Triggers to introduce Rust**, any one of: local packages (multi-GB download with resume, verify, unpack); a measured
  CPU cost of hashing or compression in the snapshot worker that users notice (a recorded measurement, as for AC-22); a
  Tauri or mobile client that needs the same codec. `Owner` for the packages stage, `Assumed` for the other two.
- **First Rust operation:** verify a package or snapshot, and unpack a package (snapshots are never extracted to disk,
  snapshot-format.md section 3.1). `Assumed`
- **Go is not adopted.** It would fill the same sidecar niche as Rust, a second native toolchain is not justified, and
  Rust is better placed for reuse through napi-rs, Tauri and mobile. `Owner`

### Contract of the first Rust process

A sidecar binary spawned by the Electron main process without a shell, one per app run, speaking JSON lines (UTF-8, one
object per `\n`-terminated line) on stdin and stdout. `Assumed` for every detail below.

```text
request   {"id":"<request_id>","method":"verify","params":{"path":"<allowed path>","limits":{...}}}
progress  {"id":"<request_id>","progress":{"step":"hash","bytesDone":1048576,"bytesTotal":4194304}}
result    {"id":"<request_id>","result":{"contentHash":"<64 hex>"}}
error     {"id":"<request_id>","error":{"code":"SNAP_PATH_TRAVERSAL","message":"<short English text>"}}
cancel    {"id":"<new id>","method":"cancel","params":{"target":"<request_id>"}}
```

- `id` is a UUIDv7 chosen by the main process, unique per process run. Every request ends with exactly one `result` or
  `error`; zero or more `progress` events come before it, with measured bytes only (`bytesTotal` is `null` when
  unknown).
- Methods: `verify`, `unpack` (packages only) and `cancel`; a cancelled request ends with `RPC_CANCELLED`. Error codes
  are the `SNAP_*` codes of snapshot-format.md plus `RPC_BAD_REQUEST`, `RPC_UNKNOWN_METHOD`, `RPC_CANCELLED`,
  `RPC_TIMEOUT` and `RPC_LIMIT`.
- Timeouts: the main process keeps a deadline per request (60 s plus 1 s per MiB, as the snapshot jobs of
  [save-transfer.md](../specs/save-transfer.md) section 5), sends `cancel` when it passes, and kills the process 5 s
  later if the request has not ended.
- Limits: a line is at most 64 KiB in either direction (the launcher IPC limit), at most 4 requests run at once, and the
  `limits` object of snapshot-format.md section 8 applies. A longer line or malformed JSON ends the process; the main
  process restarts it once per request and then fails the job.
- Large data never travels in JSON: only paths inside directories the main process allows (`tmp/`, `snapshots/`,
  `backups/` and later the packages directory). The sidecar resolves each path, refuses symlinks and anything outside.
- Logs go to stderr under the redaction rules of [security.md](../specs/security.md) section 9; stdout carries protocol
  lines only.
- The Electron main process stays the only writer of the local database; the sidecar never opens it (AGENTS.md
  data-safety invariant 9).
- Code shape: one library crate with the operations and a thin binary for the protocol, in `crates/`. Bindings for
  napi-rs or Tauri are added only when a trigger needs them; no abstraction for hosts that do not exist.
- Conformance: the crate passes the same golden vectors as the TypeScript codec, both directions
  (snapshot-format.md section 10). Build matrix: darwin-arm64, darwin-x64, win32-x64, win32-arm64, signed with the app
  (macOS signing and notarization, Windows Authenticode); Linux targets join when Linux does.

## Options considered

### Option A: TypeScript only in the MVP, Rust later (chosen)

| Dimension | Assessment |
| --- | --- |
| Complexity | Low: one language, Web APIs and Node built-ins. Assumed |
| Cost and size | No native build or signing matrix. Assumed |
| Compatibility | zstd, SHA-256 and `node:sqlite` work in the target processes. Verified (2026-10-24, RESULTS.md H10) |
| Security | Our own small parsers in a memory-safe language with golden vectors ([security.md](../specs/security.md) section 10). Assumed |
| Team familiarity | TypeScript is the project's language. Assumed |
| Reversibility | High: the spec and vectors make a later port mechanical. Assumed |
| Pros | Nothing to build before it is needed (AGENTS.md, no empty artifacts). Assumed |
| Cons | Multi-GB packages would need a rewrite of that path later. Assumed |

### Option B: Rust now (napi-rs addon or sidecar)

| Dimension | Assessment |
| --- | --- |
| Complexity | High: Rust toolchain, napi-rs (`@napi-rs/cli` 3.10.9) or the protocol above, cross-builds. Verified for the version (2026-10-24, runtime-and-storage.md section 7); the rest is Assumed |
| Cost and size | Four signed native targets from day one. Assumed |
| Compatibility | A napi addon is tied to the Electron ABI; a sidecar is not. Assumed |
| Security | Memory-safe, but a second toolchain and crate supply chain (cargo-deny 0.20.2 exists). Verified for the version (2026-10-24, runtime-and-storage.md section 7) |
| Team familiarity | Lower than TypeScript. Assumed |
| Reversibility | Medium. Assumed |
| Pros | Ready for packages and Tauri. Assumed |
| Cons | Pays now for a need that comes later. Assumed |

### Option C: Go sidecar (reusing butler)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: butler (Go, MIT) already does downloads and patching for itch. Verified (2026-10-24, [foundations.md](../research/foundations.md) section 2.3) |
| Cost and size | A Go binary per target, plus Go dependencies to vet (`klauspost/compress` license terms Unverified). Unverified |
| Compatibility | Sidecar only; no in-process or Tauri reuse. Assumed |
| Security | Memory-safe, separate process. Assumed |
| Team familiarity | Lower than TypeScript. Assumed |
| Reversibility | Medium. Assumed |
| Pros | Proven patching code (wharf) to study. Assumed |
| Cons | Same niche as Rust with fewer reuse paths. `Owner` |

## Trade-off analysis

Nothing in the MVP is CPU-bound or multi-gigabyte, so a native language would add a build and signing matrix with no
measured benefit. Rust is kept as the one native option because its reuse paths (napi-rs, Tauri, mobile) match the
later stages. Assumed

## Consequences

- **Easier:** one toolchain, one test runner, no native signing in the MVP. Assumed
- **Harder:** the packages stage starts with a port of the verify path; the spec and vectors must stay exact enough for
  it. Assumed

### Revisit triggers

- Rust: one of the three triggers above. Go: reusing butler and wharf for delta patching at the packages stage, or a
  measured backend performance need (the backend starts as NestJS). `Owner`

## Evidence

- [runtime-and-storage.md](../research/runtime-and-storage.md) sections 5.7, 6 and 7;
  [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H10; [snapshot-format.md](../specs/snapshot-format.md) sections 8
  and 10; [architecture.md](../specs/architecture.md) section 16.

## Facts versus assumptions

- **Facts** (tagged where they appear above): zstd and SHA-256 are available in the target processes; Electron builds
  x64 and arm64 only; butler is MIT Go; the tool versions listed.
- **Assumptions** (Assumed): save data stays small; a native matrix is costly for one owner; Rust does not speed up
  rendering; every value of the contract above.

## Action items

- [ ] When a trigger fires, write the crate plan against this contract and run the golden vectors first (agent).
