import type { Sql } from "../db/pool.ts";
import { requireThat } from "../domain.ts";
import type { DevelopmentInput, DevelopmentTask } from "./development.ts";

export async function taskList(
  sql: Sql,
  workspaceId: string,
): Promise<DevelopmentTask[]> {
  return (
    await sql.query(
      "SELECT data FROM coding_tasks WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 200",
      [workspaceId],
    )
  ).rows.map((r) => r.data);
}
export async function taskGet(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<DevelopmentTask> {
  const result = await sql.query(
    "SELECT data FROM coding_tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
    [workspaceId, id],
  );
  requireThat(result.rows[0], "not_found", 404);
  return result.rows[0].data;
}
export async function taskSave(sql: Sql, task: DevelopmentTask) {
  task.updatedAt = new Date().toISOString();
  await sql.query(
    "UPDATE coding_tasks SET data=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [task.workspaceId, task.id, JSON.stringify(task)],
  );
}
export async function taskInputs(
  sql: Sql,
  task: DevelopmentTask,
): Promise<DevelopmentInput[]> {
  return (
    await sql.query(
      "SELECT data FROM coding_task_inputs WHERE workspace_id=$1 AND task_id=$2 ORDER BY revision",
      [task.workspaceId, task.id],
    )
  ).rows.map((r) => r.data);
}
export async function taskEvent(
  sql: Sql,
  task: DevelopmentTask,
  id: string,
  data: unknown,
) {
  await sql.query(
    "INSERT INTO coding_task_events(workspace_id,task_id,id,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [task.workspaceId, task.id, id, JSON.stringify(data)],
  );
}
export async function finishAttempt(
  sql: Sql,
  task: DevelopmentTask,
  state = "done",
  data: unknown = {},
) {
  if (task.attemptId)
    await sql.query(
      "UPDATE coding_task_attempts SET state=$3,data=data || $4::jsonb WHERE workspace_id=$1 AND id=$2 AND fence=$5",
      [
        task.workspaceId,
        task.attemptId,
        state,
        JSON.stringify(data),
        task.fence,
      ],
    );
}
