import { type CodingTask, codingTerminal } from "../coding/config.ts";
import {
  type DevelopmentTask,
  developmentStopped,
} from "../coding/development.ts";
import { developmentStatus, reviewedStatus } from "../coding/feedback.ts";
import { cancelCoding, checkCodingPayload } from "../coding/policy.ts";
import { taskGet, taskList } from "../coding/task-store.ts";
import {
  cancelDevelopment,
  cancelRequest,
  checkDevelopment,
} from "../coding/tasks.ts";
import type { Sql } from "../db/pool.ts";
import {
  type Delivery,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { audience, authorize } from "../workspaces/policy.ts";
import { deliver, visibleRuns } from "../workspaces/service.ts";
import { runStatus } from "./feedback.ts";
import type { Message, Update } from "./router.ts";
import { taskButtons } from "./task-buttons.ts";

type Target =
  | { kind: "r"; value: Run }
  | { kind: "c"; value: CodingTask }
  | { kind: "d"; value: DevelopmentTask };

async function controlTarget(
  sql: Sql,
  w: Workspace,
  kind: string | undefined,
  id: string,
): Promise<Target | undefined> {
  if (kind === "d") return { kind: "d", value: await taskGet(sql, w.id, id) };
  if (kind === "c") {
    const value = w.codingTasks?.find((t) => t.id === id);
    return value && { kind: "c", value };
  }
  if (kind === "r") {
    const value = w.runs.find((r) => r.id === id);
    return value && { kind: "r", value };
  }
}

function statusButtons(target: Target) {
  const cancel =
    target.kind === "r"
      ? !target.value.cancelled &&
        ["queued", "running", "awaiting_approval"].includes(target.value.status)
      : !target.value.cancelRequested &&
        (target.kind === "d"
          ? !developmentStopped(target.value.state)
          : !codingTerminal(target.value.state));
  return taskButtons(
    target.kind === "d"
      ? "development"
      : target.kind === "c"
        ? "coding"
        : "run",
    target.value.id,
    cancel,
  );
}
function allowed(w: Workspace, actor: string, target: Target, stop: boolean) {
  authorize(w, actor);
  if (target.kind === "d")
    checkDevelopment(w, target.value, actor, stop, !stop);
  else if (target.kind === "c") {
    const t = target.value;
    audience(w, actor, t.chatId);
    if (stop)
      requireThat(
        t.actor === actor ||
          w.coding?.settings.repositories.some(
            (r) =>
              r.repositoryId === t.payload.repositoryId &&
              r.maintainers.includes(actor),
          ),
        "access_denied",
        403,
      );
    else {
      requireThat(
        t.actor === actor || t.chatId !== t.actor,
        "access_denied",
        403,
      );
      checkCodingPayload(w, actor, t.payload);
    }
  } else {
    const r = target.value;
    requireThat(
      visibleRuns(w, actor).some((v) => v.id === r.id),
      "not_found",
      404,
    );
    if (stop)
      requireThat(
        r.actor === actor ||
          (r.chatId !== r.actor &&
            w.members.some(
              (m) => m.id === actor && m.active && m.role !== "member",
            )),
        "not_found",
        404,
      );
  }
}
async function perform(
  sql: Sql,
  w: Workspace,
  actor: string,
  chatId: string,
  topicId: number,
  target: Target,
  stop: boolean,
  updateId: number,
  reference = true,
) {
  allowed(w, actor, target, stop);
  if (stop) {
    if (target.kind === "d") {
      const terminal =
        developmentStopped(target.value.state) && !target.value.cancelRequested;
      await cancelDevelopment(sql, w, actor, target.value.id);
      if (terminal)
        deliver(w, actor, chatId, developmentStatus(target.value), {
          topicId,
          id: `development:${target.value.id}:status:${updateId}`,
        });
    } else if (target.kind === "c") {
      const terminal =
        codingTerminal(target.value.state) && !target.value.cancelRequested;
      cancelCoding(w, actor, target.value.id);
      if (terminal)
        deliver(w, actor, chatId, reviewedStatus(target.value), {
          topicId,
          id: `coding:${target.value.id}:status:${updateId}`,
        });
    } else {
      const run = await cancelRequest(sql, w, actor, target.value.id);
      if (!run.cancelled)
        deliver(
          w,
          actor,
          chatId,
          "This request has already finished. Messages already sent cannot be undone.",
          { topicId, id: `control:${updateId}:finished` },
        );
    }
  } else
    deliver(
      w,
      actor,
      chatId,
      target.kind === "r"
        ? runStatus(target.value)
        : `${target.kind === "d" ? developmentStatus(target.value) : reviewedStatus(target.value)}${reference ? `\nReference: ${target.value.id}` : ""}`,
      {
        topicId,
        id: `${target.kind === "d" ? "development" : target.kind === "c" ? "coding" : "run"}:${target.value.id}:status:${updateId}`,
        buttons: reference ? undefined : statusButtons(target),
      },
    );
}

export async function taskControl(
  sql: Sql,
  w: Workspace,
  u: Update,
  botId: string,
  msg: Message,
  cmd: { name: string; args: string },
) {
  if (
    !["status", "cancel"].includes(cmd.name) ||
    !msg.from ||
    msg.from.is_bot ||
    msg.sender_chat
  )
    return false;
  const actor = String(msg.from.id),
    chatId = String(msg.chat.id),
    topicId = msg.message_thread_id ?? 0;
  authorize(w, actor);
  const stop = cmd.name === "cancel";
  const targets: Target[] = [
    ...(await taskList(sql, w.id)).map(
      (value): Target => ({ kind: "d", value }),
    ),
    ...(w.codingTasks ?? []).map((value): Target => ({ kind: "c", value })),
    ...visibleRuns(w, actor).map((value): Target => ({ kind: "r", value })),
  ];
  const replyId = msg.reply_to_message?.message_id;
  let candidates = targets.filter((target) => {
    try {
      allowed(w, actor, target, stop);
    } catch {
      return false;
    }
    const t = target.value;
    if (target.kind === "d" && target.value.botId !== botId) return false;
    if (cmd.args) return t.id === cmd.args;
    if (t.chatId !== chatId || t.topicId !== topicId) return false;
    if (replyId)
      return (
        w.deliveries.some(
          (d) =>
            d.state === "sent" &&
            d.remoteId === replyId &&
            d.chatId === chatId &&
            d.topicId === topicId &&
            (d.runId === t.id ||
              d.id.startsWith(
                `${target.kind === "d" ? "development" : target.kind === "c" ? "coding" : "run"}:${t.id}:`,
              )),
        ) ||
        (target.kind === "r" && target.value.replyTo === replyId) ||
        (target.kind === "d" &&
          w.messages.some(
            (s) =>
              s.id === target.value.sourceId && s.id.endsWith(`:${replyId}`),
          ))
      );
    return target.kind === "r"
      ? ["queued", "running", "awaiting_approval"].includes(target.value.status)
      : target.kind === "c"
        ? !codingTerminal(target.value.state)
        : !developmentStopped(target.value.state);
  });
  const parentRuns = new Set(
    candidates.flatMap((t) =>
      t.kind === "c"
        ? [t.value.runId]
        : t.kind === "d"
          ? [w.messages.find((s) => s.id === t.value.sourceId)?.runId]
          : [],
    ),
  );
  candidates = candidates.filter(
    (t) => t.kind !== "r" || !parentRuns.has(t.value.id),
  );
  if (!candidates.length) {
    const runs = visibleRuns(w, actor)
      .filter((r) => r.chatId === chatId && r.topicId === topicId)
      .slice(-5);
    deliver(
      w,
      actor,
      chatId,
      cmd.args || replyId
        ? "I couldn’t find an accessible task or request for that reference. Use /status in its conversation."
        : stop
          ? "There is no active task or request in this conversation."
          : runs.map(runStatus).join("\n\n") ||
            "No requests yet in this conversation.",
      { topicId, id: `control:${botId}:${u.update_id}` },
    );
  } else if (candidates.length === 1 && candidates[0])
    await perform(
      sql,
      w,
      actor,
      chatId,
      topicId,
      candidates[0],
      stop,
      u.update_id,
    );
  else
    deliver(
      w,
      actor,
      chatId,
      stop
        ? "Which task or request should stop?"
        : "Which task or request should I check?",
      {
        topicId,
        id: `control:${botId}:${u.update_id}`,
        buttons: candidates.slice(-20).map((t) => [
          {
            text: (t.kind === "r"
              ? t.value.task
              : `${t.value.payload.repository}: ${t.value.payload.title}`
            ).slice(0, 60),
            callback_data: `f${t.kind}${stop ? "c" : "s"}:${t.value.id}:${u.update_id}`,
          },
        ]),
      },
    );
  return true;
}

export async function selectTaskControl(
  sql: Sql,
  w: Workspace,
  u: Update,
  botId: string,
) {
  const c = u.callback_query;
  if (/^t[rcd][cs]:/.test(c?.data ?? ""))
    return inlineTaskControl(sql, w, u, botId);
  if (!c?.data || !/^f[rcd][cs]:/.test(c.data)) return false;
  requireThat(
    !c.from.is_bot && c.message && !c.message.sender_chat,
    "access_denied",
    403,
  );
  const [action, id, updateId] = c.data.split(":");
  requireThat(
    id && /^[0-9a-f-]{36}$/.test(id) && updateId && /^\d+$/.test(updateId),
    "invalid_request",
  );
  const actor = String(c.from.id),
    chatId = String(c.message.chat.id),
    topicId = c.message.message_thread_id ?? 0;
  requireThat(
    w.deliveries.some(
      (d) =>
        d.id === `control:${botId}:${updateId}` &&
        d.actor === actor &&
        d.chatId === chatId &&
        d.topicId === topicId &&
        d.state === "sent" &&
        d.remoteId === c.message?.message_id &&
        Date.now() - Date.parse(d.at) < 600000 &&
        d.buttons?.flat().some((b) => b.callback_data === c.data),
    ),
    "access_denied",
    403,
  );
  const target = await controlTarget(sql, w, action?.[1], id);
  requireThat(target, "not_found", 404);
  requireThat(
    target.value.chatId === chatId && target.value.topicId === topicId,
    "access_denied",
    403,
  );
  if (target.kind === "d")
    requireThat(target.value.botId === botId, "access_denied", 403);
  await perform(
    sql,
    w,
    actor,
    chatId,
    topicId,
    target,
    action?.[2] === "c",
    u.update_id,
  );
  return true;
}

async function inlineTaskControl(
  sql: Sql,
  w: Workspace,
  u: Update,
  botId: string,
) {
  const c = u.callback_query;
  const match = /^t([rcd])([cs]):([0-9a-f-]{36})$/.exec(c?.data ?? "");
  if (!match) return false;
  requireThat(
    c && !c.from.is_bot && c.message && !c.message.sender_chat,
    "access_denied",
    403,
  );
  const actor = String(c.from.id),
    chatId = String(c.message.chat.id),
    topicId = c.message.message_thread_id ?? 0,
    id = match[3];
  requireThat(id, "invalid_request");
  requireThat(
    w.deliveries.some(
      (d) =>
        d.botId === botId &&
        d.actor === actor &&
        d.chatId === chatId &&
        d.topicId === topicId &&
        d.state === "sent" &&
        d.remoteId === c.message?.message_id &&
        d.buttons?.flat().some((b) => b.callback_data === c.data),
    ),
    "access_denied",
    403,
  );
  const target = await controlTarget(sql, w, match[1], id);
  requireThat(target, "not_found", 404);
  requireThat(
    target.value.chatId === chatId && target.value.topicId === topicId,
    "access_denied",
    403,
  );
  if (target.kind === "d")
    requireThat(target.value.botId === botId, "access_denied", 403);
  await perform(
    sql,
    w,
    actor,
    chatId,
    topicId,
    target,
    match[2] === "c",
    u.update_id,
    false,
  );
  return true;
}

/** Queued selectors recheck every visible target before exposing their labels. */
export async function selectionAllowed(sql: Sql, w: Workspace, d: Delivery) {
  if (!/^control:[0-9]+:[0-9]+$/.test(d.id) || !d.buttons) return true;
  for (const b of d.buttons.flat()) {
    const match = /^f([rcd])([cs]):([0-9a-f-]{36}):[0-9]+$/.exec(
      b.callback_data,
    );
    if (!match?.[3]) return false;
    try {
      const id = match[3];
      const target = await controlTarget(sql, w, match[1], id);
      if (
        !target ||
        target.value.chatId !== d.chatId ||
        target.value.topicId !== d.topicId
      )
        return false;
      if (target.kind === "d" && target.value.botId !== d.id.split(":")[1])
        return false;
      allowed(w, d.actor, target, match[2] === "c");
    } catch {
      return false;
    }
  }
  return true;
}
