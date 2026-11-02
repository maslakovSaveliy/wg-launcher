// Task progress as the launcher shows it (architecture.md section 6, `task:progress`): real steps and measured bytes
// only, a percentage only when main sent the total (AGENTS.md honesty rule 1), and a failure's code and message as
// text (AC-10). The book is keyed by task id, so an event that arrives before the page knows the task id from its
// call's reply is kept like any other.

import type { TaskProgressEvent } from "@wg-launcher/shared";

/** The last event of each task, in the order the tasks first reported. */
export type TaskBook = ReadonlyMap<string, TaskProgressEvent>;

export function applyProgress(book: TaskBook, event: TaskProgressEvent): TaskBook {
  const known = book.get(event.taskId);
  // An outcome stands: a running event that arrives late does not undo it.
  if (known && known.status !== "running") return book;
  const next = new Map(book);
  next.set(event.taskId, {
    ...event,
    ...(event.bytesDone === undefined && known?.bytesDone !== undefined
      ? { bytesDone: known.bytesDone }
      : {}),
  });
  return next;
}

/** The game's most recent task, or null. */
export function latestTask(book: TaskBook, gameId: string): TaskProgressEvent | null {
  let latest: TaskProgressEvent | null = null;
  for (const event of book.values()) if (event.gameId === gameId) latest = event;
  return latest;
}

const KINDS: Record<TaskProgressEvent["kind"], string> = {
  export: "Export",
  import: "Import",
  verify: "Verify",
  "delete-saves": "Delete local saves",
  recover: "Recovery",
};

const STEPS: Record<TaskProgressEvent["step"], string> = {
  lock: "waiting for the game",
  read: "reading the saves",
  write: "writing the snapshot file",
  validate: "checking the snapshot",
  plan: "checking the storage keys",
  backup: "backing up the current saves",
  wipe: "clearing the current saves",
  import: "writing the saves",
  verify: "checking the result",
  commit: "recording the result",
  "rollback-wipe": "clearing what was written",
  "rollback-import": "putting back the saves from before",
  "rollback-verify": "checking the saves from before",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function measured(event: TaskProgressEvent): string {
  if (event.bytesDone === undefined) return "";
  if (event.bytesTotal === undefined || event.bytesTotal === 0) {
    return ` (${formatBytes(event.bytesDone)} read)`;
  }
  const percent = Math.floor((event.bytesDone / event.bytesTotal) * 100);
  return ` (${formatBytes(event.bytesDone)} of ${formatBytes(event.bytesTotal)}, ${percent}%)`;
}

export function describeTask(event: TaskProgressEvent): string {
  const kind = KINDS[event.kind];
  if (event.status === "done") return `${kind}: done`;
  if (event.status === "failed") {
    return `${kind} failed: ${event.code ?? "INTERNAL"}: ${event.message ?? "Something went wrong."}`;
  }
  return `${kind}: ${STEPS[event.step]}${measured(event)}`;
}
