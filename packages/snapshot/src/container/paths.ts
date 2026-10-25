// The regular-file paths of formatVersion 1 (snapshot-format.md section 3.2). Indexes are decimal without leading
// zeros; `k` must name one of the manifest's storage keys. Database and store indexes are checked against the
// schemas by the validator, because only `schema.cbor` says how many there are.

export type DataPath =
  | { kind: "localStorage"; key: number }
  | { kind: "schema"; key: number; db: number }
  | { kind: "store"; key: number; db: number; store: number }
  | { kind: "blob"; sha256: string };

const INDEX = "(0|[1-9][0-9]*)";
const LOCAL_STORAGE = new RegExp(`^data/${INDEX}/local-storage\\.cbor$`);
const SCHEMA = new RegExp(`^data/${INDEX}/idb/${INDEX}/schema\\.cbor$`);
const STORE = new RegExp(`^data/${INDEX}/idb/${INDEX}/store-${INDEX}\\.cbor$`);
const BLOB = /^blobs\/([0-9a-f]{64})$/;
const DIRECTORY = new RegExp(`^(?:blobs|data(?:/${INDEX}(?:/idb(?:/${INDEX})?)?)?)$`);

/** The kind of a data file path, or `null` when the path is not in the grammar (manifest.json included). */
export function parseDataPath(path: string, storageKeys: number): DataPath | null {
  const blob = BLOB.exec(path);
  if (blob !== null) {
    return { kind: "blob", sha256: blob[1] as string };
  }
  const local = LOCAL_STORAGE.exec(path);
  const schema = SCHEMA.exec(path);
  const store = STORE.exec(path);
  let parsed: DataPath | null = null;
  if (local !== null) {
    parsed = { kind: "localStorage", key: Number(local[1]) };
  } else if (schema !== null) {
    parsed = { kind: "schema", key: Number(schema[1]), db: Number(schema[2]) };
  } else if (store !== null) {
    parsed = {
      kind: "store",
      key: Number(store[1]),
      db: Number(store[2]),
      store: Number(store[3]),
    };
  }
  return parsed !== null && parsed.key < storageKeys ? parsed : null;
}

/** True for a directory entry that is a prefix of the grammar (`data`, `data/<k>`, `data/<k>/idb`, `.../<d>`, `blobs`). */
export function isDataDirectory(path: string, storageKeys: number): boolean {
  const match = DIRECTORY.exec(path);
  return match !== null && (match[1] === undefined || Number(match[1]) < storageKeys);
}

export const localStoragePath = (key: number) => `data/${key}/local-storage.cbor`;
export const schemaPath = (key: number, db: number) => `data/${key}/idb/${db}/schema.cbor`;
export const storePath = (key: number, db: number, store: number) =>
  `data/${key}/idb/${db}/store-${store}.cbor`;
export const blobPath = (sha256: string) => `blobs/${sha256}`;
