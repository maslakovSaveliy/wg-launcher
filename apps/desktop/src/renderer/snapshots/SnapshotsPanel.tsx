// A game's snapshots and the sources of a restore (plan Task 15): this game's rows (restore, verify, save as), the
// rows of other library entries with the same origin (restore), or a file chosen in main's dialog. A refusal that
// needs a storage-key mapping opens the mapping form; main confirms the restore itself in a native dialog it writes.
// Reloaded whenever a task of the game ends, so the rows are what main recorded.

import type { Card, IpcRequest, KeyMappingRef, SnapshotRow } from "@wg-launcher/shared";
import { useCallback, useEffect, useState } from "react";
import { bridge } from "../api.js";
import { MappingForm } from "./MappingForm.js";
import { SnapshotList } from "./SnapshotList.js";

type Source = IpcRequest<"snapshot:import">["source"];

interface Listed {
  own: SnapshotRow[];
  others: { card: Card; rows: SnapshotRow[] }[];
}

export function SnapshotsPanel({
  gameId,
  sameOrigin,
  refreshKey,
  onClose,
}: {
  gameId: string;
  /** Other library entries whose URL has this game's origin. */
  sameOrigin: readonly Card[];
  /** Changes when a task of this game ends. */
  refreshKey: string;
  onClose(): void;
}) {
  const [listed, setListed] = useState<Listed | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Source | null>(null);

  const load = useCallback(async () => {
    const own = await bridge().listSnapshots({ gameId });
    if (!own.ok) {
      setMessage(own.message);
      return;
    }
    const others: Listed["others"] = [];
    for (const card of sameOrigin) {
      const result = await bridge().listSnapshots({ gameId: card.gameId });
      if (result.ok) others.push({ card, rows: result.data.snapshots });
    }
    setListed({ own: own.data.snapshots, others });
  }, [gameId, sameOrigin]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only asks for a reload
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const restore = async (source: Source, keyMapping?: KeyMappingRef[]) => {
    const result = await bridge().importSnapshot(
      keyMapping ? { gameId, source, mapping: keyMapping } : { gameId, source },
    );
    if (result.ok) {
      setMapping(null);
      setMessage(null);
    } else if (result.code === "CANCELLED") {
      // Declining main's confirmation is not an error.
      setMessage(null);
    } else {
      setMessage(`${result.code}: ${result.message}`);
      if (result.code === "IMP_STORAGE_KEY_MISMATCH") setMapping(source);
    }
  };

  const outcome = (result: { ok: true } | { ok: false; code: string; message: string }) =>
    setMessage(
      result.ok || result.code === "CANCELLED" ? null : `${result.code}: ${result.message}`,
    );

  return (
    <section className="panel" aria-label="Snapshots">
      <h3>Snapshots</h3>
      {listed === null && message === null && <p>Loading the snapshots.</p>}
      {listed && (
        <>
          <SnapshotList
            label="Snapshots of this game"
            rows={listed.own}
            actions={{
              onRestore: (row) => void restore({ revisionId: row.revisionId }),
              onVerify: (row) =>
                void bridge().verifySnapshot({ gameId, revisionId: row.revisionId }).then(outcome),
              onSaveAs: (row) =>
                void bridge().saveSnapshotAs({ gameId, revisionId: row.revisionId }).then(outcome),
            }}
          />
          {listed.others.map(({ card, rows }) => (
            <section key={card.gameId} aria-label={`Snapshots of ${card.title}`}>
              <h4>From the entry "{card.title}" with the same address</h4>
              <SnapshotList
                label={`Snapshots of ${card.title}`}
                rows={rows}
                actions={{ onRestore: (row) => void restore({ revisionId: row.revisionId }) }}
              />
            </section>
          ))}
        </>
      )}
      <button type="button" onClick={() => void restore("file")}>
        Restore from a file…
      </button>
      <button type="button" onClick={onClose}>
        Close
      </button>
      {message && <p role="alert">{message}</p>}
      {mapping !== null && (
        <MappingForm
          fromFile={mapping === "file"}
          onSubmit={(keyMapping) => void restore(mapping, keyMapping)}
          onCancel={() => setMapping(null)}
        />
      )}
    </section>
  );
}
