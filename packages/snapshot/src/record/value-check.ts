// The shape check a decoder runs on every value item (snapshot-format.md section 6.3), so that every value has exactly
// one encoding, and the blob references it meets (section 7.4). Web APIs only.
import { type CborItem, TAG } from "./cbor.js";
import {
  arrayIndex,
  decodeStr16,
  invalid,
  isIntegerNumber,
  MAX_TIME,
  stringOf,
  VIEW_SIZES,
} from "./value.js";

/** Blob references met by `checkValueItem`: SHA-256 (hex) to size in bytes. */
export type BlobRefs = Map<string, number>;

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

// Flags in the order of RegExp.prototype.flags, each at most once, never both u and v. The source is stored as the
// exporting engine wrote it and is not canonicalized or compiled here: that would make validity engine-defined.
const REGEXP_FLAGS = /^d?g?i?m?s?u?v?y?$/;

function checkRegExp([source, flags, ...rest]: CborItem[]): void {
  if (stringOf(source) === undefined || flags?.k !== "text" || rest.length > 0) {
    invalid("RegExp must be [source, flags]");
  }
  if (!REGEXP_FLAGS.test(flags.v) || (flags.v.includes("u") && flags.v.includes("v"))) {
    invalid("RegExp flags must be an ordered subset of dgimsuvy without both u and v");
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
