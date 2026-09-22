import { randomUUID } from "node:crypto";
import {
  type ConversationThread,
  type Run,
  requireThat,
  type Source,
  type Workspace,
} from "../domain.ts";
import { validMemory } from "./conversation-memory.ts";

export function retainedSource(w: Workspace, source: Source, now = Date.now()) {
  return (
    Date.parse(source.expiresAt) > now &&
    Date.parse(source.retentionOriginAt ?? source.at) >
      now - w.settings.retentionDays * 86400000
  );
}

// Native topics take precedence over reply anchors. Both are scoped to bot and chat.
export function privateThread(
  w: Workspace,
  actor: string,
  botId: string | undefined,
  topicId: number,
  replyTo: number | undefined,
  now: Date,
) {
  const owned = w.threads?.filter(
    (t) => t.actor === actor && t.chatId === actor && t.botId === botId,
  );
  if (topicId !== 0) {
    const existing = owned?.find((t) => t.topicId === topicId);
    if (existing) return { thread: existing };
    const thread = {
      id: randomUUID(),
      actor,
      chatId: actor,
      botId,
      topicId,
      at: now.toISOString(),
    };
    w.threads ??= [];
    w.threads.push(thread);
    return { thread };
  }
  const ownedThreads = new Set(
    owned?.filter((t) => t.topicId === undefined).map((t) => t.id),
  );
  const ownedRuns = w.runs.filter(
    (r) =>
      r.actor === actor &&
      r.chatId === actor &&
      r.topicId === 0 &&
      r.threadId &&
      ownedThreads.has(r.threadId),
  );
  const delivery =
    replyTo === undefined
      ? undefined
      : w.deliveries.find(
          (d) =>
            d.actor === actor &&
            d.chatId === actor &&
            d.state === "sent" &&
            d.remoteId === replyTo &&
            ownedRuns.some((r) => r.id === d.runId),
        );
  const prior =
    replyTo === undefined
      ? undefined
      : ownedRuns.find(
          (r) =>
            r.actor === actor &&
            r.chatId === actor &&
            r.threadId &&
            (delivery ? r.id === delivery.runId : r.replyTo === replyTo),
        );
  const existing = w.threads?.find(
    (t) =>
      t.id === prior?.threadId &&
      t.actor === actor &&
      t.chatId === actor &&
      t.botId === botId &&
      w.messages.some(
        (m) =>
          m.threadId === t.id &&
          m.runId === prior?.id &&
          (delivery || m.role === "user") &&
          retainedSource(w, m, now.getTime()),
      ),
  );
  if (existing) return { thread: existing };
  const thread = {
    id: randomUUID(),
    actor,
    chatId: actor,
    botId,
    at: now.toISOString(),
  };
  w.threads ??= [];
  w.threads.push(thread);
  return {
    thread,
    notice:
      replyTo === undefined
        ? undefined
        : "Started a new conversation because the replied-to message has no available thread in this workspace.",
  };
}

export function threadSources(w: Workspace, run: Run, now = Date.now()) {
  const thread = w.threads?.find((t) => t.id === run.threadId);
  requireThat(thread && threadMatchesRun(thread, run), "thread_denied", 403);
  const position = w.runs.findIndex((r) => r.id === run.id);
  const predecessors = w.runs
    .slice(0, position + 1)
    .filter(
      (r) => !r.followup || r.followup.decision === "reply" || r.id === run.id,
    );
  const order = new Map(predecessors.map((r, index) => [r.id, index]));
  return w.messages
    .filter(
      (m) =>
        m.threadId === thread.id &&
        m.chatId === run.chatId &&
        m.topicId === run.topicId &&
        !!m.runId &&
        order.has(m.runId) &&
        retainedSource(w, m, now),
    )
    .sort(
      (a, b) =>
        (order.get(a.runId ?? "") ?? 0) - (order.get(b.runId ?? "") ?? 0) ||
        Number(a.role === "assistant") - Number(b.role === "assistant"),
    )
    .map((m) => structuredClone(m));
}

