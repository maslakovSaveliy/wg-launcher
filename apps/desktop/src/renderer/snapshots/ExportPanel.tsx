// The export dialog (save-transfer.md section 6, "Export", and its open question on frame keys): main first reads
// what each frame of another site holds; the ones with data are listed with their counts and sizes, unticked unless
// the user ticked them for an earlier export, because ads in iframes can keep tracking ids there and are never
// included silently. Then the export starts; its steps and outcome follow as task progress.

import type { FrameSummary, StorageKeyRef } from "@wg-launcher/shared";
import { useEffect, useState } from "react";
import { bridge } from "../api.js";
import { formatBytes } from "../tasks.js";

const sameKey = (a: StorageKeyRef, b: StorageKeyRef) =>
  a.origin === b.origin && a.topLevelSite === b.topLevelSite;

const holdsData = (frame: FrameSummary) =>
  frame.localStorageItems > 0 || frame.databases > 0 || (frame.indexedDbBytes ?? 0) > 0;

/** What a frame holds, in counts and sizes only. */
function contents(frame: FrameSummary): string {
  const parts = [
    `${frame.localStorageItems} localStorage item${frame.localStorageItems === 1 ? "" : "s"}`,
    `${frame.databases} IndexedDB database${frame.databases === 1 ? "" : "s"}`,
  ];
  if (frame.indexedDbBytes !== null)
    parts.push(`${formatBytes(frame.indexedDbBytes)} in IndexedDB`);
  return parts.join(", ");
}

/** The frame list: the frames with data, and any the user ticked before. */
export function FrameChoices({
  frames,
  chosen,
  onToggle,
}: {
  frames: readonly FrameSummary[];
  chosen: readonly StorageKeyRef[];
  onToggle(frame: FrameSummary): void;
}) {
  const shown = frames.filter((frame) => holdsData(frame) || frame.inExport);
  if (shown.length === 0)
    return <p>No frame of another site holds data, so only the game's own pages are exported.</p>;
  return (
    <fieldset>
      <legend>Frames of other sites that hold data</legend>
      <p>
        They are exported only if you tick them. Advertising frames can keep tracking ids in their
        storage.
      </p>
      {shown.map((frame) => (
        <label key={`${frame.origin} ${frame.topLevelSite ?? ""}`} className="frame">
          <input
            type="checkbox"
            checked={chosen.some((key) => sameKey(key, frame))}
            onChange={() => onToggle(frame)}
          />{" "}
          <span className="origin">{frame.origin}</span>
          {frame.topLevelSite !== null && <> inside {frame.topLevelSite}</>}: {contents(frame)}
        </label>
      ))}
    </fieldset>
  );
}

type PanelView =
  | { kind: "reading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; frames: FrameSummary[] };

export function ExportPanel({
  gameId,
  onStarted,
  onClose,
}: {
  gameId: string;
  onStarted(): void;
  onClose(): void;
}) {
  const [view, setView] = useState<PanelView>({ kind: "reading" });
  const [chosen, setChosen] = useState<StorageKeyRef[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void bridge()
      .listFrames({ gameId })
      .then((result) => {
        if (!live) return;
        if (!result.ok) {
          setView({ kind: "error", message: result.message });
          return;
        }
        setView({ kind: "ready", frames: result.data.frames });
        setChosen(
          result.data.frames
            .filter((frame) => frame.inExport)
            .map(({ origin, topLevelSite }) => ({ origin, topLevelSite })),
        );
      });
    return () => {
      live = false;
    };
  }, [gameId]);

  const toggle = (frame: FrameSummary) =>
    setChosen((keys) =>
      keys.some((key) => sameKey(key, frame))
        ? keys.filter((key) => !sameKey(key, frame))
        : [...keys, { origin: frame.origin, topLevelSite: frame.topLevelSite }],
    );

  const start = async () => {
    if (view.kind !== "ready") return;
    // With frames listed the choice is always sent, so main remembers it; without any, nothing is chosen.
    const result = await bridge().exportSnapshot(
      view.frames.length > 0 ? { gameId, frameKeys: chosen } : { gameId },
    );
    if (result.ok) onStarted();
    else setError(`${result.code}: ${result.message}`);
  };

  return (
    <section className="panel" aria-label="Export snapshot">
      <h3>Export snapshot</h3>
      {view.kind === "reading" && <p>Reading what the game's frames hold.</p>}
      {view.kind === "error" && <p role="alert">{view.message}</p>}
      {view.kind === "ready" && (
        <>
          <FrameChoices frames={view.frames} chosen={chosen} onToggle={toggle} />
          <button type="button" onClick={() => void start()}>
            Start export
          </button>
        </>
      )}
      <button type="button" onClick={onClose}>
        Close
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
