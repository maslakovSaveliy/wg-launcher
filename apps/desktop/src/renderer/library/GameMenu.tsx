// A card's actions (PRD F-1 to F-9): play, export, snapshots and restore, the three distinct deletes (remove from
// library, clear cache, delete local saves; architecture.md section 12), edit, cover and shortcut. Every destructive
// action is confirmed in a native dialog that main writes; the buttons only ask main.

export type Panel = "none" | "export" | "snapshots" | "title";

export function GameMenu({
  open,
  hasCover,
  canCreateShortcuts,
  panel,
  onPanel,
  onPlay,
  onClearCache,
  onDeleteSaves,
  onPickCover,
  onRemoveCover,
  onShortcut,
  onRemove,
}: {
  /** The game's window exists (launching or running). */
  open: boolean;
  hasCover: boolean;
  /** False where main cannot make shortcuts (Linux): the button is not shown (AGENTS.md honesty rule 1). */
  canCreateShortcuts: boolean;
  panel: Panel;
  onPanel(panel: Panel): void;
  onPlay(): void;
  onClearCache(): void;
  onDeleteSaves(): void;
  onPickCover(): void;
  onRemoveCover(): void;
  onShortcut(): void;
  onRemove(): void;
}) {
  const toggle = (target: Panel) => onPanel(panel === target ? "none" : target);
  return (
    <div className="actions">
      <button type="button" onClick={onPlay}>
        {open ? "Show game" : "Play"}
      </button>
      <button type="button" onClick={() => toggle("export")} aria-expanded={panel === "export"}>
        Export snapshot
      </button>
      <button
        type="button"
        onClick={() => toggle("snapshots")}
        aria-expanded={panel === "snapshots"}
      >
        Snapshots and restore
      </button>
      <button type="button" onClick={() => toggle("title")} aria-expanded={panel === "title"}>
        Edit title
      </button>
      <button type="button" onClick={onPickCover}>
        Choose cover
      </button>
      {hasCover && (
        <button type="button" onClick={onRemoveCover}>
          Remove cover
        </button>
      )}
      {canCreateShortcuts && (
        <button type="button" onClick={onShortcut}>
          Create shortcut
        </button>
      )}
      <button type="button" onClick={onClearCache}>
        Clear cache
      </button>
      <button type="button" onClick={onDeleteSaves}>
        Delete local saves
      </button>
      <button type="button" onClick={onRemove}>
        Remove from library
      </button>
    </div>
  );
}
