import { randomUUID } from "node:crypto";
import type { Sql } from "../db/pool.ts";
import { type Run, requireThat, type Workspace } from "../domain.ts";
import { runAllowed } from "../workspaces/policy.ts";
import { type TaskExchange, taskMessage } from "./conversation.ts";
import { type DevelopmentTask, developmentStopped } from "./development.ts";
import { taskSave } from "./task-store.ts";
import { checkDevelopment } from "./tasks.ts";

export async function taskExchanges(
  sql: Sql,
  task: Pick<DevelopmentTask, "workspaceId" | "id">,
  pendingOnly = false,
): Promise<TaskExchange[]> {
  return (
    await sql.query(
      "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'conversation:message:%' AND (NOT $3::boolean OR data->>'state' NOT IN ('answered','unknown','cancelled') OR data->>'cleanup'='true') ORDER BY created_at,id LIMIT 100",
      [task.workspaceId, task.id, pendingOnly],
    )
  ).rows.map((r) => r.data);
}
export async function saveExchange(
  sql: Sql,
  task: Pick<DevelopmentTask, "workspaceId" | "id">,
  exchange: TaskExchange,
) {
  await sql.query(
    `INSERT INTO coding_task_events(workspace_id,task_id,id,data,created_at)
     VALUES($1,$2,$3,$4::jsonb || CASE WHEN $4::jsonb->>'answer' IS NOT NULL
       THEN jsonb_build_object('answerRecordedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
       ELSE '{}'::jsonb END,clock_timestamp())
     ON CONFLICT(workspace_id,task_id,id) DO UPDATE SET data=excluded.data ||
       CASE WHEN coding_task_events.data->>'answerRecordedAt' IS NOT NULL
       THEN jsonb_build_object('answerRecordedAt',coding_task_events.data->>'answerRecordedAt')
       ELSE '{}'::jsonb END`,
    [
      task.workspaceId,
      task.id,
      `conversation:message:${exchange.id}`,
      JSON.stringify(exchange),
    ],
  );
}
export function conversationAudience(
  w: Workspace,
  task: DevelopmentTask,
  run: Run,
) {
  checkDevelopment(w, task, run.actor, false, true);
  run.browserRead ??= task.browserRead;
  requireThat(
    run.status === "running" &&
      runAllowed(w, run) &&
      !run.workflowId &&
      task.chatId === run.chatId &&
      task.topicId === run.topicId &&
      !task.contentRemoved,
    "access_denied",
    403,
  );
}
export function exchangeSourcesPresent(w: Workspace, exchange: TaskExchange) {
  return (
    exchange.sourceIds.length > 0 &&
    exchange.sourceIds.every((id) =>
      w.messages.some(
        (s) =>
          s.id === id &&
          s.author === exchange.actor &&
          s.role === "user" &&
          Date.parse(s.expiresAt) > Date.now(),
      ),
    )
  );
}
export async function askTask(
  sql: Sql,
  w: Workspace,
  task: DevelopmentTask,
  run: Run,
  callId: string,
  question: string,
) {
  conversationAudience(w, task, run);
  requireThat(
    !task.cancelRequested && !developmentStopped(task.state),
    "coding_task_stopped",
    409,
  );
  const sourceKey = `${run.id}:${callId}`;
  const prior = (
    await sql.query(
      "SELECT task_id,data FROM coding_task_events WHERE workspace_id=$1 AND id LIKE 'conversation:message:%' AND data->>'sourceKey'=$2",
      [w.id, sourceKey],
    )
  ).rows[0];
  if (prior) {
    requireThat(
      prior.task_id === task.id && prior.data.question === question.trim(),
      "coding_message_conflict",
      409,
    );
    return prior.data as TaskExchange;
  }
  requireThat(
    (await taskExchanges(sql, task)).length < 100,
    "coding_message_capacity",
    429,
  );
  const exchange: TaskExchange = {
    ...taskMessage.parse({ id: randomUUID(), question }),
    actor: run.actor,
    runId: run.id,
    sourceKey,
    sourceIds: w.messages
      .filter(
        (s) =>
          s.runId === run.id &&
          s.author === run.actor &&
          s.role === "user" &&
          s.chatId === run.chatId &&
          s.topicId === run.topicId,
      )
      .map((s) => s.id),
    state: "queued",
    createdAt: new Date().toISOString(),
  };
  requireThat(
    exchangeSourcesPresent(w, exchange),
    "coding_current_request_required",
    409,
  );
  await saveExchange(sql, task, exchange);
  task.conversationPending = true;
  await taskSave(sql, task);
  return exchange;
}
export function exchangeView(message: TaskExchange) {
  return {
    id: message.id,
    question: message.question,
    state: message.state,
    answer: message.answer,
    error: message.error,
    createdAt: message.createdAt,
  };
}
