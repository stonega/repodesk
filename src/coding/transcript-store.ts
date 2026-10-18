import type { Store } from "../db/repositories.ts";
import type { DevelopmentTask } from "./development.ts";
import type { LocalRunner, LocalStatus } from "./local/protocol.ts";
import { taskEvent, taskGet } from "./task-store.ts";

/** Persist each page and its cursor in one transaction before settling an execution. */
export async function captureRunnerStatus(
  store: Store,
  runner: LocalRunner,
  task: DevelopmentTask,
  attemptId: string,
): Promise<LocalStatus> {
  const cursorId = `transcript:cursor:${attemptId}`;
  let offset = Number(
    (
      await store.pool.query(
        "SELECT data->>'offset' AS offset FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id=$3",
        [task.workspaceId, task.id, cursorId],
      )
    ).rows[0]?.offset ?? 0,
  );
  for (;;) {
    const status = await runner.status(task.workspaceId, attemptId, offset);
    const page = status.transcript;
    if (!page) return status;
    await store.change(task.workspaceId, async (w, sql) => {
      const current = await taskGet(sql, w.id, task.id);
      if (w.deletion || current.contentRemoved) return;
      for (const entry of page.entries)
        await taskEvent(sql, current, `transcript:item:${entry.id}`, {
          ...entry,
          attemptId,
        });
      await sql.query(
        "INSERT INTO coding_task_events(workspace_id,task_id,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,task_id,id) DO UPDATE SET data=excluded.data",
        [
          w.id,
          task.id,
          cursorId,
          JSON.stringify({ offset: page.offset, supported: true }),
        ],
      );
    });
    if (!page.hasMore || page.offset <= offset) return status;
    offset = page.offset;
  }
}
