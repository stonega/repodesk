import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { eligible } from "../workspaces/policy.ts";
import { cancelRun } from "../workspaces/service.ts";
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
    (!pending ||
      deliveries.some((d) => ["sent", "delivery_unknown"].includes(d.state)))
  )
    return;
  cancelRun(w, actor, run.id);
  run.cancelled = true;
  run.status = "cancelled";
  run.finishedAt ??= new Date().toISOString();
  await store.save(sql, w);
  return w.id;
}
