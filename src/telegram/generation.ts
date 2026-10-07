import { developmentStopped } from "../coding/development.ts";
import { taskGet } from "../coding/task-store.ts";
import { cancelDevelopment } from "../coding/tasks.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { Fault } from "../domain.ts";
import { eligible } from "../workspaces/policy.ts";
import { cancelRun, confirmRunStopped } from "../workspaces/service.ts";
import type { Update } from "./router.ts";

/** Telegram identifies the stopping user by the private chat, not a `from` field. */
export async function stopGeneration(
  store: Store,
  sql: Sql,
  botId: string,
  stop: NonNullable<Update["stopped_message_generation"]>,
) {
  if (stop.chat.type !== "private" || stop.chat.id <= 0) return;
  const actor = String(stop.chat.id);
  const topicId = stop.message_thread_id ?? 0;
  // Resolve by the persisted draft, never the user's current workspace selection.
  const matches = await sql.query<{ id: string }>(
    "SELECT id FROM workspaces WHERE data->'runs' @> $1::jsonb LIMIT 2",
    [
      JSON.stringify([
        {
          actor,
          chatId: actor,
          topicId,
          telegramDraft: { id: stop.draft_id, botId },
        },
      ]),
    ],
  );
  if (matches.rows.length !== 1 || !matches.rows[0]) return;
  const w = await store.read(matches.rows[0].id, sql, true);
  if (!eligible(w, actor)) return;
  const runs = w.runs.filter(
    (r) =>
      r.actor === actor &&
      r.chatId === actor &&
      r.topicId === topicId &&
      r.telegramDraft?.id === stop.draft_id &&
      r.telegramDraft.botId === botId &&
      r.telegramDraft.fence === r.fence,
  );
  const run = runs[0];
  if (runs.length !== 1 || !run || run.cancelled) return;
  let codingActive = false;
  if (run.codingTaskId) {
    try {
      const task = await taskGet(sql, w.id, run.codingTaskId);
      codingActive =
        task.actor === actor &&
        task.botId === botId &&
        task.chatId === actor &&
        task.topicId === topicId &&
        !developmentStopped(task.state);
    } catch (error) {
      if (!(error instanceof Fault) || error.code !== "not_found") throw error;
    }
  }
  const deliveries = w.deliveries.filter(
    (d) => d.runId === run.id && d.id === `run:${run.id}:result`,
  );
  // A click can race model completion. Cancel a pending final reply, but never replay
  // or retract a sent/unknown send. An external request already in flight cannot be undone.
  const active = ["queued", "running", "awaiting_approval"].includes(
    run.status,
  );
  const pending =
    ["succeeded", "partial"].includes(run.status) &&
    deliveries.some((d) => ["pending", "sending"].includes(d.state));
  if (
    !active &&
    !codingActive &&
    (!pending ||
      deliveries.some((d) => ["sent", "delivery_unknown"].includes(d.state)))
  )
    return;
  if (codingActive && run.codingTaskId)
    await cancelDevelopment(sql, w, actor, run.codingTaskId);
  cancelRun(w, actor, run.id);
  run.cancelled = true;
  run.status = "cancelled";
  run.finishedAt ??= new Date().toISOString();
  if (!active) confirmRunStopped(w, run);
  await store.save(sql, w);
  return w.id;
}
