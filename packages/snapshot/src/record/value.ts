// The value model of snapshot-format.md section 6.3: JavaScript structured-clone values to CBOR items (`toItem`), the
// shape check a decoder runs on every value (`checkValueItem`) and items back to values (`fromItem`). Web APIs only.
import { ExportError, type PathSegment, SnapError } from "../errors.js";
import { type CborItem, MAX_DEPTH, TAG, TYPED_ARRAY_TAGS } from "./cbor.js";

/** Blob references met by `checkValueItem`: SHA-256 (hex) to size in bytes. */
export type BlobRefs = Map<string, number>;

export interface ToItemContext {
  /**
   * Receives the bytes of every Blob or File value, once per value. Two values with equal bytes give two calls with
   * the same hash: the caller deduplicates, because `blobs/<sha256>` is written once per snapshot.
   */
  onBlob(sha256: string, bytes: Uint8Array): void | Promise<void>;
  /** Deepest allowed item (default 256). The value root sits at depth 1, inside its `[key, value]` record. */
  maxDepth?: number;
}

type TypedArrayName = keyof typeof TYPED_ARRAY_TAGS;
type ViewConstructor = new (
  buffer: ArrayBuffer,
  byteOffset?: number,
  length?: number,
) => ArrayBufferView;

/** Element size in bytes by view tag (RFC 8746 tags and 33109 for DataView). */
const VIEW_SIZES: ReadonlyMap<number, number> = new Map([
  [64, 1],
  [68, 1],
  [72, 1],
  [69, 2],
  [77, 2],
  [70, 4],
  [78, 4],
  [71, 8],
  [79, 8],
  [84, 2],
  [85, 4],
  [86, 8],
  [TAG.dataView, 1],
]);
const VIEW_CONSTRUCTORS = new Map<number, ViewConstructor>([[TAG.dataView, DataView]]);
for (const [name, tag] of Object.entries(TYPED_ARRAY_TAGS)) {
  // Float16Array may be missing in an older engine, which then cannot build tag 84 values.
  const View = (globalThis as Record<string, unknown>)[name] as ViewConstructor | undefined;
  if (View !== undefined) {
    VIEW_CONSTRUCTORS.set(tag, View);
  }
}

const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayName = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, Symbol.toStringTag)
  ?.get as (this: unknown) => string | undefined;
const getter = (proto: object, name: string) =>
  Object.getOwnPropertyDescriptor(proto, name)?.get as (this: unknown) => unknown;
const regexpSource = getter(RegExp.prototype, "source") as (this: unknown) => string;
const dataViewLength = getter(DataView.prototype, "byteLength") as (this: unknown) => number;
const MAX_TIME = 8.64e15;

// --- item builders -------------------------------------------------------------------------------------------------

const isIntegerNumber = (v: number) => Number.isSafeInteger(v) && !Object.is(v, -0);
export const numberItem = (n: number): CborItem =>
  isIntegerNumber(n) ? { k: n >= 0 ? "uint" : "nint", v: n } : { k: "float", v: n };
const text = (v: string): CborItem => ({ k: "text", v });
const bytes = (v: Uint8Array): CborItem => ({ k: "bytes", v });
const array = (v: CborItem[]): CborItem => ({ k: "array", v });
const tagged = (tag: number, v: CborItem): CborItem => ({ k: "tag", tag, v });

export function stringItem(s: string): CborItem {
  if (s.isWellFormed()) {
    return text(s);
  }
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    out[i * 2] = unit & 0xff;
    out[i * 2 + 1] = unit >>> 8;
  }
  return tagged(TAG.str16, bytes(out));
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- toItem --------------------------------------------------------------------------------------------------------

class ValueExporter {
  /** Every object met so far: a second meeting is a shared reference or a cycle. */
  private readonly seen = new Set<object>();

  constructor(
    private readonly ctx: ToItemContext,
    private readonly maxDepth: number,
  ) {}

  private fail(
    code: "EXP_UNSUPPORTED_VALUE" | "EXP_SHARED_REFERENCE" | "EXP_TOO_DEEP",
    value: unknown,
    path: PathSegment[],
  ): never {
    const type = Object.prototype.toString.call(value);
    throw new ExportError(code, `${code} for ${type}`, {
      path: [...path],
      type,
    });
  }

