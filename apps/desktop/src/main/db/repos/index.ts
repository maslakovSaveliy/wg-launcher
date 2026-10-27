// One small repository per table. They take the writable database handle; only the main process creates them.

import type { WritableDb } from "../database.js";
import { createDeviceRepo } from "./device.js";
import { createGamesRepo } from "./games.js";
import { createOrphansRepo } from "./orphans.js";
import { createPlaySessionsRepo } from "./play-sessions.js";
import { createRestoreJournalRepo } from "./restore-journal.js";
import { createSettingsRepo } from "./settings.js";
import { createSnapshotsRepo } from "./snapshots.js";
import { createStorageChecksRepo } from "./storage-checks.js";
import { createStorageTargetsRepo } from "./storage-targets.js";
import { createWindowStateRepo } from "./window-state.js";

export function createRepos(db: WritableDb) {
  return {
    device: createDeviceRepo(db),
    games: createGamesRepo(db),
    windowState: createWindowStateRepo(db),
    playSessions: createPlaySessionsRepo(db),
    storageTargets: createStorageTargetsRepo(db),
    snapshots: createSnapshotsRepo(db),
    restoreJournal: createRestoreJournalRepo(db),
    storageChecks: createStorageChecksRepo(db),
    orphans: createOrphansRepo(db),
    settings: createSettingsRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;
