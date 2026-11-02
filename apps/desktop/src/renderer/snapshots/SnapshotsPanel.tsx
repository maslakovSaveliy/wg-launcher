// A game's snapshots and the sources of a restore (plan Task 15): this game's rows (restore, verify, save as), the
// rows of other library entries with the same origin (restore), or a file chosen in main's dialog. A refusal that
// needs a storage-key mapping opens the mapping form; main confirms the restore itself in a native dialog it writes.
// Reloaded when a task of the game ends or the set of same-origin entries changes, so the rows are what main
// recorded; an answer older than the latest request is dropped.

import type { Card, IpcRequest, KeyMappingRef, SnapshotRow } from "@wg-launcher/shared";
import { useEffect, useRef, useState } from "react";
import { bridge } from "../api.js";
import { MappingForm } from "./MappingForm.js";
import { type SnapshotActions, SnapshotList } from "./SnapshotList.js";

type Source = IpcRequest<"snapshot:import">["source"];

export interface Listed {
  own: SnapshotRow[];
  others: { card: Card; rows: SnapshotRow[] }[];
}

/** The rows and the sources of a restore, or the loading line before the first answer. */
export function SnapshotSources({
  listed,
  failed = false,
  actions,
  onFile,
  onClose,
}: {
  listed: Listed | null;
  /** The list could not be read (its error is shown beside): then nothing claims to be loading. */
  failed?: boolean;
  /** `onRestoreOther` restores a row of another entry into this game. */
  actions: SnapshotActions & { onRestoreOther?(row: SnapshotRow): void };
  onFile(): void;
  onClose(): void;
}) {
  const { onRestoreOther, ...own } = actions;
  return (
    <>
      {listed === null && !failed && <p>Loading the snapshots.</p>}
      {listed && (
        <>
          <SnapshotList label="Snapshots of this game" rows={listed.own} actions={own} />
          {listed.others.map(({ card, rows }) => (
            <section key={card.gameId} aria-label={`Snapshots of ${card.title}`}>
              <h4>From the entry "{card.title}" with the same address</h4>
              <SnapshotList
                label={`Snapshots of ${card.title}`}
                rows={rows}
                actions={onRestoreOther ? { onRestore: onRestoreOther } : {}}
              />
            </section>
          ))}
        </>
      )}
      <button type="button" onClick={onFile}>
        Restore from a file…
      </button>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </>
  );
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
  const [listFailed, setListFailed] = useState(false);
  const cards = useRef(sameOrigin);
  cards.current = sameOrigin;
  const latest = useRef(0);
  // The library renders new card objects on every reload: only a change of entries asks for new rows.
  const sameOriginKey = sameOrigin.map((card) => `${card.gameId} ${card.title}`).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and sameOriginKey only ask for a reload
  useEffect(() => {
    const request = ++latest.current;
    void (async () => {
      const own = await bridge().listSnapshots({ gameId });
      if (!own.ok) {
        if (request === latest.current) {
          setListFailed(true);
          setMessage(`${own.code}: ${own.message}`);
        }
        return;
      }
      const others: Listed["others"] = [];
      for (const card of cards.current) {
        const result = await bridge().listSnapshots({ gameId: card.gameId });
        if (result.ok) others.push({ card, rows: result.data.snapshots });
      }
      if (request === latest.current) {
        setListFailed(false);
        setListed({ own: own.data.snapshots, others });
      }
    })();
  }, [gameId, refreshKey, sameOriginKey]);

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
      <SnapshotSources
        listed={listed}
        failed={listFailed}
        actions={{
          onRestore: (row) => void restore({ revisionId: row.revisionId }),
          onVerify: (row) =>
            void bridge().verifySnapshot({ gameId, revisionId: row.revisionId }).then(outcome),
          onSaveAs: (row) =>
            void bridge().saveSnapshotAs({ gameId, revisionId: row.revisionId }).then(outcome),
          onRestoreOther: (row) => void restore({ revisionId: row.revisionId }),
        }}
        onFile={() => void restore("file")}
        onClose={onClose}
      />
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
