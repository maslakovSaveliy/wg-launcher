// Settings: "Data of removed games" (architecture.md section 12, PRD OQ-2). No setting is allowlisted yet, so there
// is nothing else to show. Deleting a removed game's data comes with a later task and is not offered here.

import type { OrphanEntry } from "@wg-launcher/shared";
import { useEffect, useState } from "react";
import { bridge, formatTime } from "../api.js";

export function Settings() {
  const [orphans, setOrphans] = useState<OrphanEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bridge()
      .listOrphans({})
      .then((result) => {
        if (result.ok) setOrphans(result.data.orphans);
        else setError(result.message);
      });
  }, []);

  return (
    <section aria-label="Settings">
      <h2>Settings</h2>
      <section aria-labelledby="orphans-heading">
        <h3 id="orphans-heading">Data of removed games</h3>
        <p>
          These games were removed from the library. Their saves are still on this computer.
          Deleting them is not available in this version yet.
        </p>
        {error && <p role="alert">{error}</p>}
        {orphans?.length === 0 && <p>No data of removed games.</p>}
        {orphans && orphans.length > 0 && (
          <ul className="orphans">
            {orphans.map((orphan) => (
              <li key={orphan.gameId} data-game-id={orphan.gameId}>
                <span className="title">{orphan.title}</span>{" "}
                <span className="url">{orphan.url}</span>{" "}
                <span>removed {formatTime(orphan.removedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
