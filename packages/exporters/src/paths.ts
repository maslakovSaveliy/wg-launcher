// Entry paths of one storage key (snapshot-format.md section 3.2): `data/<k>/local-storage.cbor`,
// `data/<k>/idb/<d>/schema.cbor`, `data/<k>/idb/<d>/store-<s>.cbor` and `blobs/<sha256>`. The container module has
// the same grammar, but it is Node-only; this copy serves the frame.

export const localStoragePath = (k: number) => `data/${k}/local-storage.cbor`;
export const schemaPath = (k: number, d: number) => `data/${k}/idb/${d}/schema.cbor`;
export const storePath = (k: number, d: number, s: number) => `data/${k}/idb/${d}/store-${s}.cbor`;
export const blobPath = (sha256: string) => `blobs/${sha256}`;

export type FramePath =
  | { kind: "localStorage" }
  | { kind: "schema"; db: number }
  | { kind: "store"; db: number; store: number }
  | { kind: "blob"; sha256: string };

const INDEX = "(0|[1-9][0-9]*)";
const BLOB = /^blobs\/([0-9a-f]{64})$/;

/** The kind of an entry path under key `k`, or `null` for any other path (another key included). */
export function parseFramePath(path: string, k: number): FramePath | null {
  const blob = BLOB.exec(path);
  if (blob !== null) {
    return { kind: "blob", sha256: blob[1] as string };
  }
  if (path === localStoragePath(k)) {
    return { kind: "localStorage" };
  }
  const data = new RegExp(`^data/${k}/idb/${INDEX}/(?:schema\\.cbor|store-${INDEX}\\.cbor)$`).exec(
    path,
  );
  if (data === null) {
    return null;
  }
  const db = Number(data[1]);
  return data[2] === undefined
    ? { kind: "schema", db }
    : { kind: "store", db, store: Number(data[2]) };
}
