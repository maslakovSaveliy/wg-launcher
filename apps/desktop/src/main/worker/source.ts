// The file a restore reads, in the snapshot worker (save-transfer.md section 6): R1 validates it fully, R6 streams it a
// second time per frame, re-checking every entry's size and hash (`readEntries`), and sends that frame its own data
// files, renumbered to the frame's key in the target, plus only the blobs its records reference (the importer refuses
// an unreferenced blob). Blob references are read from the store files once, after the validation. The expected hash
// of the R7 check follows snapshot-format.md section 5: after a mapping, the keys are replaced and sorted again and
// the `data/<k>/` prefixes renumbered; sizes and entry hashes do not change.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type BlobRefs, decodeStoreRecords } from "@wg-launcher/snapshot";
import {
  computeContentHash,
  type Limits,
  type Manifest,
  parseDataPath,
  readEntries,
  validateSnapshot,
} from "@wg-launcher/snapshot/container";

export interface ValidatedSource {
  path: string;
  /** From `stat` at validation; the second pass reads exactly this many compressed bytes. */
  compressedSize: number;
  manifest: Manifest;
  limits: Partial<Limits>;
  /** The blob hashes the records of each storage key reference (by manifest index). */
  blobsByKey: Map<number, Set<string>>;
}

/** One key of the plan: its manifest index (`from`), its index in the target (`to`) and the mapped key. */
export interface PlannedKey {
  from: number;
  to: number;
  origin: string;
  topLevelSite: string | null;
  role: "top" | "frame";
}

const prefix = (key: number) => `data/${key}/`;

/** R1: the full validation, then one more pass for the blob references of each key's records. */
export async function openSource(path: string, limits: Partial<Limits>): Promise<ValidatedSource> {
  const compressedSize = (await stat(path)).size;
  const { manifest } = await validateSnapshot(createReadStream(path), { compressedSize, limits });
  const refs = new Map<number, BlobRefs>();
  for await (const entry of readEntries(createReadStream(path), manifest, {
    compressedSize,
    limits,
  })) {
    const kind = parseDataPath(entry.path, manifest.storageKeys.length);
    if (kind?.kind !== "store") continue;
    const keyRefs = refs.get(kind.key) ?? new Map();
    refs.set(kind.key, keyRefs);
    decodeStoreRecords(entry.bytes, keyRefs);
  }
  const blobsByKey = new Map([...refs].map(([key, map]) => [key, new Set(map.keys())]));
  return { path, compressedSize, manifest, limits, blobsByKey };
}

/**
 * R6 for one frame: the second pass over the file (every entry re-checked), yielding the data files of manifest key
 * `from` as `data/<to>/...` and the blobs that key's records reference.
 */
export async function* frameEntries(
  source: ValidatedSource,
  from: number,
  to: number,
): AsyncGenerator<{ path: string; bytes: Uint8Array }> {
  const blobs = source.blobsByKey.get(from) ?? new Set<string>();
  for await (const entry of readEntries(createReadStream(source.path), source.manifest, {
    compressedSize: source.compressedSize,
    limits: source.limits,
  })) {
    if (entry.path.startsWith(prefix(from))) {
      yield { path: prefix(to) + entry.path.slice(prefix(from).length), bytes: entry.bytes };
    } else if (entry.path.startsWith("blobs/") && blobs.has(entry.path.slice("blobs/".length))) {
      yield entry;
    }
  }
}

/** The `contentHash` a re-export of the restored keys must have (R7), after the plan's renumbering. */
export function expectedContentHash(manifest: Manifest, keys: readonly PlannedKey[]): string {
  const to = new Map(keys.map((key) => [key.from, key.to]));
  const entries = manifest.entries
    .map((entry) => {
      const kind = parseDataPath(entry.path, manifest.storageKeys.length);
      if (kind === null || kind.kind === "blob") return entry;
      const target = to.get(kind.key);
      if (target === undefined) throw new RangeError("a storage key of the snapshot has no target");
      return { ...entry, path: prefix(target) + entry.path.slice(prefix(kind.key).length) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const storageKeys = [...keys]
    .sort((a, b) => a.to - b.to)
    .map(({ origin, topLevelSite, role }) => ({ origin, topLevelSite, role }));
  return computeContentHash({ entries, storageKeys });
}
