import type { Run, Workspace } from "../domain.ts";
import { eligible } from "../workspaces/policy.ts";
import { retainedSource } from "../workspaces/threads.ts";
import type { Message } from "./router.ts";

export const FOLLOWUP_WINDOW_MS = 5 * 60 * 1000;

// Only actual received text from an authorized human can become a candidate.
// This function never calls a model or treats message contents as authorization.
export function followupCandidate(
  w: Workspace,
  msg: Message,
  botId: string,
  now = Date.now(),
): Run["followup"] | undefined {
  const actor = String(msg.from?.id);
  if (
    !msg.from ||
    msg.from.is_bot ||
    msg.sender_chat ||
    !["group", "supergroup"].includes(msg.chat.type) ||
    !eligible(w, actor) ||
    w.settings.paused ||
    !w.chats.some((c) => c.active && c.id === String(msg.chat.id))
  )
    return;
  const prior = latestGroupRun(w, msg, botId);
  const text = msg.text?.trim();
  if (
    !text ||
    text.length > 500 ||
    msg.reply_to_message ||
    text.startsWith("/") ||
    /@[\p{L}\p{N}_]+/u.test(text) ||
    msg.entities?.some((e) =>
      ["mention", "text_mention", "bot_command"].includes(e.type),
    )
  ) {
    closeGroupAttention(w, msg, botId);
    return;
  }
  if (
    !prior ||
    prior.followupClosed ||
    prior.cancelled ||
    !["succeeded", "partial"].includes(prior.status) ||
    !prior.result
  )
    return;
  const delivery = w.deliveries.find(
    (d) => d.id === `run:${prior.id}:result` && d.state === "sent",
  );
  // Use completion time, not an uncertain delivery-attempt timestamp.
  const answeredAt = Date.parse(prior.finishedAt ?? "");
  const sentAt = msg.date * 1000;
  if (
    !delivery ||
    !Number.isFinite(answeredAt) ||
    now < answeredAt ||
    now - answeredAt > FOLLOWUP_WINDOW_MS ||
    sentAt < answeredAt - 1000 ||
    sentAt > now + 1000 ||
    now - sentAt > FOLLOWUP_WINDOW_MS ||
    !w.messages.some(
      (m) => m.id === `answer:${prior.id}` && retainedSource(w, m, now),
    )
  )
    return;
  return {
    anchorRunId: prior.id,
    expiresAt: new Date(answeredAt + FOLLOWUP_WINDOW_MS).toISOString(),
    transcript: [],
  };
}

// Keep accounting metadata but remove an unaddressed candidate from conversation
// history. Ordinary group collection, when explicitly enabled, remains independent.
export function discardFollowup(w: Workspace, run: Run) {
  if (!run.followup || run.followup.decision === "reply") return;
  run.followup.decision = "ignore";
  run.followup.transcript = [];
  delete run.followup.references;
  const anchor = w.runs.find((r) => r.id === run.followup?.anchorRunId);
  if (anchor) anchor.followupClosed = true;
  const collected = w.chats.some((c) => c.id === run.chatId && c.collection);
  w.messages = w.messages.filter((m) => {
    if (m.runId !== run.id) return true;
    if (!collected || m.role === "assistant") return false;
    delete m.runId;
    delete m.threadId;
    delete m.role;
    m.directed = false;
    return true;
  });
  run.task = "[unaddressed group message omitted]";
  run.sources = [];
  run.transcript = [];
  run.tools = {};
  delete run.contextSummary;
  delete run.discussionUpdates;
  delete run.compaction;
}

function latestGroupRun(w: Workspace, msg: Message, botId: string) {
  const actor = String(msg.from?.id);
  return w.runs.findLast(
    (r) =>
      r.actor === actor &&
      r.chatId === String(msg.chat.id) &&
      r.topicId === (msg.message_thread_id ?? 0) &&
      !!r.threadId &&
      w.threads?.some(
        (t) => t.id === r.threadId && t.kind === "group" && t.botId === botId,
      ),
  );
}

export function closeGroupAttention(w: Workspace, msg: Message, botId: string) {
  const prior = latestGroupRun(w, msg, botId);
  if (!prior) return;
  prior.followupClosed = true;
  if (prior.followup) {
    const anchor = w.runs.find((r) => r.id === prior.followup?.anchorRunId);
    if (anchor) anchor.followupClosed = true;
  }
}
