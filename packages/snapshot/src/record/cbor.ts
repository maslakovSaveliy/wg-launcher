// The deterministic CBOR profile of snapshot-format.md section 6.2: a canonical encoder and a decoder that rejects
// every other encoding, so the bytes of a value are unique. Web APIs only (no `node:`): it runs in the quiescent
// preload and in the snapshot worker.
import { SnapError } from "../errors.js";

/**
 * A decoded CBOR data item. Integers carry their value (`nint` is negative); `map` keeps its pairs in encoded order,
 * which the profile requires to be sorted.
 */
export type CborItem =
  | { k: "uint" | "nint"; v: number }
  | { k: "float"; v: number }
  | { k: "bytes"; v: Uint8Array }
  | { k: "text"; v: string }
  | { k: "array"; v: CborItem[] }
  | { k: "map"; v: [string, CborItem][] }
  | { k: "tag"; tag: number; v: CborItem }
  | { k: "simple"; v: boolean | null | undefined };

/** Default nesting limit (snapshot-format.md section 8, `maxDepth`). */
export const MAX_DEPTH = 256;

/** The tags of snapshot-format.md section 6.3: the only ones rule 7 allows. */
export const TAG = {
  object: 33101,
  str16: 33102,
  sparseArray: 33103,
  date: 33104,
  bigint: 33105,
  map: 33106,
  set: 33107,
  boxed: 33108,
  dataView: 33109,
  partialView: 33110,
  blob: 33111,
  file: 33112,
  regexp: 21066,
} as const;

/** RFC 8746 little-endian typed-array tags, by constructor name. */
export const TYPED_ARRAY_TAGS = {
  Uint8Array: 64,
  Uint8ClampedArray: 68,
  Int8Array: 72,
  Uint16Array: 69,
  Int16Array: 77,
  Uint32Array: 70,
  Int32Array: 78,
  BigUint64Array: 71,
  BigInt64Array: 79,
  Float16Array: 84,
  Float32Array: 85,
  Float64Array: 86,
} as const;

const ALLOWED_TAGS: ReadonlySet<number> = new Set([
  ...Object.values(TAG),
  ...Object.values(TYPED_ARRAY_TAGS),
]);

