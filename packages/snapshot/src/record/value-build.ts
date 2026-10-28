// CBOR items back to JavaScript values (snapshot-format.md section 6.3). Every item is checked first. Web APIs only.
import { SnapError } from "../errors.js";
import { type CborItem, TAG, TYPED_ARRAY_TAGS } from "./cbor.js";
import { decodeStr16, invalid, stringOf, VIEW_SIZES } from "./value.js";
import { checkValueItem } from "./value-check.js";

type ViewConstructor = new (
  buffer: ArrayBuffer,
  byteOffset?: number,
  length?: number,
) => ArrayBufferView;

const VIEW_CONSTRUCTORS = new Map<number, ViewConstructor>([[TAG.dataView, DataView]]);
for (const [name, tag] of Object.entries(TYPED_ARRAY_TAGS)) {
  // Float16Array may be missing in an older engine, which then cannot build tag 84 values.
  const View = (globalThis as Record<string, unknown>)[name] as ViewConstructor | undefined;
  if (View !== undefined) {
    VIEW_CONSTRUCTORS.set(tag, View);
  }
}

function buildRegExp(source: string, flags: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch {
    throw new SnapError("SNAP_RECORD_INVALID", "RegExp does not compile in this engine");
  }
}

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
      return buildRegExp(stringOf(items[0]) as string, (items[1] as { v: string }).v);
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
