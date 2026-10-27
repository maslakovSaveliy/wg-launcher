import type { WritableDb } from "../database.js";

export type SnapshotKind = "export" | "backup" | "imported";
export type FlushState = "confirmed" | "unconfirmed";

/** A stored `.wgsnap` file. Snapshots have no foreign key: they outlive the library card. */
export interface Snapshot {
  revisionId: string;
  gameId: string;
  kind: SnapshotKind;
  manifestGameId: string;
  parentRevisionId: string | null;
  /** The manifest's display string, not Unix milliseconds. */
  createdAt: string;
  deviceId: string;
  exporterId: string;
  exporterVersion: string;
  adapterId: string | null;
  adapterVersion: string | null;
  contentHash: string;
  sizeBytes: number;
  path: string;
  flushState: FlushState;
  verifiedAt: number | null;
  verifiedExporterVersion: string | null;
  addedAt: number;
}

export type NewSnapshot = Omit<
  Snapshot,
  "adapterId" | "adapterVersion" | "verifiedAt" | "verifiedExporterVersion" | "addedAt"
> &
  Partial<Pick<Snapshot, "adapterId" | "adapterVersion">>;

interface SnapshotRow {
  revision_id: string;
  game_id: string;
  kind: SnapshotKind;
  manifest_game_id: string;
  parent_revision_id: string | null;
  created_at: string;
  device_id: string;
  exporter_id: string;
  exporter_version: string;
  adapter_id: string | null;
  adapter_version: string | null;
  content_hash: string;
  size_bytes: number;
  path: string;
  flush_state: FlushState;
  verified_at: number | null;
  verified_exporter_version: string | null;
  added_at: number;
}

const COLUMNS =
  "revision_id, game_id, kind, manifest_game_id, parent_revision_id, created_at, device_id, exporter_id, exporter_version, adapter_id, adapter_version, content_hash, size_bytes, path, flush_state, verified_at, verified_exporter_version, added_at";

export const SNAPSHOTS_SQL = {
  findByRevision: `SELECT ${COLUMNS} FROM snapshots WHERE revision_id = ?`,
  // Served by snapshots_by_game (game_id, added_at): no sort step.
  listOwn: `SELECT ${COLUMNS} FROM snapshots WHERE game_id = ? ORDER BY added_at, rowid`,
} as const;

const toSnapshot = (row: SnapshotRow): Snapshot => ({
  revisionId: row.revision_id,
  gameId: row.game_id,
  kind: row.kind,
  manifestGameId: row.manifest_game_id,
  parentRevisionId: row.parent_revision_id,
  createdAt: row.created_at,
  deviceId: row.device_id,
  exporterId: row.exporter_id,
  exporterVersion: row.exporter_version,
  adapterId: row.adapter_id,
  adapterVersion: row.adapter_version,
  contentHash: row.content_hash,
  sizeBytes: row.size_bytes,
  path: row.path,
  flushState: row.flush_state,
  verifiedAt: row.verified_at,
  verifiedExporterVersion: row.verified_exporter_version,
  addedAt: row.added_at,
});

export function createSnapshotsRepo(db: WritableDb) {
  const find = db.raw.prepare(SNAPSHOTS_SQL.findByRevision);
  const listOwn = db.raw.prepare(SNAPSHOTS_SQL.listOwn);
  const insert = db.raw.prepare(
    `INSERT INTO snapshots (${COLUMNS.replace(", verified_at, verified_exporter_version", "")})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (revision_id) DO NOTHING`,
  );
  const verify = db.raw.prepare(
    "UPDATE snapshots SET verified_at = ?, verified_exporter_version = ? WHERE revision_id = ?",
  );
  const findByRevision = (revisionId: string): Snapshot | null => {
    const row = find.get(revisionId) as SnapshotRow | undefined;
    return row ? toSnapshot(row) : null;
  };

  return {
    findByRevision,
    /**
     * Stores a row unless that revision is already stored. `revision_id` is the primary key, so restoring a stored
     * revision into another game adds no row: the existing row keeps the game it was first stored under (plan M8).
     * Returns the stored row and whether this call added it.
     */
    addIfAbsent(snapshot: NewSnapshot): { added: boolean; snapshot: Snapshot } {
      return db.transaction(() => {
        const { changes } = insert.run(
          snapshot.revisionId,
          snapshot.gameId,
          snapshot.kind,
          snapshot.manifestGameId,
          snapshot.parentRevisionId,
          snapshot.createdAt,
          snapshot.deviceId,
          snapshot.exporterId,
          snapshot.exporterVersion,
          snapshot.adapterId ?? null,
          snapshot.adapterVersion ?? null,
          snapshot.contentHash,
          snapshot.sizeBytes,
          snapshot.path,
          snapshot.flushState,
          db.now(),
        );
        const stored = findByRevision(snapshot.revisionId);
        if (!stored) throw new Error("snapshots.addIfAbsent: the row cannot be read back.");
        return { added: Number(changes) > 0, snapshot: stored };
      });
    },
    /**
     * The rows of a game plus the row of the revision its data descends from (plan M8), which may belong to
     * another game; ordered by `added_at`, each row once. Two indexed lookups merged here keep the statements free
     * of a sort step.
     */
    listForGame(gameId: string, baseRevisionId: string | null): Snapshot[] {
      const own = (listOwn.all(gameId) as unknown as SnapshotRow[]).map(toSnapshot);
      if (baseRevisionId === null || own.some((s) => s.revisionId === baseRevisionId)) return own;
      const base = findByRevision(baseRevisionId);
      if (!base) return own;
      // Array.prototype.sort is stable: equal timestamps keep the game's own rows first.
      return [...own, base].sort((a, b) => a.addedAt - b.addedAt);
    },
    markVerified(revisionId: string, exporterVersion: string): void {
      verify.run(db.now(), exporterVersion, revisionId);
    },
  };
}