export interface DecodeOptions {
  /** Deepest allowed item: a top-level item is at depth 0, array elements and map members one deeper. */
  maxDepth?: number;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const utf8Encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF: text is never altered (rule 4).
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const isIntegerNumber = (v: number) => Number.isSafeInteger(v) && !Object.is(v, -0);

function fitsFloat16(v: number): boolean {
  const view = new DataView(new ArrayBuffer(2));
  view.setFloat16(0, v);
  return Object.is(view.getFloat16(0), v);
}

const fitsFloat32 = (v: number) => Object.is(Math.fround(v), v);

/** Bytewise lexicographic order (a prefix sorts first), as RFC 8949 section 4.2.1 sorts map keys. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) {
      return d;
    }
  }
  return a.length - b.length;
}

class Writer {
  private buf = new Uint8Array(64);
  private len = 0;

  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) {
      return;
    }
    let size = this.buf.length * 2;
    while (size < this.len + n) {
      size *= 2;
    }
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.reserve(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.reserve(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  private uint32(n: number): void {
    this.byte((n >>> 24) & 0xff);
    this.byte((n >>> 16) & 0xff);
    this.byte((n >>> 8) & 0xff);
    this.byte(n & 0xff);
  }

  /** A head in its shortest form (rule 1); `n` is a safe non-negative integer. */
  head(major: number, n: number): void {
    const m = major << 5;
    if (n < 24) {
      this.byte(m | n);
    } else if (n < 0x100) {
      this.byte(m | 24);
      this.byte(n);
    } else if (n < 0x10000) {
      this.byte(m | 25);
      this.byte(n >>> 8);
      this.byte(n & 0xff);
    } else if (n < 0x100000000) {
      this.byte(m | 26);
      this.uint32(n);
    } else {
      this.byte(m | 27);
      this.uint32(Math.floor(n / 0x100000000));
      this.uint32(n >>> 0);
    }
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function writeFloat(w: Writer, v: number): void {
  if (Number.isNaN(v)) {
    w.bytes(new Uint8Array([0xf9, 0x7e, 0x00]));
    return;
  }
  const view = new DataView(new ArrayBuffer(9));
  if (fitsFloat16(v)) {
    view.setUint8(0, 0xf9);
    view.setFloat16(1, v);
    w.bytes(new Uint8Array(view.buffer, 0, 3));
  } else if (fitsFloat32(v)) {
    view.setUint8(0, 0xfa);
    view.setFloat32(1, v);
    w.bytes(new Uint8Array(view.buffer, 0, 5));
  } else {
    view.setUint8(0, 0xfb);
    view.setFloat64(1, v);
    w.bytes(new Uint8Array(view.buffer, 0, 9));
  }
}

function writeText(w: Writer, s: string): void {
  if (!s.isWellFormed()) {
    throw new TypeError("a text item must be a well-formed string; lone surrogates use tag 33102");
  }
  const bytes = utf8Encoder.encode(s);
  w.head(3, bytes.length);
  w.bytes(bytes);
}

function writeMap(w: Writer, pairs: [string, CborItem][]): void {
  const encoded = pairs.map(([key, value]) => {
    const kw = new Writer();
    writeText(kw, key);
    return { key: kw.result(), value };
  });
  encoded.sort((a, b) => compareBytes(a.key, b.key));
  w.head(5, encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    const pair = encoded[i] as (typeof encoded)[number];
    if (i > 0 && compareBytes((encoded[i - 1] as typeof pair).key, pair.key) === 0) {
      throw new TypeError("duplicate map key");
    }
    w.bytes(pair.key);
    writeItem(w, pair.value);
  }
}

function writeItem(w: Writer, item: CborItem): void {
  switch (item.k) {
    case "uint":
      if (!isIntegerNumber(item.v) || item.v < 0) {
        throw new TypeError("uint must be a safe integer >= 0");
      }
      w.head(0, item.v);
      return;
    case "nint":
      if (!Number.isSafeInteger(item.v) || item.v >= 0) {
        throw new TypeError("nint must be a negative safe integer");
      }
      w.head(1, -1 - item.v);
      return;
    case "float":
      if (typeof item.v !== "number" || isIntegerNumber(item.v)) {
        throw new TypeError("a float item must not hold a safe integer other than -0");
      }
      writeFloat(w, item.v);
      return;
    case "bytes":
      w.head(2, item.v.length);
      w.bytes(item.v);
      return;
    case "text":
      writeText(w, item.v);
      return;
    case "array":
      w.head(4, item.v.length);
      for (const element of item.v) {
        writeItem(w, element);
      }
      return;
    case "map":
      writeMap(w, item.v);
      return;
    case "tag":
      if (!ALLOWED_TAGS.has(item.tag) || item.v.k === "tag") {
        throw new TypeError(`tag ${item.tag} is not allowed here by the profile`);
      }
      w.head(6, item.tag);
      writeItem(w, item.v);
      return;
    case "simple":
      w.byte(item.v === false ? 0xf4 : item.v === true ? 0xf5 : item.v === null ? 0xf6 : 0xf7);
      return;
  }
}

/** Canonical encoding of one item (snapshot-format.md section 6.2). Throws TypeError on an item outside the profile. */
export function encodeItem(item: CborItem): Uint8Array {
  const w = new Writer();
  writeItem(w, item);
  return w.result();
}

class Reader {
  private pos = 0;
  private readonly view: DataView;

  constructor(
    private readonly input: Uint8Array,
    private readonly maxDepth: number,
  ) {
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.input.length;
  }

  private fail(reason: string, at: number): never {
    throw new SnapError("SNAP_RECORD_INVALID", `CBOR ${reason} at offset ${at}`);
  }

  private need(n: number, start: number): void {
    if (this.input.length - this.pos < n) {
      this.fail("item is truncated", start);
    }
  }

  private take(n: number, start: number): number {
    this.need(n, start);
    const at = this.pos;
    this.pos += n;
    return at;
  }

  private argument(info: number, start: number): number {
    if (info < 24) {
      return info;
    }
    let n: number;
    let min: number;
    if (info === 24) {
      n = this.view.getUint8(this.take(1, start));
      min = 24;
    } else if (info === 25) {
      n = this.view.getUint16(this.take(2, start));
      min = 0x100;
    } else if (info === 26) {
      n = this.view.getUint32(this.take(4, start));
      min = 0x10000;
    } else if (info === 27) {
      const at = this.take(8, start);
      const hi = this.view.getUint32(at);
      if (hi > 0x1fffff) {
        this.fail("argument is above 2^53 - 1", start);
      }
      n = hi * 0x100000000 + this.view.getUint32(at + 4);
      min = 0x100000000;
    } else {
      this.fail("head uses a reserved or indefinite length", start);
    }
    if (n < min) {
      this.fail("head is not in its shortest form", start);
    }
    return n;
  }

  private float(info: number, start: number): CborItem {
    let v: number;
    if (info === 25) {
      const at = this.take(2, start);
      v = this.view.getFloat16(at);
      if (Number.isNaN(v) && this.view.getUint16(at) !== 0x7e00) {
        this.fail("NaN is not f97e00", start);
      }
    } else if (info === 26) {
      v = this.view.getFloat32(this.take(4, start));
      if (Number.isNaN(v) || fitsFloat16(v)) {
        this.fail("float is not in its shortest exact form", start);
      }
    } else {
      v = this.view.getFloat64(this.take(8, start));
      if (Number.isNaN(v) || fitsFloat32(v)) {
        this.fail("float is not in its shortest exact form", start);
      }
    }
    if (isIntegerNumber(v)) {
      this.fail("float holds a safe integer", start);
    }
    return { k: "float", v };
  }

  private major7(info: number, start: number): CborItem {
    switch (info) {
      case 20:
        return { k: "simple", v: false };
      case 21:
        return { k: "simple", v: true };
      case 22:
        return { k: "simple", v: null };
      case 23:
        return { k: "simple", v: undefined };
      case 25:
      case 26:
      case 27:
        return this.float(info, start);
      default:
        return this.fail("simple value is not allowed", start);
    }
  }

  private map(n: number, depth: number, start: number): CborItem {
    if (n > (this.input.length - this.pos) / 2) {
      this.fail("map count exceeds the input", start);
    }
    const pairs: [string, CborItem][] = [];
    let previous: Uint8Array | undefined;
    for (let i = 0; i < n; i++) {
      const keyStart = this.pos;
      const key = this.item(depth + 1);
      if (key.k !== "text") {
        this.fail("map key is not a text string", keyStart);
      }
      const keyBytes = this.input.subarray(keyStart, this.pos);
      if (previous !== undefined && compareBytes(previous, keyBytes) >= 0) {
        this.fail("map keys are not strictly ascending", keyStart);
      }
      previous = keyBytes;
      pairs.push([key.v, this.item(depth + 1)]);
    }
    return { k: "map", v: pairs };
  }

  item(depth: number): CborItem {
    const start = this.pos;
    if (depth > this.maxDepth) {
      this.fail("item is nested deeper than maxDepth", start);
    }
    const initial = this.view.getUint8(this.take(1, start));
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 7) {
      return this.major7(info, start);
    }
    const n = this.argument(info, start);
    switch (major) {
      case 0:
        return { k: "uint", v: n };
      case 1:
        if (n > MAX_SAFE - 1) {
          this.fail("negative integer is below -(2^53 - 1)", start);
        }
        return { k: "nint", v: -1 - n };
      case 2: {
        const at = this.take(n, start);
        return { k: "bytes", v: this.input.slice(at, at + n) };
      }
      case 3: {
        const at = this.take(n, start);
        try {
          return { k: "text", v: utf8Decoder.decode(this.input.subarray(at, at + n)) };
        } catch {
          return this.fail("text is not valid UTF-8", start);
        }
      }
      case 4: {
        if (n > this.input.length - this.pos) {
          this.fail("array count exceeds the input", start);
        }
        const elements: CborItem[] = [];
        for (let i = 0; i < n; i++) {
          elements.push(this.item(depth + 1));
        }
        return { k: "array", v: elements };
      }
      case 5:
        return this.map(n, depth, start);
      default: {
        if (!ALLOWED_TAGS.has(n)) {
          this.fail("tag is not allowed by the profile", start);
        }
        // Checked before decoding the content, so a chain of tags cannot recurse without bound (tags add no depth).
        this.need(1, start);
        if (this.view.getUint8(this.pos) >> 5 === 6) {
          this.fail("tag content is a tag", this.pos);
        }
        return { k: "tag", tag: n, v: this.item(depth) };
      }
    }
  }
}

/**
 * Decodes a CBOR sequence (RFC 8742) under the profile. Any break of rules 1 to 8 is `SNAP_RECORD_INVALID`; the
 * message names the byte offset, never data.
 */
export function decodeSequence(bytes: Uint8Array, options: DecodeOptions = {}): CborItem[] {
  const reader = new Reader(bytes, options.maxDepth ?? MAX_DEPTH);
  const items: CborItem[] = [];
  while (!reader.done) {
    items.push(reader.item(0));
  }
  return items;
}
