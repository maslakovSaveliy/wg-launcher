// The latest task of a game as one line of text: its real step and measured bytes, or its outcome; a failure shows
// its code and message (AC-10).

import type { TaskProgressEvent } from "@wg-launcher/shared";
import { describeTask } from "../tasks.js";

export function TaskStatus({ task }: { task: TaskProgressEvent | null }) {
  if (task === null) return null;
  return (
    <p
      className="task"
      data-task-status={task.status}
      role={task.status === "failed" ? "alert" : "status"}
    >
      {describeTask(task)}
    </p>
  );
}