  /** Children of a fixed-shape array (RegExp, views, Blob, File, sparse length) sit one level deeper. */
  private leaves(value: unknown, depth: number, path: PathSegment[]): void {
    if (depth + 1 > this.maxDepth) {
      this.fail("EXP_TOO_DEEP", value, path);
    }
  }

  private visit(value: object, path: PathSegment[]): void {
    if (this.seen.has(value)) {
      this.fail("EXP_SHARED_REFERENCE", value, path);
    }
    this.seen.add(value);
  }

  private brand<T>(read: () => T, value: unknown, path: PathSegment[]): T {
    try {
      return read();
    } catch {
      return this.fail("EXP_UNSUPPORTED_VALUE", value, path);
    }
  }

  async item(value: unknown, depth: number, path: PathSegment[]): Promise<CborItem> {
    if (depth > this.maxDepth) {
      this.fail("EXP_TOO_DEEP", value, path);
    }
    switch (typeof value) {
      case "undefined":
        return { k: "simple", v: undefined };
      case "boolean":
        return { k: "simple", v: value };
      case "number":
        return numberItem(value);
      case "string":
        return stringItem(value);
      case "bigint":
        return tagged(TAG.bigint, text(value.toString()));
      case "object":
        if (value === null) {
          return { k: "simple", v: null };
        }
        this.visit(value, path);
        return this.object(value, depth, path);
      default:
        return this.fail("EXP_UNSUPPORTED_VALUE", value, path);
    }
  }

  private async pairs(
    entries: [string, unknown][],
    depth: number,
    path: PathSegment[],
    numeric: boolean,
  ) {
    const out: CborItem[] = [];
    for (const [key, child] of entries) {
      const index = numeric ? arrayIndex(key) : -1;
      out.push(
        stringItem(key),
        await this.item(child, depth + 1, [...path, index >= 0 ? index : key]),
      );
    }
    return out;
  }

