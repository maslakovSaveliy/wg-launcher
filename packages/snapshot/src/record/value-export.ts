// JavaScript structured-clone values to CBOR items (snapshot-format.md section 6.3). Unsupported values throw
// ExportError with the property path, never get dropped. Web APIs only.
import { ExportError, type PathSegment } from "../errors.js";
import { type CborItem, MAX_DEPTH, TAG, TYPED_ARRAY_TAGS } from "./cbor.js";
import {
  array,
  arrayIndex,
  bytes,
  isIntegerNumber,
  numberItem,
  stringItem,
  tagged,
  text,
} from "./value.js";

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

const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayName = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, Symbol.toStringTag)
  ?.get as (this: unknown) => string | undefined;
const getter = (proto: object, name: string) =>
  Object.getOwnPropertyDescriptor(proto, name)?.get as (this: unknown) => unknown;
const regexpSource = getter(RegExp.prototype, "source") as (this: unknown) => string;
const dataViewLength = getter(DataView.prototype, "byteLength") as (this: unknown) => number;

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
    reason?: string,
  ): never {
    const type = Object.prototype.toString.call(value);
    const detail = { path: [...path], type, ...(reason === undefined ? {} : { reason }) };
    const why = reason === undefined ? "" : ` (${reason})`;
    throw new ExportError(code, `${code} for ${type}${why}`, detail);
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
    // lastModified is written as an integer; -0 or an unsafe value would be a float, which the reader refuses.
    if (isFile && !isIntegerNumber((blob as File).lastModified)) {
      this.fail("EXP_UNSUPPORTED_VALUE", blob, path, "lastModified is not a safe integer");
    }
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
