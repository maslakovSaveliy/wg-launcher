// The data files of snapshot-format.md section 7: `local-storage.cbor` (7.1), `schema.cbor` (7.2) and
// `store-<s>.cbor` (7.3). Encoders sort and refuse what a decoder would reject; decoders refuse every other encoding
// with SNAP_RECORD_INVALID. Web APIs only.
import { SnapError } from "../errors.js";
import { type CborItem, type DecodeOptions, decodeSequence, encodeItem } from "./cbor.js";
import { compareIdbKeys, type IdbKey, keyFromItem, keyToItem } from "./idb-key.js";
import { numberItem, stringItem, stringOf } from "./value.js";
import { type BlobRefs, checkValueItem } from "./value-check.js";

export type KeyPath = string | string[];

export interface IndexSchema {
  name: string;
  keyPath: KeyPath;
  unique: boolean;
  multiEntry: boolean;
}

export interface StoreSchema {
  name: string;
  keyPath: KeyPath | null;
  autoIncrement: boolean;
  /** The generator's current number (section 7.5), `null` unless `autoIncrement`. */
  keyGenerator: number | null;
  indexes: IndexSchema[];
  /** Number of records in `store-<s>.cbor`. */
  records: number;
}

export interface DbSchema {
  name: string;
  version: number;
  stores: StoreSchema[];
}

/** One decoded record. The value is a checked item; `fromItem` turns it into a JS value. */
export interface StoreRecord {
  key: IdbKey;
  value: CborItem;
}