export function refreshThreadContext(w: Workspace, run: Run) {
  if (!run.threadId || run.transcript.length) return;
  run.sources = threadSources(w, run);
  const thread = w.threads?.find((t) => t.id === run.threadId);
  const summary = thread?.summary;
  run.contextSummary =
    summary && validMemory(summary, run.sources)
      ? structuredClone(summary)
      : undefined;
  run.coverage = `${run.sources.length} retained messages in this conversation. Other conversations are searched only when needed. Earlier messages may have expired.`;
}

export function recordThreadAnswer(w: Workspace, run: Run) {
  if (!run.threadId || !run.result) return;
  const id = `answer:${run.id}`;
  if (w.messages.some((m) => m.id === id)) return;
  w.messages.push({
    id,
    threadId: run.threadId,
    runId: run.id,
    role: "assistant",
    chatId: run.chatId,
    topicId: run.topicId,
    author: "assistant",
    text: run.result.slice(0, 2700),
    at: run.finishedAt ?? new Date().toISOString(),
    retentionOriginAt: new Date(
      Math.min(
        Date.parse(run.at),
        ...run.sources.map((s) => Date.parse(s.retentionOriginAt ?? s.at)),
      ),
    ).toISOString(),
    expiresAt: new Date(
      Math.min(
        Date.parse(run.at) + w.settings.retentionDays * 86400000,
        ...run.sources.map((s) => Date.parse(s.expiresAt)),
      ),
    ).toISOString(),
    directed: true,
  });
  w.messages = w.messages.slice(-2000);
}

export function threadMatchesRun(thread: ConversationThread, run: Run) {
  return (
    thread.chatId === run.chatId &&
    (thread.topicId === undefined || thread.topicId === run.topicId) &&
    (thread.kind === "group"
      ? run.chatId !== run.actor && !!thread.participants?.includes(run.actor)
      : run.chatId === run.actor && thread.actor === run.actor)
  );
}

export function hasDiscussionMemory(run: Run) {
  return (
    !!run.threadId &&
    !run.workflowId &&
    (run.topicId !== 0 || run.chatId !== run.actor)
  );
}

export function groupThread(
  w: Workspace,
  actor: string,
  chatId: string,
  topicId: number,
  botId: string,
  replyTo: number | undefined,
  now: Date,
) {
  const threads = (w.threads ?? []).filter(
    (t) =>
      t.kind === "group" &&
      t.chatId === chatId &&
      t.topicId === topicId &&
      t.botId === botId,
  );
  const delivery =
    replyTo === undefined
      ? undefined
      : w.deliveries.find(
          (d) =>
            d.chatId === chatId &&
            d.topicId === topicId &&
            d.state === "sent" &&
            d.remoteId === replyTo &&
            d.id === `run:${d.runId}:result`,
        );
  const anchor = delivery && w.runs.find((r) => r.id === delivery.runId);
  // A public answer in this same group/topic can invite another participant.
  const joined =
    anchor &&
    threads.find(
      (t) =>
        t.id === anchor.threadId &&
        w.messages.some(
          (m) =>
            m.threadId === t.id &&
            m.runId === anchor.id &&
            retainedSource(w, m, now.getTime()),
        ),
    );
  const latest = w.runs.findLast(
    (r) =>
      r.actor === actor &&
      threads.some(
        (t) => t.id === r.threadId && t.participants?.includes(actor),
      ) &&
      (!r.followup || r.followup.decision === "reply"),
  );
  let thread = joined ?? threads.find((t) => t.id === latest?.threadId);
  if (!thread) {
    thread = {
      id: randomUUID(),
      kind: "group",
      actor,
      participants: [actor],
      chatId,
      topicId,
      botId,
      at: now.toISOString(),
    };
    w.threads ??= [];
    w.threads.push(thread);
  } else if (!thread.participants?.includes(actor)) {
    thread.participants = [...(thread.participants ?? []), actor];
  }
  return { thread, notice: undefined };
}
