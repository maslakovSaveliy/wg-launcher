// The library view: the read-only notice or the add form and the cards. Reloaded after every action, on every
// game state change and when a task ends, so it shows what main recorded, never a guess.

import type { Card } from "@wg-launcher/shared";
import { useCallback, useEffect, useState } from "react";
import { bridge } from "../api.js";
import { latestTask } from "../tasks.js";
import { useTaskBook } from "../use-tasks.js";
import { AddGame } from "./AddGame.js";
import { GameCard } from "./GameCard.js";

type LibraryView =
  | { kind: "loading" }
  | { kind: "ready"; cards: Card[]; canCreateShortcuts: boolean }
  | { kind: "read-only"; reason: string }
  | { kind: "error"; message: string };

export function Library() {
  const [view, setView] = useState<LibraryView>({ kind: "loading" });

  const load = useCallback(async () => {
    const result = await bridge().listLibrary({});
    if (!result.ok) setView({ kind: "error", message: result.message });
    else if (result.data.library === "read-only")
      setView({ kind: "read-only", reason: result.data.reason });
    else {
      const { cards, canCreateShortcuts } = result.data;
      setView({ kind: "ready", cards, canCreateShortcuts });
    }
  }, []);

  useEffect(() => {
    void load();
    return bridge().onGameState(() => void load());
  }, [load]);

  const reload = useCallback(() => void load(), [load]);
  const tasks = useTaskBook(reload);

  switch (view.kind) {
    case "loading":
      return <p>Loading the library.</p>;
    case "error":
      return <p role="alert">{view.message}</p>;
    case "read-only":
      return (
        <section aria-label="Library">
          <p role="alert" id="library-read-only">
            {view.reason}
          </p>
        </section>
      );
    case "ready":
      return (
        <section aria-label="Library">
          <AddGame onAdded={load} />
          {view.cards.length === 0 ? (
            <p>The library is empty. Add a game by its address.</p>
          ) : (
            <ul className="cards">
              {view.cards.map((card) => (
                <GameCard
                  key={card.gameId}
                  card={card}
                  canCreateShortcuts={view.canCreateShortcuts}
                  task={latestTask(tasks, card.gameId)}
                  sameOrigin={view.cards.filter(
                    (other) =>
                      other.gameId !== card.gameId && originOf(other.url) === originOf(card.url),
                  )}
                  onChanged={load}
                />
              ))}
            </ul>
          )}
        </section>
      );
  }
}

/** The origin of a card's URL, compared only (never opened); null for a URL the parser refuses. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