  private async object(value: object, depth: number, path: PathSegment[]): Promise<CborItem> {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto === Object.prototype || proto === null) {
      // Own enumerable string-keyed properties only, as structured clone copies them: symbols are ignored.
      return tagged(TAG.object, array(await this.pairs(Object.entries(value), depth, path, false)));
    }
    if (proto === Array.prototype && Array.isArray(value)) {
      return this.array(value, depth, path);
    }
    if (proto === Date.prototype) {
      return tagged(
        TAG.date,
        numberItem(this.brand(() => Date.prototype.getTime.call(value), value, path)),
      );
    }
    if (proto === Map.prototype) {
      const entries = this.brand(() => [...Map.prototype.entries.call(value)], value, path);
      const out: CborItem[] = [];
      for (const [i, [key, child]] of entries.entries()) {
        out.push(await this.item(key, depth + 1, [...path, i, "key"]));
        out.push(await this.item(child, depth + 1, [...path, i, "value"]));
      }
      return tagged(TAG.map, array(out));
    }
    if (proto === Set.prototype) {
      const items = this.brand(() => [...Set.prototype.values.call(value)], value, path);
      const out: CborItem[] = [];
      for (const [i, child] of items.entries()) {
        out.push(await this.item(child, depth + 1, [...path, i]));
      }
      return tagged(TAG.set, array(out));
    }
    if (proto === RegExp.prototype) {
      const source = this.brand(() => regexpSource.call(value), value, path);
      this.leaves(value, depth, path);
      return tagged(TAG.regexp, array([stringItem(source), text((value as RegExp).flags)]));
    }
    const isFile = typeof File !== "undefined" && proto === File.prototype;
    if (isFile || proto === Blob.prototype) {
      return this.blob(value as Blob, isFile, depth, path);
    }
    return this.binaryOrBoxed(value, proto, depth, path);
  }

  private async array(value: unknown[], depth: number, path: PathSegment[]): Promise<CborItem> {
    const keys = Object.keys(value);
    if (keys.length === value.length && keys.every((key, i) => key === String(i))) {
      const out: CborItem[] = [];
      for (let i = 0; i < value.length; i++) {
        out.push(await this.item(value[i], depth + 1, [...path, i]));
      }
      return array(out);
    }
    this.leaves(value, depth, path);
    const entries = keys.map((key): [string, unknown] => [
      key,
      (value as unknown as Record<string, unknown>)[key],
    ]);
    return tagged(
      TAG.sparseArray,
      array([numberItem(value.length), ...(await this.pairs(entries, depth, path, true))]),
    );
  }

  private binaryOrBoxed(
    value: object,
    proto: object | null,
    depth: number,
    path: PathSegment[],
  ): CborItem {
    const boxed = boxedPrimitive(value, proto);
    if (boxed !== undefined) {
      this.leaves(value, depth, path);
      return tagged(TAG.boxed, array([boxed]));
    }
    if (proto === ArrayBuffer.prototype) {
      const buffer = value as ArrayBuffer;
      if (this.brand(() => buffer.resizable, value, path)) {
        this.fail("EXP_UNSUPPORTED_VALUE", value, path);
      }
      return bytes(new Uint8Array(buffer).slice());
    }
    const name = typedArrayName.call(value) as TypedArrayName | undefined;
    const isTypedArray =
      name !== undefined &&
      proto === (globalThis as unknown as Record<string, { prototype: object }>)[name]?.prototype;
    if (isTypedArray) {
      return this.view(value as ArrayBufferView, TYPED_ARRAY_TAGS[name], depth, path);
    }
    if (proto === DataView.prototype) {
      this.brand(() => dataViewLength.call(value), value, path);
      return this.view(value as DataView, TAG.dataView, depth, path);
    }
    return this.fail("EXP_UNSUPPORTED_VALUE", value, path);
  }

  private view(
    view: ArrayBufferView,
    viewTag: number,
    depth: number,
    path: PathSegment[],
  ): CborItem {
    const buffer = view.buffer;
    if (
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
      (buffer as ArrayBuffer).resizable
    ) {
      this.fail("EXP_UNSUPPORTED_VALUE", view, path);
    }
    // The buffer is an object of its own: a second view of it, or the buffer itself elsewhere, is shared.
    this.visit(buffer, path);
    const content = new Uint8Array(buffer).slice();
    if (view.byteOffset === 0 && view.byteLength === buffer.byteLength) {
      return tagged(viewTag, bytes(content));
    }
    this.leaves(view, depth, path);
    const length = viewTag === TAG.dataView ? view.byteLength : (view as Uint8Array).length;
    return tagged(
      TAG.partialView,
      array([numberItem(viewTag), bytes(content), numberItem(view.byteOffset), numberItem(length)]),
    );
  }

  private async blob(
    blob: Blob,
    isFile: boolean,
    depth: number,
    path: PathSegment[],
  ): Promise<CborItem> {
    this.leaves(blob, depth, path);
    let content: Uint8Array<ArrayBuffer>;
    try {
      content = new Uint8Array(await blob.arrayBuffer());
    } catch {
      return this.fail("EXP_UNSUPPORTED_VALUE", blob, path);
    }
    const sha256 = await sha256Hex(content);
    await this.ctx.onBlob(sha256, content);
    const tail = [text(blob.type), numberItem(content.length), text(sha256)];
    if (isFile) {
      const file = blob as File;
      return tagged(TAG.file, array([text(file.name), numberItem(file.lastModified), ...tail]));
    }
    return tagged(TAG.blob, array(tail));
  }
}

