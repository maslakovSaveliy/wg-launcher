# Snapshot format: `.wgsnap`, formatVersion 1

Status: draft for Phase 1, 2026-10-25. Normative for `packages/snapshot` (the TypeScript codec of the MVP) and for any
later implementation, such as the Rust one foreseen by ADR-0003 (native languages). How snapshots are produced and
restored is in [save-transfer.md](save-transfer.md); threats are in [security.md](security.md); requirements come from
[PRD section 10](../product/prd.md#10-saves-and-snapshots) and the data-safety rules in
[AGENTS.md](../../AGENTS.md#data-safety-invariants).

## Conventions

- MUST, SHOULD and MAY are used as in RFC 2119 and RFC 8174.
- Facts carry the claim tags of [AGENTS.md](../../AGENTS.md#documentation-rules): `Verified (date, source)`, `Assumed`
  or `Unverified`. A tag at the end of a bullet or table row covers that bullet or row.
- Requirements (MUST, SHOULD, procedures, schemas, tables of rules) are design decisions, not facts. `Owner` marks one
  the owner decided (the marker of the [PRD](../product/prd.md#how-to-read-this-document), with its source). Every other
  requirement is a call made in this set of specs: `Assumed` (reasoned, not checked), whether or not the bullet repeats
  the tag, and the owner can override it. The important ones are repeated in "Open questions".
- **Code-unit order** compares two strings by their UTF-16 code units, like JavaScript's `<`. Every sort of names in
  this spec uses it. Implementations in UTF-8 languages MUST convert, because UTF-8 byte order differs for characters
  above U+FFFF.
- Hex is lowercase. Sizes are bytes. 1 MiB = 2^20 bytes.

## 1. Goals

- **Engine-independent.** Nothing depends on Chromium internals, so a later WebKit or WebView client can read and write
  snapshots ([PRD section 11](../product/prd.md#11-platforms)). Storage keys are stored as origin plus top-level site,
  not as Chromium's key string. `Assumed`
- **Deterministic.** The same storage content gives byte-identical entries and the same `contentHash` in every
  conforming implementation. The restore protocol depends on it (re-export and compare). `Assumed`
- **Hostile input is expected.** A snapshot file is untrusted (AGENTS.md data-safety invariant 6, AC-9). `Owner`
- **Out of scope for v1:** cookies, HTTP cache, Cache Storage, service workers, shader cache, OPFS and other file
  systems, encryption and signatures. `Owner` for the exclusions (PRD section 10), `Assumed` for no encryption.

## 2. Container

- A `.wgsnap` file is exactly one zstd frame whose content is a POSIX ustar archive. `Assumed`
- zstd is available as `zlib.zstdCompress` and `zlib.createZstdDecompress` with the parameters `ZSTD_c_checksumFlag`
  and `ZSTD_d_windowLogMax`. Verified (2026-10-25, Node 24.13.0, `node -e` printing `zlib.constants`). It works in the
  Electron 45 main process and in a `utilityProcess`. Verified (2026-10-24,
  [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H10).
- Writers MUST set the content checksum flag and MUST NOT need a window larger than 2^27 bytes. Readers MUST reject a
  frame without the checksum flag (bit 2 of the frame header descriptor) or with a dictionary id, skippable frames, a
  second frame and any other byte after the frame, and MUST decode with `windowLogMax` 27 (codes in section 8). `Assumed`
- Truncation is detected by the reader's own frame walker, not by the decompressor, because zstd versions differ on a
  cut frame: Node 24.13.0 decompresses a cut checksummed frame without any error, Node 24.22.1 fails it with
  `Z_BUF_ERROR` "unexpected end of file". Verified (2026-10-25 and 2026-10-28, Node 24.13.0 and 24.22.1, the `node -e`
  commands in [MEMORY.md](../../MEMORY.md) "Node, zstd and the snapshot codec").
  The walker follows RFC 8878 sections 3.1.1, 3.1.1.1 and 3.1.1.2: the magic `28 b5 2f fd` (a skippable-frame magic
  `0x184D2A50` to `0x184D2A5F` first is `SNAP_ZSTD_INVALID`), then the frame header descriptor checked in this order:
  reserved bit 3 set, a dictionary id flag, no checksum flag (`SNAP_ZSTD_NO_CHECKSUM`); then a window above 2^27 (for a
  single-segment frame the window is the content size); then every block header (the reserved block type and a block
  size above 128 KiB are `SNAP_ZSTD_INVALID`; an RLE block carries one byte) and the 4-byte checksum. Input that ends
  before the last block and the checksum is `SNAP_TRUNCATED`. The decompressor still checks block contents and the
  checksum value. `Assumed` (Phase 1 plan, M6)
- Every verdict is tied to a byte position, so the code does not depend on chunking or read-ahead, except for the
  corrupt-block case below. A container defect
  found on the compressed bytes (a walker code above, or a source longer or shorter than its declared size, section 8)
  stops reading at the bad byte; the bytes before it are still decompressed and checked, and the container code is
  reported only if they pass. So a cut file is `SNAP_TRUNCATED` unless the data before the cut is itself invalid. The
  reader ends the decompressor only after a frame the walker completed; a frame the walker stopped is flushed instead,
  so no version-specific end-of-input error stops it and everything the library decodes from the bytes before the
  verdict is checked. The uncompressed limits (`SNAP_RATIO_EXCEEDED`, `SNAP_TOTAL_TOO_LARGE`) fail at the exact tar
  byte that crosses them, after the bytes before it were checked. `Assumed` (Ruling R23, 2026-10-28)
- Decompressor errors (Ruling R23, 2026-10-28, which replaces R12 "a decompressor error is always
  `SNAP_ZSTD_INVALID`"): the code MUST be the same on every zstd library and version. On a decompressor error the reader
  stops decompressing but keeps feeding the remaining compressed bytes, up to `compressedSize`, to the frame walker
  alone. If the walker has a verdict anywhere in the input (truncated, no checksum, a dictionary id, the window, the
  reserved bit or block type, a skippable or second frame, trailing data, a source longer or shorter than declared),
  that verdict is reported, under the deferral rule above: a defect the tar, manifest or record checks already found in
  the bytes decompressed before the error still comes first. Only when the walker saw a complete, structurally valid
  frame is the result `SNAP_ZSTD_INVALID` (corrupt block content or a checksum mismatch). `Assumed`
- Corrupt-block carve-out (Ruling R24, 2026-10-28): for a file whose zstd block content is corrupt, the code may
  depend on the zstd library and on chunking. How much a corrupt block emits before the error is library-defined, and
  the output the library decoded in the same call that fails is discarded, so a defect in roughly the last input chunk
  decoded before the corrupt block may be reported as its own code or as the decompressor or walker verdict above. The
  file is always rejected. Such files are kept out of the golden vectors (section 10). `Assumed`
- Tar: ustar headers (magic `ustar\0`, version `00`), sizes in octal only. Writers emit only regular files with mode
  0644, uid and gid 0, empty user and group names, mtime 0, the whole path in the `name` field and an empty `prefix`,
  then two zero blocks. Readers join `prefix` and `name` with `/` when `prefix` is set, accept zero padding after the
  end blocks and reject anything else after them. `Assumed`
- Header details for readers: a text field ends at its first NUL; a numeric field (size, checksum) is one or more octal
  digits followed only by NUL or space bytes up to the end of the field (no leading space, no base-256); the checksum
  is the unsigned sum of the 512 header bytes with the checksum field counted as spaces. Padding after entry data is
  not checked. A zero block followed by a block that is not zero is `SNAP_TAR_INVALID`. `Assumed`
- The codec has its own minimal ustar reader and writer instead of a tar dependency, because the accepted subset is
  small and every rejection must map to its own error code. `Assumed`
- Writers write `manifest.json` first, then the other entries in `entries` order. Readers MUST require `manifest.json`
  to be the first regular file, so that the manifest is validated before any data is read. `Assumed`

## 3. Entries

### 3.1 Generic entry rules

Every tar header passes these checks, in this order, before its data is read. Each failure has its own code (AC-9).

| Order | Rule | Code |
| --- | --- | --- |
| 1 | Header checksum valid, magic `ustar`, octal size field | `SNAP_TAR_INVALID` |
| 2 | Typeflag `2` (symbolic link) is rejected | `SNAP_SYMLINK` |
| 3 | Typeflag `1` (hard link) is rejected | `SNAP_HARDLINK` |
| 4 | Typeflags `3`, `4`, `6` (character device, block device, FIFO) are rejected | `SNAP_DEVICE` |
| 5 | Only typeflag `0` (or NUL) and `5` (directory) are accepted; `x`, `g`, `L`, `K`, `S`, `7` and anything else are rejected | `SNAP_UNSUPPORTED_ENTRY_TYPE` |
| 6 | The path decodes as UTF-8 | `SNAP_BAD_PATH_ENCODING` |
| 7 | No leading `/` or `\`, no drive letter (`C:`) | `SNAP_ABSOLUTE_PATH` |
| 8 | No `..` segment | `SNAP_PATH_TRAVERSAL` |
| 9 | No backslash, NUL, control character (below U+0020, U+007F), empty segment, `.` segment, trailing `/` on a file; at most 255 bytes | `SNAP_BAD_PATH` |
| 10 | The path is in Unicode NFC | `SNAP_NON_NFC_PATH` |
| 11 | At most `maxEntries` entries (files and directories) | `SNAP_TOO_MANY_ENTRIES` |
| 12 | Size at most `maxEntryBytes` (checked on the header, before reading) | `SNAP_ENTRY_TOO_LARGE` |
| 13 | No path seen twice, no file and directory with the same path | `SNAP_DUPLICATE_PATH` |
| 14 | The first regular file is `manifest.json` | `SNAP_MISSING_MANIFEST` |

Readers never create files from entry paths; they stream entries into the validator. The rules hold anyway, so that a
later tool that does extract cannot be tricked. `Assumed`

- Rule 8 splits the path on `/` only (a backslash is rule 9). A directory path may end in one `/`, which is removed
  before rules 9 and 13; the 255-byte limit counts the joined path as stored. Rules 2 to 6 fail before the path is
  known, so their errors carry no path. `Assumed`

### 3.2 Path grammar of formatVersion 1

Regular files MUST have one of these paths; anything else is `SNAP_UNEXPECTED_ENTRY`. Directory entries are allowed
only for prefixes of these paths (`data`, `data/<k>`, `data/<k>/idb`, `data/<k>/idb/<d>`, `blobs`) and carry no data;
a directory with a non-zero size is `SNAP_UNEXPECTED_ENTRY`. After `manifest.json`, readers accept the entries in any
order. `Assumed`

```text
manifest.json
data/<k>/local-storage.cbor        localStorage of storage key k (absent when empty)
data/<k>/idb/<d>/schema.cbor       IndexedDB database d of storage key k
data/<k>/idb/<d>/store-<s>.cbor    records of object store s of that database
blobs/<sha256>                     bytes of a Blob or File, named by their SHA-256
```

`<k>`, `<d>` and `<s>` are decimal indexes without leading zeros: `k` into `manifest.storageKeys`, `d` into the
databases of that key sorted by name, `s` into the stores of that database sorted by name (code-unit order). Database
and store names never appear in paths, because the page chooses them freely. `Assumed`

## 4. Manifest

`manifest.json` is UTF-8 without a byte-order mark and MUST be the RFC 8785 (JCS) canonical serialization of the
manifest object. Readers parse it, re-serialize it with JCS and compare the bytes; a difference (including duplicate
keys or whitespace) is `SNAP_MANIFEST_INVALID`. A manifest above `maxManifestBytes` is `SNAP_MANIFEST_TOO_LARGE`,
checked on its tar header. `Assumed`

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | `"wgsnap"` | Anything else: `SNAP_UNKNOWN_FORMAT` |
| `formatVersion` | integer | `1`; anything else: `SNAP_UNSUPPORTED_VERSION` |
| `gameId` | UUIDv7 | The library entry the data was exported from |
| `revisionId` | UUIDv7 | This snapshot; unique, never reused. Importing a file whose `revisionId` is already stored reuses the stored file if `contentHash` matches and is refused with `IMP_REVISION_CONFLICT` otherwise |
| `parentRevisionId` | UUIDv7 or `null` | The revision this state descends from: the game's last export or restore (`base_revision_id`, [architecture.md](architecture.md#15-future-cloud-sync)), `null` for a first export or after "Delete local saves" |
| `createdAt` | string | UTC, `YYYY-MM-DDTHH:mm:ss.sssZ`; display only, never used for ordering |
| `deviceId` | UUIDv7 | Random id of the exporting installation (no hardware data) |
| `exporter` | `{id, version}` | `id` matches `^[a-z0-9-]{1,64}$`, `version` is SemVer 2.0 |
| `adapter` | `{id, version}` or `null` | The declarative adapter used ([save-transfer.md](save-transfer.md#8-declarative-adapters)) |
| `gameVersion` | string (at most 128) or `null` | Only when an adapter knows it |
| `flushState` | `"confirmed"` or `"unconfirmed"` | Rule in [save-transfer.md](save-transfer.md#7-flush-state) (AC-12) |
| `storageKeys` | array of `{origin, topLevelSite, role}` | 0 to `maxStorageKeys` items, sorted by `origin` then `topLevelSite` (`null` first), no two with the same `origin` and `topLevelSite` |
| `entries` | array of `{path, size, sha256}` | Every regular file except `manifest.json`, sorted by `path`, no duplicates |
| `contentHash` | 64 hex | Section 5 |
| `notExported` | optional array of `{key, kind}` | Informational: storage kinds found under `storageKeys[key]` but not exported; `kind` is `fileSystem`, `cacheStorage` or `serviceWorkers` |

- `origin` is the WHATWG origin serialization (`scheme://host[:port]`, no trailing slash, punycode host).
  `topLevelSite` is `null` for first-party storage and `scheme://registrable-domain` for storage of a partitioned
  third-party iframe; the pair is the full storage key (PRD section 10, AC-24). `role` is `top` when the origin was a
  top-level document of the game and `frame` otherwise; the restore uses it to detect a changed game origin
  ([save-transfer.md](save-transfer.md#2-storage-keys)). `Owner` for recording the full key, `Assumed` for the encoding
  and the role.
- Unknown top-level fields are ignored. They are not covered by `contentHash` and can never change what is restored.
  An unknown value in a known enum field (for example `flushState`) is `SNAP_MANIFEST_INVALID`. `Assumed`
- Check order: size, JSON parse (`SNAP_MANIFEST_INVALID`), `format`, `formatVersion`, JCS canonical form, schema (zod
  in TypeScript), `contentHash`. So a future version yields `SNAP_UNSUPPORTED_VERSION` even if its manifest is not
  canonical by v1 rules or has other fields. A JSON value that is not an object, or has no `format` member, is
  `SNAP_UNKNOWN_FORMAT`. `Assumed`
- Every number in `manifest.json`, unknown fields included, MUST be an integer of magnitude below 2^53 written in plain
  decimal, and every string MUST be well-formed (no lone surrogate); anything else has no canonical form here and is
  `SNAP_MANIFEST_INVALID`. So no implementation needs the float formatting of RFC 8785 section 3.2.2.3. `Assumed`
- Schema details: `gameVersion` has at most 128 UTF-16 code units; `exporter.version` and `adapter.version` at most
  256 characters; `adapter.id` follows the `exporter.id` pattern; `origin` is an `http` or `https` origin that the
  WHATWG URL parser serializes back to itself, and `topLevelSite` the same without a port; more than `maxStorageKeys`
  items is `SNAP_MANIFEST_INVALID`; `entries` never lists `manifest.json`; `notExported[].key` is an index into
  `storageKeys`. `Assumed`

## 5. Content hash

`contentHash` is the lowercase hex SHA-256 of the UTF-8 bytes of the JCS serialization of this object, built from the
manifest:

```json
{"entries":[{"path":"…","sha256":"…","size":0}],"format":"wgsnap","formatVersion":1,"storageKeys":[{"origin":"…","role":"top","topLevelSite":null}]}
```

- `entries` and `storageKeys` are copied in manifest order with exactly these members. Because every entry hash is
  included, `contentHash` covers every data byte transitively. Readers recompute it right after the manifest checks
  (`SNAP_CONTENT_HASH_MISMATCH`) and then verify each entry's size and SHA-256 while streaming (`SNAP_SIZE_MISMATCH`,
  `SNAP_ENTRY_HASH_MISMATCH`); a listed entry that never appears is `SNAP_MISSING_ENTRY`, a file that is not listed is
  `SNAP_UNEXPECTED_ENTRY`. `Assumed`
- Deliberately not covered: `gameId`, `revisionId`, `parentRevisionId`, `createdAt`, `deviceId`, `exporter`, `adapter`,
  `gameVersion`, `flushState`, `notExported`. So the same data exported twice, on two devices or into another library
  entry has the same `contentHash`, which is what the restore check and later deduplication compare. Accidental
  corruption of the uncovered fields is caught by the zstd checksum; deliberate tampering is not a threat this hash
  addresses (no signatures in v1, see [security.md](security.md)). `Assumed`
- All members are ASCII strings, integers below 2^53 and `null`, so JCS reduces to sorted keys, no whitespace and
  standard string escaping in TypeScript and Rust alike. `Assumed`
- Storage-key mapping (AC-24): the expected hash after a confirmed mapping is the `contentHash` of the snapshot with
  each mapped key replaced, `storageKeys` re-sorted and the `data/<k>/` prefixes renumbered to the new order; sizes and
  entry hashes do not change, because data files never contain storage keys. `Assumed`

## 6. Record encoding

### 6.1 Decision: deterministic CBOR

| Requirement | Deterministic CBOR (RFC 8949 §4.2) | Tagged JSON lines |
| --- | --- | --- |
| ArrayBuffer, typed arrays, binary keys | Native byte strings; typed-array tags of RFC 8746 | base64 text (a third larger) or separate files |
| `-0`, `NaN`, `±Infinity` | Native IEEE 754 values | Need tags |
| Bit-exact floats in TypeScript and Rust | Shortest of binary16, 32, 64 that keeps the value: mechanical | Shortest decimal formatting of ECMAScript (RFC 8785) must be reimplemented exactly |
| `undefined` versus a missing property | Simple value 23 versus absent | Needs a tag |
| BigInt, Date (including invalid), Map, Set, Blob | Tags | Tags |
| Order of properties and Map entries | Must be kept: encoded as tagged pair lists, because canonical map sorting would reorder them | Same: JCS sorts keys |
| Strings with lone surrogates | Tag over UTF-16 bytes | JSON escapes, but many JSON libraries reject them |
| Readability | Needs a diagnostic dump | Plain text |
| Streaming | CBOR sequence (RFC 8742) | One record per line |

**Decision:** deterministic CBOR with the profile below. The riskiest parts for cross-language determinism are binary
data (Emscripten IDBFS file contents are `Uint8Array`, Verified (2026-10-24,
[runtime-and-storage.md](../research/runtime-and-storage.md) section 5.3)) and exact floats; CBOR takes base64 and
decimal float formatting out of the hashed bytes. Readability comes from a dump tool, not from the format. The spike's
tagged JSON passed H14 but was a throwaway format. `Assumed`

The codec is pure TypeScript using only Web APIs (`Uint8Array`, `DataView`, `TextEncoder`), so the same code runs in the
quiescent preload and in the snapshot worker ([architecture.md](architecture.md#2-module-map)). `Assumed`

### 6.2 CBOR profile

1. Definite lengths only; every head (integer, length, tag number) in its shortest form.
2. Integers (major types 0 and 1) only for JavaScript numbers that are safe integers and not `-0`, and for envelope
   counts; magnitude at most 2^53 − 1.
3. Every other number is a float: the shortest of binary16, binary32 and binary64 that represents it exactly; `NaN`
   only as `f9 7e00`. A float holding a safe integer other than `-0` is invalid.
4. Text strings are valid UTF-8 of a well-formed string, never normalized.
5. Maps (major type 5) appear only in envelopes (section 7.2), with text keys, sorted by the bytewise order of their
   encodings, no duplicates. They never encode values.
6. Simple values: only `false`, `true`, `null`, `undefined` (`f4` to `f7`).
7. Tags: only those in section 6.3, with the content shapes given there.
8. Decoders MUST reject anything that breaks 1 to 7 (`SNAP_RECORD_INVALID`), so the encoding of a value is unique.
   Nesting depth is at most `maxDepth`: a top-level item of a sequence is at depth 0, the elements of an array and the
   keys and values of a map are one level deeper than it, and the content of a tag is at the tag's own depth. A tag
   whose content is a tag is rejected (no tag of section 6.3 has a tag as its content), so tags cannot nest without
   bound. Inside a `[key, value]` record (sections 7.1 and 7.3) the key and the value are at depth 1, and the exporter
   refuses a value that would produce a deeper item than `maxDepth` with `EXP_TOO_DEEP`, so an exported value always
   decodes. `Assumed`

### 6.3 Value model

The exporter reads values with the real IndexedDB and storage APIs from an isolated world, so they are structured-clone
results. Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H14: Date, ArrayBuffer, typed arrays
and Blob came back through that path).

| JavaScript value | Encoding |
| --- | --- |
| `undefined`, `null`, `true`, `false` | Simple values |
| number | Rule 2 or 3 of section 6.2 |
| string (well-formed) | Text string |
| string with a lone surrogate | Tag 33102, byte string of UTF-16LE code units |
| BigInt | Tag 33105, text: decimal, `-` for negatives, no leading zeros |
| Array whose own enumerable properties are exactly the indexes 0 to length − 1 | Array of encoded items |
| Any other Array (holes or extra own properties) | Tag 33103, array `[length, key1, value1, …]`: `length` an integer, then every own enumerable string-keyed property except `length` in enumeration order (indexes ascending first), keys in the string encoding (text, or tag 33102 for a key with a lone surrogate), indexes in canonical decimal (`"3"`); a hole is an absent key |
| Plain object | Tag 33101, array `[key1, value1, key2, value2, …]` in enumeration order, keys in the string encoding |
| Date | Tag 33104, number: time value in ms (`NaN` for an invalid Date) |
| Map | Tag 33106, array `[key1, value1, …]` in insertion order |
| Set | Tag 33107, array of items in insertion order |
| Boolean, Number, String or BigInt object | Tag 33108, array `[primitive]` |
| RegExp | Tag 21066, array `[source, flags]` (flags always present) |
| ArrayBuffer (not resizable) | Byte string |
| Typed array covering its whole buffer | RFC 8746 little-endian tag: Uint8 64, Uint8Clamped 68, Int8 72, Uint16 69, Int16 77, Uint32 70, Int32 78, BigUint64 71, BigInt64 79, Float16 84, Float32 85, Float64 86; byte string |
| DataView covering its whole buffer | Tag 33109, byte string |
| View over part of a larger buffer | Tag 33110, array `[viewTag, bufferBytes, byteOffset, length]`; `viewTag` is the tag above (33109 for DataView), `length` in elements (bytes for DataView) |
| Blob | Tag 33111, array `[type, size, sha256]`; bytes in `blobs/<sha256>` |
| File | Tag 33112, array `[name, lastModified, type, size, sha256]`; bytes in `blobs/<sha256>` |

- Tags 64 to 87 and 21066 are registered with the meanings used here; tags 33101 to 33112 lie in the IANA "First Come
  First Served" range, listed as Unassigned. Verified (2026-10-25,
  <https://www.iana.org/assignments/cbor-tags/cbor-tags.xhtml>). They are not registered (Open questions). Inside a
  `.wgsnap` their meaning is fixed by `formatVersion`. `Assumed`
- Decoders also reject the shapes a JavaScript value cannot have, so that decoding and re-encoding gives the same bytes
  (rule 8): tag 33102 over a well-formed string or an odd number of bytes; a BigInt text other than `0` or
  `-?[1-9][0-9]*`; a Date content other than `NaN` or an integer of magnitude at most 8.64e15; object or sparse-array
  keys that are duplicated or out of enumeration order (array indexes, canonical decimal up to 2^32 − 2, ascending
  before every other key); a sparse array whose keys are exactly the indexes 0 to length − 1 (that is a plain array), a
  key `length`, an index not below `length` or a `length` above 2^32 − 1; a Map key or Set item equal to an earlier
  one under SameValueZero among primitives, or `-0` (Map and Set store `+0`); a boxed content other than a boolean,
  number, string or BigInt; a RegExp content other than exactly `[source, flags]` with the source in the string
  encoding and the flags a text string that is a strictly ordered subset of `dgimsuvy` without both `u` and `v`;
  typed-array bytes that are not a whole number of elements; a partial view whose offset is not a multiple of the
  element size, that leaves its buffer or that covers all of it; a Blob or File type outside lowercase printable ASCII
  (U+0020 to U+007E without `A` to `Z`, as the File API normalizes it), a `lastModified` that is not an integer, a hash
  that is not 64 lowercase hex digits, and one hash referenced with two sizes. `Assumed`
- The RegExp source is stored as the exporting engine's `RegExp.prototype.source` and is not canonicalized by readers;
  a source that does not compile in the reader's engine is an import error, raised as `SNAP_RECORD_INVALID` while the
  file is validated, before anything is written (section 7.3). `Assumed`
- A File whose `lastModified` is not a safe integer, or is `-0`, is `EXP_UNSUPPORTED_VALUE` (the detail names
  `lastModified`), because the field is written as an integer; it is never normalized. `Assumed`
- A typed array or DataView and its `ArrayBuffer`, or two views of one buffer, are the same object reached twice:
  `EXP_SHARED_REFERENCE`, because a decoder would rebuild separate buffers. `Assumed`
- Typed-array bytes are copied as they are in memory. Electron 45 builds only for x64 and arm64, both little-endian.
  Verified (2026-10-24, <https://releases.electronjs.org/release/v45.0.0>) for the architectures; that both run
  little-endian is Assumed (general knowledge). A big-endian implementation would have to swap.
- Any other value is an explicit export error, never dropped (AGENTS.md data-safety invariant 5, AC-10):
  `EXP_UNSUPPORTED_VALUE` (resizable ArrayBuffer, Error, ImageData, ImageBitmap, CryptoKey, File System handles and any
  other type), `EXP_SHARED_REFERENCE` (an object reached twice in one value, which also covers cycles: structured
  clone keeps shared references, this format does not) and `EXP_TOO_DEEP`. The error detail names the storage key,
  database, store, record key and the property path from the record root, plus the type from
  `Object.prototype.toString`. `Assumed`

## 7. Data files

### 7.1 `local-storage.cbor`

A CBOR sequence of 2-element arrays `[key, value]`, both strings (text or tag 33102), strictly ascending by key in
code-unit order. localStorage has no meaningful order, so sorting loses nothing. An empty localStorage has no file, so
an empty `local-storage.cbor` is `SNAP_RECORD_INVALID`. `Assumed`

### 7.2 `schema.cbor`: IndexedDB schema capture

One envelope map:

| Member | Value |
| --- | --- |
| `name` | Database name (string encoding) |
| `version` | Integer, at least 1 |
| `stores` | Array of store maps, sorted by name |

Store map members: `name`; `keyPath` (`null`, a string or an array of strings, as IndexedDB reports it);
`autoIncrement` (boolean); `keyGenerator` (`null` unless `autoIncrement`, otherwise the generator's current number,
section 7.5); `indexes` (array sorted by name of maps with `name`, `keyPath`, `unique`, `multiEntry`); `records` (the
record count). This captures what PRD section 10 requires (database version, key paths, auto-increment, indexes).
`Owner` for the scope, `Assumed` for the layout.

Every map has exactly these members. Names and key-path strings use the string encoding; an array key path is not
empty, and an index with an array key path is not `multiEntry` (IndexedDB refuses both). Store and index names are
strictly ascending in code-unit order. `keyGenerator` is an integer from 1 to 2^53 encoded as a number, so 2^53 (not a
safe integer) is the float `fa 5a000000`. `Assumed`

### 7.3 `store-<s>.cbor`: records

- A CBOR sequence of 2-element arrays `[primaryKey, value]`, strictly ascending in IndexedDB key order, exactly
  `records` items. Keys use the value encoding restricted to valid IndexedDB keys: a number other than `NaN`, a valid
  Date, a string, a byte string or an array of keys. `Assumed`; that binary keys read back as ArrayBuffer is Assumed
  too (not checked).
- IndexedDB key order: number < Date < string < binary < array; numbers and Dates by value, strings in code-unit
  order, binary bytewise unsigned, arrays element by element and then by length. Verified (2026-10-25,
  <https://www.w3.org/TR/IndexedDB/>, "compare two keys").
- Every store of a `schema.cbor` has its `store-<s>.cbor` (zero bytes for a store without records), and every store
  file belongs to a store of its database's schema; the databases of a key are numbered 0 to n − 1 with names strictly
  ascending in code-unit order. Anything else is `SNAP_RECORD_INVALID`. Readers check these, the record counts and the
  blob references of section 7.4 after the last entry, in `entries` order, so the result does not depend on the order
  of the entries in the archive. `Assumed`
- Every RegExp source in a record must compile in the reader's engine during validation (section 6.3), otherwise
  `SNAP_RECORD_INVALID`, so that the import cannot fail on it after the wipe. `Assumed`
- The key is stored even for stores with an inline key path. The importer checks that the key IndexedDB derives from
  the value equals it (`IMP_KEY_MISMATCH`, [save-transfer.md](save-transfer.md#6-restore-protocol)). `Assumed`

### 7.4 Blobs

`blobs/<sha256>` holds the raw bytes once, however often they are referenced. Every blob entry MUST be referenced
and every reference MUST name an existing blob entry with the referenced size, and a blob's name MUST be the SHA-256 of
its bytes, otherwise `SNAP_RECORD_INVALID`. `Assumed`

### 7.5 Key generator

- Facts: putting records with explicit numeric keys advances an `autoIncrement` store's generator (keys 1 to 7
  restored, the next `add` got 8). Verified (2026-10-24, [RESULTS.md](../../spikes/runtime-compat/RESULTS.md) H14a).
  `clear()` does not reset the generator; deleting the database does. Verified (2026-10-24,
  [progress-lab README](../../fixtures/test-games/progress-lab/README.md)). The W3C draft says an explicit numeric key
  sets the current number to its floor plus 1 only when that is higher, an aborted transaction reverts the current
  number, and above 2^53 the generator fails with `ConstraintError`. Verified (2026-10-25,
  <https://www.w3.org/TR/IndexedDB/>, Working Draft of 2025-08-13). Chromium reverts the generator on abort. Verified
  (2026-10-28, `packages/exporters/browser/key-generator.spec.ts`, bundled Chromium 156.0.8078.4); in Electron 45
  Assumed.
- So the maximum key does not determine the generator (records may have been deleted after higher keys were
  generated). The exporter records the current number by a probe that adds a placeholder and aborts the transaction;
  the importer raises the generator to it after the records; the restore check sees any difference, because
  `schema.cbor` is hashed. Both procedures are in
  [save-transfer.md](save-transfer.md#4-generic-exporter). An exhausted generator is
  `EXP_KEY_GENERATOR_EXHAUSTED`. `Assumed`

## 8. Limits and error codes

Defaults, all `Assumed` (sized for save data, not game assets). The codec takes a limits object so that tests can lower
them; production uses these values, and a unit test pins them.

| Limit | Default |
| --- | --- |
| `maxFileBytes` (compressed `.wgsnap`) | 1 GiB |
| `maxEntries` | 100 000 |
| `maxEntryBytes` | 512 MiB |
| `maxTotalBytes` (uncompressed tar stream) | 2 GiB |
| `maxRatio` | 200, against the declared compressed size, once the uncompressed stream passes `ratioFloorBytes` |
| `ratioFloorBytes` | 64 MiB |
| `maxManifestBytes` | 1 MiB |
| `maxStorageKeys`, `maxDatabasesPerKey`, `maxStoresPerDatabase`, `maxIndexesPerStore` | 32, 256, 256, 64 |
| `maxDepth` (value nesting) | 256 |

A reader is given the exact compressed size of the file (`compressedSize`; the worker validates a private copy in
`tmp/` and takes it from `stat`). `Assumed` (owner ruling R11, 2026-10-25)

- `SNAP_FILE_TOO_LARGE` is checked first, from `compressedSize` against `maxFileBytes`, before any byte is read.
- The ratio rule: once the uncompressed bytes so far pass `ratioFloorBytes` and exceed `maxRatio` × `compressedSize`,
  the file is `SNAP_RATIO_EXCEEDED`; equivalently, the tar stream may hold at most max(`ratioFloorBytes`, `maxRatio` ×
  `compressedSize`) bytes. When this bound and `maxTotalBytes` fall on the same byte, `SNAP_RATIO_EXCEEDED` wins.
- The reader counts the compressed bytes it reads. A source that yields more than `compressedSize` bytes is
  `SNAP_FILE_TOO_LARGE` at the first extra byte; one that ends below it is `SNAP_TRUNCATED`. Both are verdicts on the
  compressed bytes (section 2): the frame walker's verdict on the bytes within `compressedSize` and the checks of the
  data before the extra or missing byte come first.
- A decompressor error is `SNAP_ZSTD_INVALID` only when the frame walker has no verdict on the whole input (section 2,
  Ruling R23).

Container-level codes, checked continuously while streaming: `SNAP_FILE_TOO_LARGE`; `SNAP_ZSTD_INVALID` (not a zstd
frame, a skippable frame first, corrupt data, a content checksum mismatch, a window above 2^27, a dictionary id);
`SNAP_ZSTD_NO_CHECKSUM`; `SNAP_TRUNCATED` (input ends early, detected by the frame walker of section 2, since not every
decompressor reports it); `SNAP_RATIO_EXCEEDED` (the ratio rule above); `SNAP_TOTAL_TOO_LARGE`; `SNAP_TRAILING_DATA` (any byte after the first frame, another
frame included, or non-zero bytes after the tar end blocks). Entry codes are in section 3.1, manifest and
hash codes (`SNAP_MANIFEST_TOO_LARGE`, `SNAP_MANIFEST_INVALID`, `SNAP_UNKNOWN_FORMAT`, `SNAP_UNSUPPORTED_VERSION`,
`SNAP_CONTENT_HASH_MISMATCH`, `SNAP_SIZE_MISMATCH`, `SNAP_ENTRY_HASH_MISMATCH`, `SNAP_MISSING_ENTRY`) in sections 4 and
5, `SNAP_UNEXPECTED_ENTRY` in sections 3.2 and 5, and `SNAP_RECORD_INVALID` in sections 6 and 7. `IMP_REVISION_CONFLICT`
(section 4) is raised by the import, not by the reader.

- Count limits: more than `maxStorageKeys` storage keys is `SNAP_MANIFEST_INVALID` (section 4); more than
  `maxDatabasesPerKey` databases, `maxStoresPerDatabase` stores or `maxIndexesPerStore` indexes is
  `SNAP_RECORD_INVALID`, with the path of the `schema.cbor` or `store-<s>.cbor` that exceeds it. No dedicated code
  exists for these counts. `Assumed`
- Validation is complete before anything is written to any game storage: all entries hashed, all records decoded and
  checked (AC-9). The restore streams the file a second time and re-checks every entry hash, so a file that changes
  between the passes fails the import and triggers the rollback. `Assumed`
- The first failure ends validation with one code; the error carries the entry path where one exists, never data
  content. `Assumed`

## 9. Versioning and migration

- `formatVersion` is an integer. It changes whenever a v1 reader would restore something differently: new tags, new
  entry kinds, new required fields, changed canonicalization or hash coverage. Optional informational manifest fields
  can be added without a change because readers ignore them. Such fields use the same JSON subset as the rest of the
  manifest (strings, safe integers, booleans, `null`, arrays and objects; section 4), or a v1 reader refuses the file.
  `Assumed`
- A reader refuses an unknown `formatVersion` with `SNAP_UNSUPPORTED_VERSION` and writes nothing (AGENTS.md
  data-safety invariant 5). `Owner`
- Snapshots are immutable. A reader keeps supporting every version it ever shipped; there is no in-place migration.
  Moving old data to a new version means restoring it and exporting again. `Assumed`
- The exporter version (`exporter.version`, SemVer) is separate: a major bump when it encodes the same storage
  differently, a minor bump when it supports more of it. "Export verified" is tied to the exact exporter version
  ([architecture.md](architecture.md#11-badges)). `Assumed`

## 10. Golden vectors (manifest format frozen now)

- Record-level hand vectors: `packages/snapshot/test-vectors/cbor-v1.json` is a language-neutral JSON array of
  `{id, value, hex, ok}` (`value` in the notation below, absent for invalid vectors, which carry `error`). Every hex
  string was written by hand from RFC 8949 and section 6, never produced by the encoder, and the byte-by-byte
  explanation is in the comments of `src/record/cbor-vectors.test.ts`. A valid vector holds both ways: encoding
  `value` gives `hex`, and decoding `hex` as a one-item sequence passes the value check and gives `value`. An invalid
  vector fails the decoder or the value check with `SNAP_RECORD_INVALID`. A later Rust codec MUST pass the same file.
  `Assumed`
- Layout: `packages/snapshot/test-vectors/v1/index.json` (the ordered list of vector ids, a JSON array of strings) and
  one directory per vector, `packages/snapshot/test-vectors/v1/<id>/`, holding `vector.json`, `input.wgsnap` and, for
  valid vectors, `content.json`, and nothing else. A runner fails on a listed directory that is missing and on an
  unlisted one. A reader is given the file size of `input.wgsnap` as `compressedSize` (section 8). `Assumed`
- Vectors are generated once by a script in `packages/snapshot` (`scripts/generate-vectors.ts`, which refuses to
  overwrite an existing `v1/` without `--overwrite`), committed, and frozen: an expected result changes only with a new
  `formatVersion` or a reviewed correction. Invalid vectors are written as raw bytes, because a conforming writer cannot
  produce them; each changes one thing in a valid base, so it fails for its own reason and no earlier one. A later Rust
  implementation passes the same directory (ADR-0003). `Owner` for shared vectors, `Assumed` for the rest.

`vector.json` of an invalid vector:

```json
{
  "vectorFormat": 1,
  "id": "invalid-traversal",
  "description": "A regular file named ../escape.txt after the manifest",
  "input": "input.wgsnap",
  "limits": {},
  "expect": { "ok": false, "error": "SNAP_PATH_TRAVERSAL" }
}
```

- For a valid vector `expect` is `{"ok": true, "contentHash": "<hex>", "content": "content.json"}`. `limits` overrides
  section 8 by name, so that size vectors stay small. Unknown members are an error in the runner. `Assumed`
- A valid vector is checked both ways: decoding `input.wgsnap` gives `content.json`, and encoding `content.json` gives
  the same entry paths and hashes, hence the same `contentHash`. The compressed bytes are not compared, because zstd
  output depends on the library version.
- `content.json` uses a test-only notation: `{"storageKeys": [{"origin", "topLevelSite", "role", "localStorage": [[k, v]],
  "indexedDB": [{"name", "version", "stores": [{"name", "keyPath", "autoIncrement", "keyGenerator", "indexes",
  "records": [[key, value]]}]}]}]}`. A value is a JSON string (well-formed only), `true`, `false`, `null`, a safe
  integer, a JSON array (a dense Array) or an object with a `"$"` member naming the type: `undefined`, `f64` (`hex`: the
  16 hex digits of the IEEE 754 bits), `str16` (`hex` of UTF-16LE), `bigint` (`v` decimal), `object`, `map` and
  `sparse` (`entries` as pairs, `sparse` also `length`; `object` and `sparse` keys are JSON strings or `str16` objects,
  indexes in decimal; `map` keys are values), `set` (`items`), `date` (`v` a value), `boxed` (`v`),
  `regexp` (`source` a JSON string or `str16` object, `flags`), `bytes` (`hex`), `view` (`type`, `hex`, optional `bufferHex`, `byteOffset`, `length`),
  `blob` (`type`, `hex`) and `file` (`name`, `lastModified`, `type`, `hex`). `Assumed`

| Vector | Content | Expected |
| --- | --- | --- |
| `valid-minimal` | One first-party key with two localStorage items | ok |
| `valid-binary-types` | IndexedDB records with Date, ArrayBuffer, every typed array, DataView, a partial view, Blob, File, binary and array keys | ok |
| `valid-special-values` | `-0`, `NaN`, `±Infinity`, `undefined` beside a missing property, BigInt, sparse array, Map, Set, boxed values, RegExp, invalid Date, lone surrogate | ok |
| `valid-partitioned-iframe` | A first-party key and a partitioned key (`topLevelSite` set), like progress-lab variant c | ok |
| `valid-idbfs` | The progress-lab IDBFS shape: database `/home/web_user` version 21, store `FILE_DATA`, index `timestamp` | ok |
| `valid-key-generator` | An `autoIncrement` store whose `keyGenerator` is above its highest key | ok |
| `valid-empty` | No storage keys (a backup of an empty partition) | ok |
| `invalid-truncated` | The `input.wgsnap` of `valid-binary-types` cut to its first floor(length / 2) bytes: a cut inside the zstd frame, found by the frame walker (cut length in the vector's `description`) | `SNAP_TRUNCATED` |
| `invalid-truncated-tar` | A complete checksummed zstd frame whose tar is the tar of `valid-binary-types` ending 100 bytes into the data of its second entry, found by the tar reader (cut length in the vector's `description`) | `SNAP_TRUNCATED` |
| `invalid-not-zstd` | Bytes that are not a zstd frame | `SNAP_ZSTD_INVALID` |
| `invalid-no-checksum` | zstd frame without content checksum | `SNAP_ZSTD_NO_CHECKSUM` |
| `invalid-traversal` | `../escape.txt` | `SNAP_PATH_TRAVERSAL` |
| `invalid-absolute` | `/etc/escape` | `SNAP_ABSOLUTE_PATH` |
| `invalid-symlink` | Symbolic link entry | `SNAP_SYMLINK` |
| `invalid-hardlink` | Hard link entry | `SNAP_HARDLINK` |
| `invalid-device` | Character device entry | `SNAP_DEVICE` |
| `invalid-pax` | Pax extended header | `SNAP_UNSUPPORTED_ENTRY_TYPE` |
| `invalid-non-nfc` | Path with a decomposed character (`e` plus U+0301) | `SNAP_NON_NFC_PATH` |
| `invalid-duplicate-path` | The same path twice | `SNAP_DUPLICATE_PATH` |
| `invalid-too-many-entries` | 11 entries with `maxEntries` 10 | `SNAP_TOO_MANY_ENTRIES` |
| `invalid-oversize-file` | Header size above `maxEntryBytes` | `SNAP_ENTRY_TOO_LARGE` |
| `invalid-total-oversize` | Entries summing above a lowered `maxTotalBytes` | `SNAP_TOTAL_TOO_LARGE` |
| `invalid-ratio-bomb` | Zeros compressing far above `maxRatio` with a lowered floor | `SNAP_RATIO_EXCEEDED` |
| `invalid-missing-manifest` | First file is a data file | `SNAP_MISSING_MANIFEST` |
| `invalid-manifest-not-canonical` | Manifest with whitespace | `SNAP_MANIFEST_INVALID` |
| `invalid-unknown-version` | `formatVersion` 2 | `SNAP_UNSUPPORTED_VERSION` |
| `invalid-bad-content-hash` | One hex digit of `contentHash` changed | `SNAP_CONTENT_HASH_MISMATCH` |
| `invalid-bad-hash` | One byte of a data entry changed, manifest unchanged | `SNAP_ENTRY_HASH_MISMATCH` |
| `invalid-unexpected-entry` | `data/0/extra.bin` | `SNAP_UNEXPECTED_ENTRY` |
| `invalid-noncanonical-record` | A float holding an integer | `SNAP_RECORD_INVALID` |
| `invalid-unknown-tag` | Tag 33199 in a record | `SNAP_RECORD_INVALID` |
| `invalid-trailing-data` | Non-zero bytes after the tar end blocks | `SNAP_TRAILING_DATA` |

- The two truncation vectors and their cut rule are `Owner` (Phase 1 plan, M6); the other rows are `Assumed`. Because
  zstd output depends on the library version, a regenerated `valid-binary-types` may have other compressed bytes, which
  is why both cut lengths are recorded in the vectors themselves.

## Open questions

- Register tags 33101 to 33112 through the IANA "First Come First Served" procedure? It is an external action (owner).
  Default: not registered; collisions are harmless inside `.wgsnap`. `Assumed`
- Shared references and cycles are rejected in v1 (`EXP_SHARED_REFERENCE`). If real games need them, the registered
  value-sharing tags 28 and 29 can be adopted in a later `formatVersion`. `Assumed`
- The size limits in section 8 are guesses for save data. A game that keeps large assets in IndexedDB will hit them;
  an adapter that excludes the assets is the intended answer. `Assumed`
- `notExported` relies on `navigator.storage.estimate().usageDetails`, a Chromium extension of the standard. Default:
  record it when present, omit it otherwise. Unverified (not checked in an isolated world).
