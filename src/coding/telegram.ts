import type { Sql } from "../db/pool.ts";
import { requireThat, type Source, type Workspace } from "../domain.ts";
import type { Message, Update } from "../telegram/router.ts";
import { eligible } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import { developmentStopped } from "./development.ts";
import { taskEvent, taskGet, taskInputs, taskList } from "./task-store.ts";
import {
  appendDevelopment,
  cancelDevelopment,
  checkDevelopment,
} from "./tasks.ts";

export async function routeDevelopment(
  sql: Sql,
  w: Workspace,
  u: Update,
  botId: string,
  msg: Message,
  cmd?: { name: string; args: string },
) {
  if (
    !msg.from ||
    msg.from.is_bot ||
    msg.sender_chat ||
    !msg.text ||
    !eligible(w, String(msg.from.id))
  )
    return false;
  if (cmd && !["ask", "cancel", "status"].includes(cmd.name)) return false;
  const actor = String(msg.from.id),
    chatId = String(msg.chat.id),
    topicId = msg.message_thread_id ?? 0;
  const tasks = (await taskList(sql, w.id)).filter(
    (t) =>
      !developmentStopped(t.state) &&
      t.botId === botId &&
      t.chatId === chatId &&
      t.topicId === topicId,
  );
  const replyId = msg.reply_to_message?.message_id;
  const anchor = replyId
    ? tasks.find(
        (t) =>
          w.deliveries.some(
            (d) =>
              d.id.startsWith(`development:${t.id}:`) &&
              d.state === "sent" &&
              d.chatId === chatId &&
              d.topicId === topicId &&
              d.remoteId === replyId,
          ) ||
          (replyId &&
            w.messages.some(
              (s) => s.id === t.sourceId && s.id.endsWith(`:${replyId}`),
            )),
      )
    : undefined;
  const candidates = [];
  for (const t of anchor ? [anchor] : tasks) {
    try {
      checkDevelopment(w, t, actor, cmd?.name === "cancel");
    } catch {
      continue;
    }
    const participant =
      t.actor === actor ||
      (await taskInputs(sql, t)).some((i) => i.actor === actor);
    // Outside a Topic, bind only replies. Unaddressed group messages need a recent participant binding.
    if (
      anchor ||
      (topicId > 0 &&
        (msg.chat.type === "private" ||
          !!cmd ||
          (participant && Date.now() - Date.parse(t.updatedAt) <= 300000)))
    )
      candidates.push(t);
  }
  if (!candidates.length) return false;
  if (cmd?.name === "cancel" && cmd.args) {
    const selected = candidates.find((t) => t.id === cmd.args);
    if (!selected) return false;
    await cancelDevelopment(sql, w, actor, selected.id);
    return true;
  }
  const sourceId = `${msg.chat.type === "private" ? `${botId}:` : ""}${chatId}:${msg.message_id}${u.edited_message ? `:edit:${u.update_id}` : ""}`;
  const source: Source = {
    id: sourceId,
    author: actor,
    chatId,
    topicId,
    text: msg.text,
    directed: true,
    at: new Date(msg.date * 1000).toISOString(),
    expiresAt: new Date(
      Date.now() + w.settings.retentionDays * 86400000,
    ).toISOString(),
    role: "user",
  };
  if (!w.messages.some((s) => s.id === source.id)) w.messages.push(source);
  w.messages = w.messages.slice(-2000);
  if (candidates.length > 1) {
    const eventId = `select:${botId}:${u.update_id}`;
    for (const t of candidates)
      await taskEvent(sql, t, eventId, { actor, source, botId });
    deliver(w, actor, chatId, "Which Codex task should receive this message?", {
      topicId,
      replyTo: msg.message_id,
      id: `development:selection:${botId}:${u.update_id}`,
      buttons: candidates.map((t) => [
        {
          text: `${t.payload.repository}: ${t.payload.title}`.slice(0, 60),
          callback_data: `devpick:${t.id}:${u.update_id}`,
        },
      ]),
    });
    return true;
  }
  const task = candidates[0];
  requireThat(task, "coding_task_not_found", 404);
  if (
    cmd?.name === "cancel" ||
    /^(?:stop|cancel|停止|取消)[.!。！]?$/i.test(msg.text.trim())
  ) {
    await cancelDevelopment(sql, w, actor, task.id);
    deliver(w, actor, chatId, "Codex cancellation recorded.", {
      topicId,
      id: `development:${task.id}:cancel:${u.update_id}`,
    });
  } else if (cmd?.name === "status") {
    deliver(
      w,
      actor,
      chatId,
      `${task.payload.repository}: ${task.state}${task.question ? `\n${task.question.text}` : ""}${task.pr ? `\n${task.pr.url}` : ""}`,
      { topicId, id: `development:${task.id}:status:${u.update_id}` },
    );
  } else {
    await appendDevelopment(
      sql,
      w,
      task,
      actor,
      source,
      `${botId}:${u.update_id}`,
    );
    deliver(
      w,
      actor,
      chatId,
      "Your message is recorded for Codex's next turn.",
      { topicId, id: `development:${task.id}:input:${u.update_id}` },
    );
  }
  return true;
}

export async function selectDevelopment(
  sql: Sql,
  w: Workspace,
  u: Update,
  botId: string,
) {
  const callback = u.callback_query;
  if (!callback?.data?.startsWith("devpick:")) return false;
  const [, id, updateId] = callback.data.split(":");
  requireThat(
    id &&
      updateId &&
      /^[0-9]+$/.test(updateId) &&
      !callback.from.is_bot &&
      callback.message,
    "access_denied",
    403,
  );
  const row = (
    await sql.query(
      "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id=$3",
      [w.id, id, `select:${botId}:${updateId}`],
    )
  ).rows[0];
  const actor = String(callback.from.id),
    chatId = String(callback.message.chat.id),
    topicId = callback.message.message_thread_id ?? 0;
  requireThat(
    row?.data.actor === actor &&
      row.data.botId === botId &&
      row.data.source.chatId === chatId &&
      row.data.source.topicId === topicId &&
      w.deliveries.some(
        (d) =>
          d.id === `development:selection:${botId}:${updateId}` &&
          d.state === "sent" &&
          d.remoteId === callback.message?.message_id &&
          d.chatId === chatId,
      ),
    "access_denied",
    403,
  );
  const task = await taskGet(sql, w.id, id);
  await appendDevelopment(
    sql,
    w,
    task,
    actor,
    row.data.source,
    `${botId}:${updateId}`,
  );
  return true;
}
