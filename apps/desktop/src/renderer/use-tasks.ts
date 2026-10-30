// A view's subscription to `task:progress` (the library and settings each hold one; the preload allows several
// listeners): a book of every task's last event, and a callback when a task ends, so the view reloads what main
// recorded (rows, badges) instead of guessing.

import type { TaskProgressEvent } from "@wg-launcher/shared";
import { useEffect, useState } from "react";
import { bridge } from "./api.js";
import { applyProgress, type TaskBook } from "./tasks.js";

export function useTaskBook(onOutcome: (event: TaskProgressEvent) => void): TaskBook {
  const [book, setBook] = useState<TaskBook>(() => new Map());
  useEffect(
    () =>
      bridge().onTaskProgress((event) => {
        setBook((current) => applyProgress(current, event));
        if (event.status !== "running") onOutcome(event);
      }),
    [onOutcome],
  );
  return book;
}
