// Test-only: the value notation of snapshot-format.md section 10, converted to and from CBOR items and JavaScript
// values. It is written independently of src/record/value.ts (its own tag numbers and number rule), so a test that
// compares the two catches a mistake in either. Node-only (`node:crypto`), never exported from src/index.ts.
import { createHash } from "node:crypto";
import type { CborItem } from "../src/record/cbor.js";

/** A value in test notation: JSON scalars and dense arrays, or an object whose `"$"` member names the type. */
export type Notation = string | boolean | null | number | Notation[] | NotationObject;
export interface NotationObject {
  $: string;
  [member: string]: unknown;
}

const VIEW_TAGS: Record<string, number> = {
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
  DataView: 33109,
};

const VIEW_CONSTRUCTORS: Record<
  string,
  new (
    buffer: ArrayBuffer,
    offset?: number,
    length?: number,
  ) => object
> = {
  Uint8Array,
  Uint8ClampedArray,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  BigUint64Array,
  BigInt64Array,
  Float16Array,
  Float32Array,
  Float64Array,
  DataView,
};

const ELEMENT_SIZES: Record<string, number> = {
  Uint8Array: 1,
  Uint8ClampedArray: 1,
  Int8Array: 1,
  Uint16Array: 2,
  Int16Array: 2,
  Uint32Array: 4,
  Int32Array: 4,
  BigUint64Array: 8,
  BigInt64Array: 8,
  Float16Array: 2,
  Float32Array: 4,
  Float64Array: 8,
  DataView: 1,
};

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new Error(`not lowercase hex: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function f64FromHex(hex: string): number {
  return new DataView(hexToBytes(hex).buffer).getFloat64(0);
}

function f64ToHex(n: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  return bytesToHex(new Uint8Array(view.buffer));
}

function str16ToString(hex: string): string {
  const bytes = hexToBytes(hex);
  let s = "";
  for (let i = 0; i < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8));
  }
  return s;
}

export function stringToStr16(s: string): string {
  let hex = "";
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    hex += bytesToHex(new Uint8Array([unit & 0xff, unit >> 8]));
  }
  return hex;
}

const num = (n: number): CborItem =>
  Number.isSafeInteger(n) && !Object.is(n, -0)
    ? { k: n >= 0 ? "uint" : "nint", v: n }
    : { k: "float", v: n };
const tag = (t: number, v: CborItem): CborItem => ({ k: "tag", tag: t, v });
const arr = (v: CborItem[]): CborItem => ({ k: "array", v });
const text = (v: string): CborItem => ({ k: "text", v });
const bytes = (hex: string): CborItem => ({ k: "bytes", v: hexToBytes(hex) });

function member<T>(n: NotationObject, name: string): T {
  if (!(name in n)) {
    throw new Error(`notation ${n.$} lacks ${name}`);
  }
  return n[name] as T;
}

function pairs(entries: [Notation, Notation][]): CborItem[] {
  return entries.flatMap(([k, v]) => [notationToItem(k), notationToItem(v)]);
}

/** Test notation to the CBOR item a conforming encoder must produce for that value. */
export function notationToItem(n: Notation): CborItem {
  if (typeof n === "string") {
    if (!n.isWellFormed()) {
      throw new Error("a lone surrogate is written as str16");
    }
    return text(n);
  }
  if (typeof n === "boolean" || n === null) {
    return { k: "simple", v: n };
  }
  if (typeof n === "number") {
    if (!Number.isSafeInteger(n) || Object.is(n, -0)) {
      throw new Error("a JSON number is a safe integer; other numbers are written as f64");
    }
    return num(n);
  }
  if (Array.isArray(n)) {
    return arr(n.map(notationToItem));
  }
  switch (n.$) {
    case "undefined":
      return { k: "simple", v: undefined };
    case "f64":
      return num(f64FromHex(member(n, "hex")));
    case "str16":
      return tag(33102, bytes(member(n, "hex")));
    case "bigint":
      return tag(33105, text(member(n, "v")));
    case "object":
      return tag(33101, arr(pairs(member(n, "entries"))));
    case "sparse":
      return tag(33103, arr([num(member(n, "length")), ...pairs(member(n, "entries"))]));
    case "map":
      return tag(33106, arr(pairs(member(n, "entries"))));
    case "set":
      return tag(33107, arr(member<Notation[]>(n, "items").map(notationToItem)));
    case "date":
      return tag(33104, notationToItem(member(n, "v")));
    case "boxed":
      return tag(33108, arr([notationToItem(member(n, "v"))]));
    case "regexp":
      return tag(21066, arr([notationToItem(member(n, "source")), text(member(n, "flags"))]));
    case "bytes":
      return bytes(member(n, "hex"));
    case "view":
      return viewToItem(n);
    case "blob": {
      const content = hexToBytes(member(n, "hex"));
      return tag(
        33111,
        arr([text(member(n, "type")), num(content.length), text(sha256Hex(content))]),
      );
    }
    case "file": {
      const content = hexToBytes(member(n, "hex"));
      return tag(
        33112,
        arr([
          text(member(n, "name")),
          num(member(n, "lastModified")),
          text(member(n, "type")),
          num(content.length),
          text(sha256Hex(content)),
        ]),
      );
    }
    default:
      throw new Error(`unknown notation type ${n.$}`);
  }
}

function viewToItem(n: NotationObject): CborItem {
  const type = member<string>(n, "type");
  const viewTag = VIEW_TAGS[type];
  if (viewTag === undefined) {
    throw new Error(`unknown view type ${type}`);
  }
  if (n.bufferHex === undefined) {
    return tag(viewTag, bytes(member(n, "hex")));
  }
  const buffer = member<string>(n, "bufferHex");
  const offset = member<number>(n, "byteOffset");
  const length = member<number>(n, "length");
  const size = ELEMENT_SIZES[type] ?? 1;
  if (buffer.slice(offset * 2, (offset + length * size) * 2) !== member(n, "hex")) {
    throw new Error("view hex does not match its buffer slice");
  }
  return tag(33110, arr([num(viewTag), bytes(buffer), num(offset), num(length)]));
}

function itemNumber(item: CborItem): Notation {
  if (item.k === "uint" || item.k === "nint") {
    return item.v;
  }
  if (item.k === "float") {
    return { $: "f64", hex: f64ToHex(item.v) };
  }
  throw new Error(`not a number item: ${item.k}`);
}

function plainNumber(item: CborItem | undefined): number {
  if (item === undefined || (item.k !== "uint" && item.k !== "nint" && item.k !== "float")) {
    throw new Error("expected a number item");
  }
  return item.v;
}

function plainText(item: CborItem | undefined): string {
  if (item?.k !== "text") {
    throw new Error("expected a text item");
  }
  return item.v;
}

function plainBytes(item: CborItem | undefined): Uint8Array {
  if (item?.k !== "bytes") {
    throw new Error("expected a bytes item");
  }
  return item.v;
}

function elements(item: CborItem): CborItem[] {
  if (item.k !== "array") {
    throw new Error("expected an array item");
  }
  return item.v;
}

function toPairs(items: CborItem[], blobs: BlobBytes): [Notation, Notation][] {
  const out: [Notation, Notation][] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    out.push([
      itemToNotation(items[i] as CborItem, blobs),
      itemToNotation(items[i + 1] as CborItem, blobs),
    ]);
  }
  return out;
}

/** Looks up the bytes of a blob by its SHA-256, for blob and file items. */
export type BlobBytes = (sha256: string) => Uint8Array;

const noBlobs: BlobBytes = () => {
  throw new Error("no blob bytes given");
};

/** A CBOR item of the value model back to test notation. The item must be valid (checked by the caller). */
export function itemToNotation(item: CborItem, blobs: BlobBytes = noBlobs): Notation {
  switch (item.k) {
    case "uint":
    case "nint":
    case "float":
      return itemNumber(item);
    case "text":
      return item.v;
    case "simple":
      return item.v === undefined ? { $: "undefined" } : item.v;
    case "bytes":
      return { $: "bytes", hex: bytesToHex(item.v) };
    case "array":
      return item.v.map((element) => itemToNotation(element, blobs));
    case "tag":
      return tagToNotation(item.tag, item.v, blobs);
    case "map":
      throw new Error("a map is not a value");
  }
}

function tagToNotation(t: number, content: CborItem, blobs: BlobBytes): Notation {
  const viewType = Object.keys(VIEW_TAGS).find((name) => VIEW_TAGS[name] === t);
  if (viewType !== undefined) {
    return { $: "view", type: viewType, hex: bytesToHex(plainBytes(content)) };
  }
  switch (t) {
    case 33102:
      return { $: "str16", hex: bytesToHex(plainBytes(content)) };
    case 33105:
      return { $: "bigint", v: plainText(content) };
    case 33101:
      return { $: "object", entries: toPairs(elements(content), blobs) };
    case 33103: {
      const [length, ...rest] = elements(content);
      return { $: "sparse", length: plainNumber(length), entries: toPairs(rest, blobs) };
    }
    case 33106:
      return { $: "map", entries: toPairs(elements(content), blobs) };
    case 33107:
      return {
        $: "set",
        items: elements(content).map((element) => itemToNotation(element, blobs)),
      };
    case 33104:
      return { $: "date", v: itemNumber(content) };
    case 33108:
      return { $: "boxed", v: itemToNotation(elements(content)[0] as CborItem, blobs) };
    case 21066: {
      const [source, flags] = elements(content);
      return {
        $: "regexp",
        source: itemToNotation(source as CborItem, blobs),
        flags: plainText(flags),
      };
    }
    case 33110:
      return partialViewToNotation(elements(content));
    case 33111: {
      const [type, , sha] = elements(content);
      return { $: "blob", type: plainText(type), hex: bytesToHex(blobs(plainText(sha))) };
    }
    case 33112: {
      const [name, lastModified, type, , sha] = elements(content);
      return {
        $: "file",
        name: plainText(name),
        lastModified: plainNumber(lastModified),
        type: plainText(type),
        hex: bytesToHex(blobs(plainText(sha))),
      };
    }
    default:
      throw new Error(`unknown tag ${t}`);
  }
}

function partialViewToNotation([viewTag, buffer, offset, length]: CborItem[]): Notation {
  const type =
    Object.keys(VIEW_TAGS).find((name) => VIEW_TAGS[name] === plainNumber(viewTag)) ?? "?";
  const bufferHex = bytesToHex(plainBytes(buffer));
  const byteOffset = plainNumber(offset);
  const count = plainNumber(length);
  const size = ELEMENT_SIZES[type] ?? 1;
  return {
    $: "view",
    type,
    hex: bufferHex.slice(byteOffset * 2, (byteOffset + count * size) * 2),
    bufferHex,
    byteOffset,
    length: count,
  };
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function keyString(n: Notation): string {
  return typeof n === "string" ? n : str16ToString(member(n as NotationObject, "hex"));
}

/** Test notation to the JavaScript value it describes (what structured clone would hand the exporter). */
export function notationToValue(n: Notation): unknown {
  if (typeof n === "string" || typeof n === "boolean" || typeof n === "number" || n === null) {
    return n;
  }
  if (Array.isArray(n)) {
    return n.map(notationToValue);
  }
  switch (n.$) {
    case "undefined":
      return undefined;
    case "f64":
      return f64FromHex(member(n, "hex"));
    case "str16":
      return str16ToString(member(n, "hex"));
    case "bigint":
      return BigInt(member<string>(n, "v"));
    case "object": {
      const target = {};
      for (const [k, v] of member<[Notation, Notation][]>(n, "entries")) {
        define(target, keyString(k), notationToValue(v));
      }
      return target;
    }
    case "sparse": {
      const target: unknown[] = new Array(member<number>(n, "length"));
      for (const [k, v] of member<[Notation, Notation][]>(n, "entries")) {
        define(target, keyString(k), notationToValue(v));
      }
      return target;
    }
    case "map":
      return new Map(
        member<[Notation, Notation][]>(n, "entries").map(([k, v]) => [
          notationToValue(k),
          notationToValue(v),
        ]),
      );
    case "set":
      return new Set(member<Notation[]>(n, "items").map(notationToValue));
    case "date":
      return new Date(notationToValue(member(n, "v")) as number);
    case "boxed":
      return Object(notationToValue(member(n, "v")));
    case "regexp":
      return new RegExp(notationToValue(member(n, "source")) as string, member<string>(n, "flags"));
    case "bytes":
      return hexToBytes(member(n, "hex")).buffer;
    case "view":
      return viewToValue(n);
    case "blob":
      return new Blob([hexToBytes(member(n, "hex"))], { type: member(n, "type") });
    case "file":
      return new File([hexToBytes(member(n, "hex"))], member(n, "name"), {
        type: member(n, "type"),
        lastModified: member(n, "lastModified"),
      });
    default:
      throw new Error(`unknown notation type ${n.$}`);
  }
}

function viewToValue(n: NotationObject): object {
  const type = member<string>(n, "type");
  const View = VIEW_CONSTRUCTORS[type];
  if (View === undefined) {
    throw new Error(`unknown view type ${type}`);
  }
  if (n.bufferHex === undefined) {
    return new View(hexToBytes(member(n, "hex")).buffer);
  }
  return new View(
    hexToBytes(member(n, "bufferHex")).buffer,
    member<number>(n, "byteOffset"),
    member<number>(n, "length"),
  );
}
