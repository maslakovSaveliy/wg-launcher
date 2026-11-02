// The shared vocabulary of the value model (snapshot-format.md section 6.3): CBOR item builders, the string encoding
// (text or tag 33102), array indexes and the view element sizes. `value-export.ts` turns values into items (`toItem`),
// `value-check.ts` checks decoded items (`checkValueItem`) and `value-build.ts` builds values back (`fromItem`). Web
// APIs only.
import { SnapError } from "../errors.js";
import { type CborItem, TAG } from "./cbor.js";

/** Element size in bytes by view tag (RFC 8746 tags and 33109 for DataView). */
export const VIEW_SIZES: ReadonlyMap<number, number> = new Map([
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
export const MAX_TIME = 8.64e15;

// --- item builders -------------------------------------------------------------------------------------------------

export const isIntegerNumber = (v: number) => Number.isSafeInteger(v) && !Object.is(v, -0);
export const numberItem = (n: number): CborItem =>
  isIntegerNumber(n) ? { k: n >= 0 ? "uint" : "nint", v: n } : { k: "float", v: n };
export const text = (v: string): CborItem => ({ k: "text", v });
export const bytes = (v: Uint8Array): CborItem => ({ k: "bytes", v });
export const array = (v: CborItem[]): CborItem => ({ k: "array", v });
export const tagged = (tag: number, v: CborItem): CborItem => ({ k: "tag", tag, v });

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

export function invalid(reason: string): never {
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

export function decodeStr16(content: CborItem): string {
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
