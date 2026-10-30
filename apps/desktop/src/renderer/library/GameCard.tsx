// One library card: recorded state only (badges, last launch and playtime when recorded, the window state from the
// game runtime, the latest task's real steps). Title and URL are text; the URL is never a link and the cover is the
// app:// copy, never the game's.

import type { Card, ErrorCode, TaskProgressEvent } from "@wg-launcher/shared";
import { type FormEvent, useState } from "react";
import { badgeLabel, bridge, formatPlaytime, formatTime, stateLabel } from "../api.js";
import { RecoveryBanner } from "../recovery/RecoveryBanner.js";
import { ExportPanel } from "../snapshots/ExportPanel.js";
import { SnapshotsPanel } from "../snapshots/SnapshotsPanel.js";
import { TaskStatus } from "../snapshots/TaskStatus.js";
import { GameMenu, type Panel } from "./GameMenu.js";

type Outcome = { ok: true } | { ok: false; code: ErrorCode; message: string };

export function GameCard({
  card,
  canCreateShortcuts,
  task,
  sameOrigin,
  onChanged,
}: {
  card: Card;
  canCreateShortcuts: boolean;
  /** The game's latest task, from `task:progress`. */
  task: TaskProgressEvent | null;
  /** Other library entries with this game's origin: restore sources (plan M8). */
  sameOrigin: readonly Card[];
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [title, setTitle] = useState(card.title);
  const state = stateLabel(card.state);
  const open = card.state === "launching" || card.state === "running";

  const run = async (action: () => Promise<Outcome>) => {
    const result = await action();
    // Cancelling a native dialog is not an error; a refusal shows its code with its message.
    setError(result.ok || result.code === "CANCELLED" ? null : `${result.code}: ${result.message}`);
    await onChanged();
    return result.ok;
  };
  const gameId = card.gameId;

  const saveTitle = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => bridge().updateGame({ gameId, title }))) setPanel("none");
  };

  return (
    <li className="card" data-game-id={gameId}>
      {card.coverUrl && <img className="cover" src={card.coverUrl} alt="" />}
      <h2 className="title">{card.title}</h2>
      <p className="url">{card.url}</p>
      <ul className="badges" aria-label="Badges">
        {card.badges.map((badge) => (
          <li key={badge.id}>{badgeLabel(badge)}</li>
        ))}
      </ul>
      {card.lastLaunchedAt !== null && <p>Last launched {formatTime(card.lastLaunchedAt)}</p>}
      {card.playtimeMs > 0 && <p>Playtime {formatPlaytime(card.playtimeMs)}</p>}
      {state && <p className="state">{state}</p>}
      {card.needsRecovery && (
        <RecoveryBanner onRetry={() => void run(() => bridge().retryRecovery({ gameId }))} />
      )}
      <TaskStatus task={task} />
      <GameMenu
        open={open}
        hasCover={card.coverUrl !== null}
        canCreateShortcuts={canCreateShortcuts}
        panel={panel}
        onPanel={(next) => {
          if (next === "title") setTitle(card.title);
          setPanel(next);
        }}
        onPlay={() => void run(() => bridge().launchGame({ gameId }))}
        onClearCache={() => void run(() => bridge().clearCache({ gameId }))}
        onDeleteSaves={() => void run(() => bridge().deleteSaves({ gameId }))}
        onPickCover={() => void run(() => bridge().updateGame({ gameId, cover: "pick" }))}
        onRemoveCover={() => void run(() => bridge().updateGame({ gameId, cover: "remove" }))}
        onShortcut={() => void run(() => bridge().createShortcut({ gameId }))}
        onRemove={() => void run(() => bridge().removeGame({ gameId }))}
      />
      {panel === "title" && (
        <form onSubmit={saveTitle} aria-label="Edit title">
          <label>
            Title
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={400}
            />
          </label>
          <button type="submit">Save title</button>
        </form>
      )}
      {panel === "export" && (
        <ExportPanel
          gameId={gameId}
          onStarted={() => setPanel("none")}
          onClose={() => setPanel("none")}
        />
      )}
      {panel === "snapshots" && (
        <SnapshotsPanel
          gameId={gameId}
          sameOrigin={sameOrigin}
          refreshKey={task ? `${task.taskId} ${task.status}` : ""}
          onClose={() => setPanel("none")}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}
