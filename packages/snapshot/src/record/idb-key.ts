// IndexedDB keys (snapshot-format.md section 7.3): the W3C key order, and the restriction of the value encoding to
// valid keys (a number other than NaN, a valid Date, a string, a byte string or an array of keys). Web APIs only.
import { ExportError, type PathSegment, SnapError } from "../errors.js";
import { type CborItem, MAX_DEPTH, TAG } from "./cbor.js";
import { numberItem, stringItem, stringOf } from "./value.js";

/** A JavaScript IndexedDB key. Binary keys read back as ArrayBuffer; views are accepted as binary keys. */
export type IdbKey = number | Date | string | ArrayBuffer | ArrayBufferView | IdbKey[];

type Classified =
  | { kind: 0 | 1; n: number }
  | { kind: 2; s: string }
  | { kind: 3; b: Uint8Array }
  | { kind: 4; a: unknown[] };

function timeOf(value: object): number | undefined {
  try {
    return Date.prototype.getTime.call(value);
  } catch {
    return undefined;
  }
}

function binaryOf(value: object): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return Object.getPrototypeOf(value) === ArrayBuffer.prototype
    ? new Uint8Array(value as ArrayBuffer)
    : undefined;
}

/** The key type and comparable content of a value, or undefined when it is not a valid key. */
function classify(value: unknown): Classified | undefined {
  if (typeof value === "number") {
    return Number.isNaN(value) ? undefined : { kind: 0, n: value };
  }
  if (typeof value === "string") {
    return { kind: 2, s: value };
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return { kind: 4, a: value };
  }
  const time = timeOf(value);
  if (time !== undefined) {
    return Number.isNaN(time) ? undefined : { kind: 1, n: time };
  }
  const b = binaryOf(value);
  return b === undefined ? undefined : { kind: 3, b };
}

const sign = (d: number): -1 | 0 | 1 => (d < 0 ? -1 : d > 0 ? 1 : 0);

function compareClassified(a: Classified, b: Classified): -1 | 0 | 1 {
  if (a.kind !== b.kind) {
    return sign(a.kind - b.kind);
  }
  if (a.kind === 2) {
    const s = (b as { s: string }).s;
    return a.s < s ? -1 : a.s > s ? 1 : 0; // JavaScript `<` compares UTF-16 code units
  }
  if (a.kind === 3) {
    const other = (b as { b: Uint8Array }).b;
    const n = Math.min(a.b.length, other.length);
    for (let i = 0; i < n; i++) {
      if (a.b[i] !== other[i]) {
        return sign((a.b[i] as number) - (other[i] as number));
      }
    }
    return sign(a.b.length - other.length);
  }
  if (a.kind === 4) {
    const other = (b as { a: unknown[] }).a;
    const n = Math.min(a.a.length, other.length);
    for (let i = 0; i < n; i++) {
      const c = compareIdbKeys(a.a[i] as IdbKey, other[i] as IdbKey);
      if (c !== 0) {
        return c;
      }
    }
    return sign(a.a.length - other.length);
  }
  return sign(a.n - (b as { n: number }).n);
}

/** W3C "compare two keys": number < Date < string < binary < array. Throws TypeError on a non-key. */
export function compareIdbKeys(a: IdbKey, b: IdbKey): -1 | 0 | 1 {
  const ca = classify(a);
  const cb = classify(b);
  if (ca === undefined || cb === undefined) {
    throw new TypeError("not a valid IndexedDB key");
  }
  return compareClassified(ca, cb);
}

function toKeyItem(key: unknown, depth: number, path: PathSegment[], seen: Set<object>): CborItem {
  const c = classify(key);
  if (
    c === undefined ||
    depth > MAX_DEPTH ||
    (typeof key === "object" && seen.has(key as object))
  ) {
    const type = Object.prototype.toString.call(key);
    throw new ExportError("EXP_UNSUPPORTED_VALUE", `not a valid IndexedDB key: ${type}`, {
      path: [...path],
      type,
    });
  }
  switch (c.kind) {
    case 0:
      return numberItem(c.n);
    case 1:
      return { k: "tag", tag: TAG.date, v: numberItem(c.n) };
    case 2:
      return stringItem(c.s);
    case 3:
      return { k: "bytes", v: c.b.slice() };
    case 4:
      seen.add(key as object);
      return {
        k: "array",
        v: c.a.map((element, i) => toKeyItem(element, depth + 1, [...path, i], seen)),
      };
  }
}

/** A JS key to its item. A non-key is `EXP_UNSUPPORTED_VALUE` with its path inside the key. */
export function keyToItem(key: unknown): CborItem {
  return toKeyItem(key, 1, [], new Set());
}

function invalidKey(): never {
  throw new SnapError("SNAP_RECORD_INVALID", "record key is not a valid IndexedDB key");
}

/** A decoded key item back to a JS key; anything outside the key subset is `SNAP_RECORD_INVALID`. */
export function keyFromItem(item: CborItem): IdbKey {
  switch (item.k) {
    case "uint":
    case "nint":
      return item.v;
    case "float":
      return Number.isNaN(item.v) ? invalidKey() : item.v;
    case "text":
      return item.v;
    case "bytes":
      return item.v.slice().buffer;
    case "array":
      return item.v.map(keyFromItem);
    case "tag": {
      if (item.tag === TAG.str16) {
        return stringOf(item) as string;
      }
      const time = item.v;
      const valid =
        item.tag === TAG.date &&
        (time.k === "uint" || time.k === "nint") &&
        Math.abs(time.v) <= 8.64e15;
      return valid ? new Date(time.v as number) : invalidKey();
    }
    default:
      return invalidKey();
  }
}
