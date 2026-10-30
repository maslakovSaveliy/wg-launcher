// Settings: "Data of removed games" (architecture.md section 12, PRD OQ-2) with "Delete local saves" for each, which
// main confirms in a native dialog and runs with a backup first. No setting is allowlisted yet, so there is nothing
// else to show.

import type { OrphanEntry } from "@wg-launcher/shared";
import { useCallback, useEffect, useState } from "react";
import { bridge, formatTime } from "../api.js";
import { TaskStatus } from "../snapshots/TaskStatus.js";
import { latestTask } from "../tasks.js";
import { useTaskBook } from "../use-tasks.js";

export function Settings() {
  const [orphans, setOrphans] = useState<OrphanEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void bridge()
      .listOrphans({})
      .then((result) => {
        if (result.ok) setOrphans(result.data.orphans);
        else setError(result.message);
      });
  }, []);
  useEffect(load, [load]);
  const tasks = useTaskBook(load);

  const deleteData = async (gameId: string) => {
    const result = await bridge().deleteOrphanData({ gameId });
    setError(result.ok || result.code === "CANCELLED" ? null : `${result.code}: ${result.message}`);
  };

  return (
    <section aria-label="Settings">
      <h2>Settings</h2>
      <section aria-labelledby="orphans-heading">
        <h3 id="orphans-heading">Data of removed games</h3>
        <p>
          These games were removed from the library. Whatever they saved on this computer stays
          there until you delete it here; a backup is made first.
        </p>
        {error && <p role="alert">{error}</p>}
        {orphans?.length === 0 && <p>No data of removed games.</p>}
        {orphans && orphans.length > 0 && (
          <ul className="orphans">
            {orphans.map((orphan) => (
              <li key={orphan.gameId} data-game-id={orphan.gameId}>
                <span className="title">{orphan.title}</span>{" "}
                <span className="url">{orphan.url}</span>{" "}
                <span>removed {formatTime(orphan.removedAt)}</span>{" "}
                <button type="button" onClick={() => void deleteData(orphan.gameId)}>
                  Delete local saves
                </button>
                <TaskStatus task={latestTask(tasks, orphan.gameId)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