function boxedPrimitive(value: object, proto: object | null): CborItem | undefined {
  // valueOf of the matching prototype throws on anything but a real wrapper object.
  try {
    if (proto === Boolean.prototype) {
      return { k: "simple", v: Boolean.prototype.valueOf.call(value) };
    }
    if (proto === Number.prototype) {
      return numberItem(Number.prototype.valueOf.call(value));
    }
    if (proto === String.prototype) {
      return stringItem(String.prototype.valueOf.call(value));
    }
    if (proto === BigInt.prototype) {
      return tagged(TAG.bigint, text(BigInt.prototype.valueOf.call(value).toString()));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** JS value to item (snapshot-format.md section 6.3). Unsupported values throw `ExportError`, never get dropped. */
export function toItem(value: unknown, ctx: ToItemContext): Promise<CborItem> {
  return new ValueExporter(ctx, ctx.maxDepth ?? MAX_DEPTH).item(value, 1, []);
}

// --- checkValueItem ------------------------------------------------------------------------------------------------

function invalid(reason: string): never {
  throw new SnapError("SNAP_RECORD_INVALID", `value ${reason}`);
}

/** The array index a property key names (canonical decimal up to 2^32 - 2), or -1. */
export function arrayIndex(key: string): number {
  if (key.length > 10 || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
    return -1;
  }
  const n = Number(key);
  return n <= 0xfffffffe ? n : -1;
}

function decodeStr16(content: CborItem): string {
  if (content.k !== "bytes" || content.v.length % 2 !== 0) {
    invalid("tag 33102 needs an even-length byte string");
  }
  let s = "";
  for (let i = 0; i < content.v.length; i += 2) {
    s += String.fromCharCode((content.v[i] as number) | ((content.v[i + 1] as number) << 8));
  }
  if (s.isWellFormed()) {
    invalid("tag 33102 holds a well-formed string, which must be a text string");
  }
  return s;
}

/** The string an item in the string encoding (text or tag 33102) holds, or undefined. */
export function stringOf(item: CborItem | undefined): string | undefined {
  if (item?.k === "text") {
    return item.v;
  }
  return item?.k === "tag" && item.tag === TAG.str16 ? decodeStr16(item.v) : undefined;
}

function elementsOf(item: CborItem, what: string): CborItem[] {
  if (item.k !== "array") {
    invalid(`${what} content must be an array`);
  }
  return item.v;
}

const uintOf = (item: CborItem | undefined, what: string): number =>
  item?.k === "uint" ? item.v : invalid(`${what} must be an unsigned integer`);

/** Property keys must enumerate as JavaScript would rebuild them: array indexes ascending, then the others. */
function checkKeys(items: CborItem[], length: number | undefined): void {
  const seen = new Set<string>();
  let lastIndex = -1;
  let named = false;
  for (let i = 0; i < items.length; i += 2) {
    const key = stringOf(items[i]) ?? invalid("property key must be a string");
    const index = arrayIndex(key);
    if (seen.has(key) || (index >= 0 && (named || index <= lastIndex))) {
      invalid("property keys are duplicated or not in enumeration order");
    }
    if (length !== undefined && (key === "length" || index >= length)) {
      invalid("sparse array key is length or an index past the length");
    }
    seen.add(key);
    named ||= index < 0;
    lastIndex = Math.max(lastIndex, index);
  }
}

/** Identity of a primitive Map key or Set item under SameValueZero, or undefined for an object. */
function primitiveIdentity(item: CborItem): string | undefined {
  if (item.k === "float" && Object.is(item.v, -0)) {
    invalid("a Map key or Set item cannot be -0 (Map and Set store +0)");
  }
  if (item.k === "uint" || item.k === "nint" || item.k === "float") {
    return `n${item.v}`;
  }
  if (item.k === "simple") {
    return `p${item.v}`;
  }
  const s = stringOf(item);
  if (s !== undefined) {
    return `s${s}`;
  }
  return item.k === "tag" && item.tag === TAG.bigint && item.v.k === "text"
    ? `b${item.v.v}`
    : undefined;
}

function checkUnique(items: CborItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = primitiveIdentity(item);
    if (id !== undefined && seen.has(id)) {
      invalid("Map keys or Set items are duplicated");
    }
    if (id !== undefined) {
      seen.add(id);
    }
  }
}

function checkPairs(items: CborItem[], refs: BlobRefs): void {
  if (items.length % 2 !== 0) {
    invalid("pair list has an odd length");
  }
  for (const item of items) {
    checkValue(item, refs);
  }
}

function checkRegExp([source, flags, ...rest]: CborItem[]): void {
  const s = stringOf(source);
  if (s === undefined || flags?.k !== "text" || rest.length > 0) {
    invalid("RegExp must be [source, flags]");
  }
  let re: RegExp | undefined;
  try {
    re = new RegExp(s, flags.v);
  } catch {
    invalid("RegExp source or flags do not parse");
  }
  if (re.source !== s || re.flags !== flags.v) {
    invalid("RegExp source or flags are not in their canonical form");
  }
}

function checkPartialView([viewTag, buffer, offset, length, ...rest]: CborItem[]): void {
  const size = VIEW_SIZES.get(uintOf(viewTag, "view tag"));
  const byteOffset = uintOf(offset, "byteOffset");
  const byteLength = uintOf(length, "length") * (size ?? 1);
  if (size === undefined || buffer?.k !== "bytes" || rest.length > 0 || byteOffset % size !== 0) {
    invalid("partial view must be [viewTag, bytes, byteOffset, length] with an aligned offset");
  }
  if (
    byteOffset + byteLength > buffer.v.length ||
    (byteOffset === 0 && byteLength === buffer.v.length)
  ) {
    invalid("partial view must lie inside its buffer and not cover all of it");
  }
}

function checkBlob(items: CborItem[], refs: BlobRefs): void {
  const isFile = items.length === 5;
  const [type, size, sha] = isFile ? items.slice(2) : items;
  if (isFile && (items[0]?.k !== "text" || (items[1]?.k !== "uint" && items[1]?.k !== "nint"))) {
    invalid("File name must be text and lastModified an integer");
  }
  if (type?.k !== "text" || !/^[\x20-\x40\x5b-\x7e]*$/.test(type.v)) {
    invalid("Blob type must be lowercase printable ASCII");
  }
  const bytesSize = uintOf(size, "Blob size");
  if (sha?.k !== "text" || !/^[0-9a-f]{64}$/.test(sha.v)) {
    invalid("Blob hash must be 64 lowercase hex digits");
  }
  if ((refs.get(sha.v) ?? bytesSize) !== bytesSize) {
    invalid("one blob hash is referenced with two sizes");
  }
  refs.set(sha.v, bytesSize);
}

function isTimeValue(item: CborItem): boolean {
  if (item.k === "float") {
    return Number.isNaN(item.v);
  }
  return (item.k === "uint" || item.k === "nint") && Math.abs(item.v) <= MAX_TIME;
}

/** A boolean, number, string (text or tag 33102) or BigInt: what a Boolean, Number, String or BigInt object wraps. */
function isPrimitiveItem(item: CborItem): boolean {
  switch (item.k) {
    case "simple":
      return typeof item.v === "boolean";
    case "uint":
    case "nint":
    case "float":
    case "text":
      return true;
    case "tag":
      return item.tag === TAG.str16 || item.tag === TAG.bigint;
    default:
      return false;
  }
}

function checkTag(tag: number, content: CborItem, refs: BlobRefs): void {
  const size = VIEW_SIZES.get(tag);
  if (size !== undefined) {
    if (content.k !== "bytes" || content.v.length % size !== 0) {
      invalid("typed array bytes must be a whole number of elements");
    }
    return;
  }
  switch (tag) {
    case TAG.str16:
      decodeStr16(content);
      return;
    case TAG.bigint:
      if (content.k !== "text" || !/^(?:0|-?[1-9][0-9]*)$/.test(content.v)) {
        invalid("BigInt must be canonical decimal text");
      }
      return;
    case TAG.date:
      if (!isTimeValue(content)) {
        invalid("Date must hold NaN or an integer time value within 8.64e15");
      }
      return;
    case TAG.object:
    case TAG.sparseArray: {
      const items = elementsOf(content, "object");
      const length = tag === TAG.sparseArray ? uintOf(items[0], "sparse array length") : undefined;
      const pairs = length === undefined ? items : items.slice(1);
      checkPairs(pairs, refs);
      checkKeys(pairs, length);
      if (length !== undefined && length > 0xffffffff) {
        invalid("sparse array length is above 2^32 - 1");
      }
      if (
        length !== undefined &&
        pairs.length / 2 === length &&
        pairs.every((p, i) => i % 2 === 1 || arrayIndex(stringOf(p) as string) >= 0)
      ) {
        invalid("a dense array must be a plain array");
      }
      return;
    }
    case TAG.map: {
      const items = elementsOf(content, "Map");
      checkPairs(items, refs);
      checkUnique(items.filter((_, i) => i % 2 === 0));
      return;
    }
    case TAG.set:
      for (const item of elementsOf(content, "Set")) {
        checkValue(item, refs);
      }
      checkUnique(elementsOf(content, "Set"));
      return;
    case TAG.boxed: {
      const items = elementsOf(content, "boxed");
      const [inner] = items;
      if (items.length !== 1 || inner === undefined || !isPrimitiveItem(inner)) {
        invalid("boxed must wrap one boolean, number, string or BigInt");
      }
      checkValue(inner, refs);
      return;
    }
    case TAG.regexp:
      checkRegExp(elementsOf(content, "RegExp"));
      return;
    case TAG.partialView:
      checkPartialView(elementsOf(content, "partial view"));
      return;
    case TAG.blob:
    case TAG.file: {
      const items = elementsOf(content, "Blob");
      if (items.length !== (tag === TAG.file ? 5 : 3)) {
        invalid("Blob or File has the wrong number of members");
      }
      checkBlob(items, refs);
      return;
    }
    default:
      invalid(`tag ${tag} is not a value tag`);
  }
}

function checkValue(item: CborItem, refs: BlobRefs): void {
  switch (item.k) {
    case "array":
      for (const element of item.v) {
        checkValue(element, refs);
      }
      return;
    case "map":
      invalid("is a map; maps appear only in envelopes");
      break;
    case "tag":
      checkTag(item.tag, item.v, refs);
      return;
    case "float":
      if (isIntegerNumber(item.v)) {
        invalid("float holds a safe integer");
      }
      return;
    case "text":
      if (!item.v.isWellFormed()) {
        invalid("text is not well-formed");
      }
      return;
    default:
      return;
  }
}

/**
 * Checks the tags and shapes of section 6.3 on a decoded item, so that every value has exactly one encoding, and
 * records each referenced blob (SHA-256 to size) into `refs` for the container's blob check (section 7.4).
 */
export function checkValueItem(item: CborItem, refs: BlobRefs): void {
  checkValue(item, refs);
}

// --- fromItem ------------------------------------------------------------------------------------------------------

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function viewBuffer(content: CborItem): ArrayBuffer {
  return (content as { v: Uint8Array }).v.slice().buffer as ArrayBuffer;
}

function buildTag(tag: number, content: CborItem, blobs: (sha256: string) => Blob): unknown {
  const View = VIEW_CONSTRUCTORS.get(tag);
  if (View !== undefined) {
    return new View(viewBuffer(content));
  }
  if (VIEW_SIZES.has(tag)) {
    throw new TypeError(`this engine has no constructor for view tag ${tag}`);
  }
  if (tag === TAG.str16 || tag === TAG.bigint) {
    return tag === TAG.str16 ? decodeStr16(content) : BigInt((content as { v: string }).v);
  }
  if (tag === TAG.date) {
    return new Date((content as { v: number }).v);
  }
  const items = (content as { v: CborItem[] }).v;
  const build = (item: CborItem | undefined) => buildValue(item as CborItem, blobs);
  switch (tag) {
    case TAG.object:
    case TAG.sparseArray: {
      const sparse = tag === TAG.sparseArray;
      const target: object = sparse ? new Array((items[0] as { v: number }).v) : {};
      for (let i = sparse ? 1 : 0; i < items.length; i += 2) {
        define(target, stringOf(items[i]) as string, build(items[i + 1]));
      }
      return target;
    }
    case TAG.map:
      return new Map(
        items.filter((_, i) => i % 2 === 0).map((key, i) => [build(key), build(items[i * 2 + 1])]),
      );
    case TAG.set:
      return new Set(items.map(build));
    case TAG.boxed:
      return Object(build(items[0]));
    case TAG.regexp:
      return new RegExp(stringOf(items[0]) as string, (items[1] as { v: string }).v);
    case TAG.partialView: {
      const [viewTag, , offset, length] = items.map((item) => (item as { v: number }).v);
      const PartialView = VIEW_CONSTRUCTORS.get(viewTag as number);
      if (PartialView === undefined) {
        throw new TypeError(`this engine has no constructor for view tag ${viewTag}`);
      }
      return new PartialView(viewBuffer(items[1] as CborItem), offset, length);
    }
    default: {
      const [first, second, type, size, sha] =
        tag === TAG.file ? items : [undefined, undefined, ...items];
      const content = blobs((sha as { v: string }).v);
      if (content.size !== (size as { v: number }).v) {
        throw new SnapError("SNAP_RECORD_INVALID", "blob bytes differ in size from the reference");
      }
      const options = { type: (type as { v: string }).v };
      return tag === TAG.file
        ? new File([content], (first as { v: string }).v, {
            ...options,
            lastModified: (second as { v: number }).v,
          })
        : new Blob([content], options);
    }
  }
}

function buildValue(item: CborItem, blobs: (sha256: string) => Blob): unknown {
  switch (item.k) {
    case "bytes":
      return item.v.slice().buffer;
    case "array":
      return item.v.map((element) => buildValue(element, blobs));
    case "tag":
      return buildTag(item.tag, item.v, blobs);
    case "map":
      return invalid("is a map");
    default:
      return item.v;
  }
}

/** Item to JS value. Checks the item first (`checkValueItem`); `blobs` returns the bytes of `blobs/<sha256>`. */
export function fromItem(item: CborItem, blobs: (sha256: string) => Blob): unknown {
  checkValueItem(item, new Map());
  return buildValue(item, blobs);
}