function invalid(reason: string): never {
  throw new SnapError("SNAP_RECORD_INVALID", reason);
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function pair(item: CborItem): [CborItem, CborItem] {
  if (item.k !== "array" || item.v.length !== 2) {
    invalid("a data file item must be a [key, value] pair");
  }
  return item.v as [CborItem, CborItem];
}

// --- local-storage.cbor ------------------------------------------------------------------------------------------

/** Sorted `[key, value]` pairs; `null` when there are none, because the file is then absent. */
export function encodeLocalStorage(items: Iterable<readonly [string, string]>): Uint8Array | null {
  const sorted = [...items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length === 0) {
    return null;
  }
  return concat(
    sorted.map(([key, value], i) => {
      if (i > 0 && sorted[i - 1]?.[0] === key) {
        throw new TypeError("duplicate localStorage key");
      }
      return encodeItem({ k: "array", v: [stringItem(key), stringItem(value)] });
    }),
  );
}

export function decodeLocalStorage(bytes: Uint8Array, options?: DecodeOptions): [string, string][] {
  const items = decodeSequence(bytes, options);
  if (items.length === 0) {
    invalid("local-storage.cbor is empty; an empty localStorage has no file");
  }
  let previous: string | undefined;
  return items.map((item): [string, string] => {
    const [k, v] = pair(item);
    const key = stringOf(k) ?? invalid("localStorage key must be a string");
    if (previous !== undefined && !(previous < key)) {
      invalid("localStorage keys are not strictly ascending");
    }
    previous = key;
    return [key, stringOf(v) ?? invalid("localStorage value must be a string")];
  });
}

// --- schema.cbor -------------------------------------------------------------------------------------------------

const nullItem: CborItem = { k: "simple", v: null };
const bool = (v: boolean): CborItem => ({ k: "simple", v });

function keyPathItem(path: KeyPath | null): CborItem {
  if (path === null) {
    return nullItem;
  }
  return typeof path === "string" ? stringItem(path) : { k: "array", v: path.map(stringItem) };
}

function storeItem(store: StoreSchema): CborItem {
  const indexes = [...store.indexes].sort(byName).map(
    (index): CborItem => ({
      k: "map",
      v: [
        ["name", stringItem(index.name)],
        ["keyPath", keyPathItem(index.keyPath)],
        ["unique", bool(index.unique)],
        ["multiEntry", bool(index.multiEntry)],
      ],
    }),
  );
  return {
    k: "map",
    v: [
      ["name", stringItem(store.name)],
      ["keyPath", keyPathItem(store.keyPath)],
      ["autoIncrement", bool(store.autoIncrement)],
      ["keyGenerator", store.keyGenerator === null ? nullItem : numberItem(store.keyGenerator)],
      ["indexes", { k: "array", v: indexes }],
      ["records", numberItem(store.records)],
    ],
  };
}

/** The envelope map of section 7.2, stores and indexes sorted by name. Throws TypeError on an invalid schema. */
export function encodeSchema(schema: DbSchema): Uint8Array {
  const stores = [...schema.stores].sort(byName).map(storeItem);
  const bytes = encodeItem({
    k: "map",
    v: [
      ["name", stringItem(schema.name)],
      ["version", numberItem(schema.version)],
      ["stores", { k: "array", v: stores }],
    ],
  });
  try {
    decodeSchema(bytes); // a conforming writer never writes what the reader refuses
  } catch (error) {
    throw new TypeError(`invalid IndexedDB schema: ${(error as Error).message}`);
  }
  return bytes;
}

/** The members of an envelope map, which must be exactly `names`. */
function members(item: CborItem | undefined, names: string[], what: string): Map<string, CborItem> {
  if (item?.k !== "map" || item.v.length !== names.length) {
    invalid(`${what} must be a map with exactly ${names.join(", ")}`);
  }
  const found = new Map(item.v);
  if (!names.every((name) => found.has(name))) {
    invalid(`${what} must be a map with exactly ${names.join(", ")}`);
  }
  return found;
}

const get = (m: Map<string, CborItem>, name: string) => m.get(name) as CborItem;

function nameOf(item: CborItem, what: string): string {
  return stringOf(item) ?? invalid(`${what} name must be a string`);
}

function boolOf(item: CborItem, what: string): boolean {
  return item.k === "simple" && typeof item.v === "boolean"
    ? item.v
    : invalid(`${what} must be a boolean`);
}

function countOf(item: CborItem, min: number, what: string): number {
  return item.k === "uint" && item.v >= min
    ? item.v
    : invalid(`${what} must be an integer >= ${min}`);
}

// IndexedDB's "valid key path" string: "", or ECMAScript IdentifierNames joined by single dots. A key path IndexedDB
// refuses could never be created on restore, so the reader refuses it while validating (before anything is written).
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;
const isKeyPathString = (path: string) =>
  path === "" || path.split(".").every((p) => IDENTIFIER.test(p));

function keyPathOf(item: CborItem, nullable: boolean): KeyPath | null {
  if (item.k === "simple" && item.v === null && nullable) {
    return null;
  }
  const path =
    item.k === "array" && item.v.length > 0
      ? item.v.map((element) => stringOf(element) ?? invalid("key path entries must be strings"))
      : (stringOf(item) ?? invalid("key path must be a string or a non-empty array of strings"));
  if (!(typeof path === "string" ? [path] : path).every(isKeyPathString)) {
    invalid("key path is not a valid IndexedDB key path");
  }
  return path;
}

function keyGeneratorOf(item: CborItem, autoIncrement: boolean): number | null {
  if (!autoIncrement) {
    return item.k === "simple" && item.v === null
      ? null
      : invalid("keyGenerator without autoIncrement");
  }
  // The current number is an integer from 1 to 2^53; 2^53 is not a safe integer, so it is a float (rule 3).
  const ok = (item.k === "uint" && item.v >= 1) || (item.k === "float" && item.v === 2 ** 53);
  return ok ? (item as { v: number }).v : invalid("keyGenerator must be an integer from 1 to 2^53");
}

function sortedByName<T extends { name: string }>(list: T[], what: string): T[] {
  for (let i = 1; i < list.length; i++) {
    if (!((list[i - 1] as T).name < (list[i] as T).name)) {
      invalid(`${what} are not strictly ascending by name`);
    }
  }
  return list;
}

function listOf(item: CborItem, what: string): CborItem[] {
  return item.k === "array" ? item.v : invalid(`${what} must be an array`);
}

function indexOf(item: CborItem): IndexSchema {
  const m = members(item, ["name", "keyPath", "unique", "multiEntry"], "index");
  const keyPath = keyPathOf(get(m, "keyPath"), false) as KeyPath;
  const multiEntry = boolOf(get(m, "multiEntry"), "multiEntry");
  if (multiEntry && Array.isArray(keyPath)) {
    invalid("a multiEntry index cannot have an array key path");
  }
  return {
    name: nameOf(get(m, "name"), "index"),
    keyPath,
    unique: boolOf(get(m, "unique"), "unique"),
    multiEntry,
  };
}

function storeOf(item: CborItem): StoreSchema {
  const names = ["name", "keyPath", "autoIncrement", "keyGenerator", "indexes", "records"];
  const m = members(item, names, "store");
  const autoIncrement = boolOf(get(m, "autoIncrement"), "autoIncrement");
  const keyPath = keyPathOf(get(m, "keyPath"), true);
  // createObjectStore refuses autoIncrement with an empty or an array key path (InvalidAccessError).
  if (autoIncrement && (keyPath === "" || Array.isArray(keyPath))) {
    invalid("an autoIncrement store cannot have an empty or an array key path");
  }
  return {
    name: nameOf(get(m, "name"), "store"),
    keyPath,
    autoIncrement,
    keyGenerator: keyGeneratorOf(get(m, "keyGenerator"), autoIncrement),
    indexes: sortedByName(listOf(get(m, "indexes"), "indexes").map(indexOf), "indexes"),
    records: countOf(get(m, "records"), 0, "records"),
  };
}

export function decodeSchema(bytes: Uint8Array, options?: DecodeOptions): DbSchema {
  const items = decodeSequence(bytes, options);
  if (items.length !== 1) {
    invalid("schema.cbor must hold exactly one envelope");
  }
  const m = members(items[0], ["name", "version", "stores"], "schema");
  return {
    name: nameOf(get(m, "name"), "database"),
    version: countOf(get(m, "version"), 1, "version"),
    stores: sortedByName(listOf(get(m, "stores"), "stores").map(storeOf), "stores"),
  };
}

// --- store-<s>.cbor ----------------------------------------------------------------------------------------------

/**
 * One `[primaryKey, value]` record. A store file is a CBOR sequence, so records encoded one at a time in strictly
 * ascending key order and concatenated are byte-identical to `encodeStoreRecords` of the whole store (Ruling R6); the
 * exporter uses this to keep memory bounded. A key that is not a key is ExportError.
 */
export function encodeStoreRecord(key: IdbKey, value: CborItem): Uint8Array {
  return encodeItem({ k: "array", v: [keyToItem(key), value] });
}

/** Records sorted by IndexedDB key order. A key that is not a key is ExportError; a duplicate key is TypeError. */
export function encodeStoreRecords(records: Iterable<readonly [IdbKey, CborItem]>): Uint8Array {
  const sorted = [...records].sort(([a], [b]) => compareIdbKeys(a, b));
  return concat(
    sorted.map(([key, value], i) => {
      if (i > 0 && compareIdbKeys((sorted[i - 1] as [IdbKey, CborItem])[0], key) === 0) {
        throw new TypeError("duplicate record key");
      }
      return encodeStoreRecord(key, value);
    }),
  );
}

/** Decodes and checks every record; blob references of the values are added to `refs`. */
export function decodeStoreRecords(
  bytes: Uint8Array,
  refs: BlobRefs,
  options?: DecodeOptions,
): StoreRecord[] {
  let previous: IdbKey | undefined;
  return decodeSequence(bytes, options).map((item) => {
    const [k, value] = pair(item);
    const key = keyFromItem(k);
    if (previous !== undefined && compareIdbKeys(previous, key) >= 0) {
      invalid("record keys are not strictly ascending");
    }
    previous = key;
    checkValueItem(value, refs);
    return { key, value };
  });
}
