import type { Workspace } from "../domain.ts";
import { eligible } from "../workspaces/policy.ts";
import { retainedSource } from "../workspaces/threads.ts";
import { FORWARD_INPUT_WINDOW_MS } from "./followup.ts";
import type { Message } from "./router.ts";

// Telegram sends a forwarding comment separately from the forwarded message.
// Outside native Topics, keep an adjacent forward/comment pair in one thread.
export function privateForwardAnchor(
  w: Workspace,
  msg: Message,
  botId: string,
  now = Date.now(),
) {
  const actor = String(msg.from?.id);
  if (
    msg.chat.type !== "private" ||
    String(msg.chat.id) !== actor ||
    !msg.from ||
    msg.from.is_bot ||
    msg.sender_chat ||
    msg.is_automatic_forward ||
    msg.message_thread_id ||
    msg.reply_to_message ||
    !eligible(w, actor)
  )
    return;
  const prefix = `${botId}:${actor}:`;
  const source = w.messages.findLast(
    (s) => s.chatId === actor && s.author === actor && s.id.startsWith(prefix),
  );
  const prior = source?.runId
    ? w.runs.find((r) => r.id === source.runId)
    : undefined;
  if (
    !source ||
    !prior ||
    source.topicId !== 0 ||
    source.role !== "user" ||
    (!msg.forward_origin && !source.forwarded) ||
    !retainedSource(w, source, now) ||
    prior.actor !== actor ||
    prior.chatId !== actor ||
    prior.topicId !== 0 ||
    !prior.replyTo ||
    prior.replyTo === msg.message_id ||
    prior.workflowId ||
    prior.cancelled ||
    !["queued", "running", "succeeded", "partial"].includes(prior.status) ||
    !w.threads?.some(
      (t) =>
        t.id === prior.threadId &&
        t.botId === botId &&
        t.actor === actor &&
        t.chatId === actor &&
        t.topicId === undefined,
    )
  )
    return;
  const sentAt = msg.date * 1000;
  const sourceAt = Date.parse(source.at);
  if (
    !Number.isFinite(sourceAt) ||
    Math.abs(sentAt - sourceAt) > FORWARD_INPUT_WINDOW_MS ||
    sourceAt > now + 1000 ||
    sentAt > now + 1000 ||
    now - sourceAt > FORWARD_INPUT_WINDOW_MS ||
    now - sentAt > FORWARD_INPUT_WINDOW_MS
  )
    return;
  return prior.replyTo;
}
