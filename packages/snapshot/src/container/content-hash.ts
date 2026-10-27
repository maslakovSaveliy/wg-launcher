// `contentHash` (snapshot-format.md section 5): SHA-256 of the JCS text of entries, format, formatVersion and
// storageKeys, copied in manifest order with exactly the listed members. Every other manifest field is left out.
import { createHash } from "node:crypto";
import { canonicalJson } from "./jcs.js";

export interface HashedEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface HashedStorageKey {
  origin: string;
  topLevelSite: string | null;
  role: "top" | "frame";
}

/** Lowercase hex SHA-256 of the section 5 object; only `entries` and `storageKeys` of the manifest are read. */
export function computeContentHash(manifest: {
  entries: readonly HashedEntry[];
  storageKeys: readonly HashedStorageKey[];
}): string {
  const covered = {
    entries: manifest.entries.map(({ path, size, sha256 }) => ({ path, sha256, size })),
    format: "wgsnap",
    formatVersion: 1,
    storageKeys: manifest.storageKeys.map(({ origin, topLevelSite, role }) => ({
      origin,
      role,
      topLevelSite,
    })),
  };
  return createHash("sha256").update(canonicalJson(covered), "utf8").digest("hex");
}
