// Stored snapshots as rows of recorded fields. Every `unconfirmed` row says "flush unconfirmed" and none is called a
// save point (save-transfer.md section 7); "Verified" appears only when the row's round trip passed.

import type { SnapshotRow } from "@wg-launcher/shared";
import { formatTime } from "../api.js";
import { formatBytes } from "../tasks.js";

const KINDS: Record<SnapshotRow["kind"], string> = {
  export: "Export",
  backup: "Backup made before a change",
  imported: "Imported",
};

export interface SnapshotActions {
  onRestore?(row: SnapshotRow): void;
  onVerify?(row: SnapshotRow): void;
  onSaveAs?(row: SnapshotRow): void;
}

export function SnapshotList({
  rows,
  label,
  actions = {},
}: {
  rows: readonly SnapshotRow[];
  label: string;
  actions?: SnapshotActions;
}) {
  if (rows.length === 0) return <p>No snapshots.</p>;
  return (
    <ul className="snapshots" aria-label={label}>
      {rows.map((row) => (
        <li key={row.revisionId} data-revision-id={row.revisionId} data-flush={row.flushState}>
          <span className="created">{row.createdAt}</span> · <span>{KINDS[row.kind]}</span> ·{" "}
          <span>{formatBytes(row.sizeBytes)}</span> ·{" "}
          <span>
            {row.exporter.id} {row.exporter.version}
          </span>
          {row.flushState === "unconfirmed" && (
            <>
              {" "}
              · <span className="flush">flush unconfirmed</span> (the game may not have written
              everything before this snapshot was taken)
            </>
          )}
          {row.verifiedAt !== null && (
            <>
              {" "}
              · <span className="verified">Verified {formatTime(row.verifiedAt)}</span>
            </>
          )}
          <span className="row-actions">
            {actions.onRestore && (
              <button type="button" onClick={() => actions.onRestore?.(row)}>
                Restore into this game
              </button>
            )}
            {actions.onVerify && (
              <button type="button" onClick={() => actions.onVerify?.(row)}>
                Verify
              </button>
            )}
            {actions.onSaveAs && (
              <button type="button" onClick={() => actions.onSaveAs?.(row)}>
                Save as…
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
