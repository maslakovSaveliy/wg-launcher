// One library card: recorded state only (badges, last launch and playtime when recorded, the window state from the
// game runtime). Title and URL are text; the URL is never a link and the cover is the app:// copy, never the game's.

import type { Card, ErrorCode } from "@wg-launcher/shared";
import { type FormEvent, useState } from "react";
import { badgeLabel, bridge, formatPlaytime, formatTime, stateLabel } from "../api.js";

type Outcome = { ok: true } | { ok: false; code: ErrorCode; message: string };

export function GameCard({
  card,
  canCreateShortcuts,
  onChanged,
}: {
  card: Card;
  /** False where main cannot make shortcuts (Linux): the button is not shown (AGENTS.md honesty rule 1). */
  canCreateShortcuts: boolean;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const state = stateLabel(card.state);
  const open = card.state === "launching" || card.state === "running";

  const run = async (action: () => Promise<Outcome>) => {
    const result = await action();
    // Cancelling a native dialog is not an error.
    setError(result.ok || result.code === "CANCELLED" ? null : result.message);
    await onChanged();
    return result.ok;
  };
  const gameId = card.gameId;

  const saveTitle = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => bridge().updateGame({ gameId, title }))) setEditing(false);
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
        <p role="alert">The game's saves need recovery before it can start.</p>
      )}
      <div className="actions">
        <button type="button" onClick={() => void run(() => bridge().launchGame({ gameId }))}>
          {open ? "Show game" : "Play"}
        </button>
        <button
          type="button"
          onClick={() => {
            setTitle(card.title);
            setEditing(!editing);
          }}
          aria-expanded={editing}
        >
          Edit title
        </button>
        <button
          type="button"
          onClick={() => void run(() => bridge().updateGame({ gameId, cover: "pick" }))}
        >
          Choose cover
        </button>
        {card.coverUrl && (
          <button
            type="button"
            onClick={() => void run(() => bridge().updateGame({ gameId, cover: "remove" }))}
          >
            Remove cover
          </button>
        )}
        {canCreateShortcuts && (
          <button type="button" onClick={() => void run(() => bridge().createShortcut({ gameId }))}>
            Create shortcut
          </button>
        )}
        <button type="button" onClick={() => void run(() => bridge().removeGame({ gameId }))}>
          Remove from library
        </button>
      </div>
      {editing && (
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
      {error && <p role="alert">{error}</p>}
    </li>
  );
}
