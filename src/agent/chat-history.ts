import { Type } from "typebox";
import { z } from "zod";
import {
  type ConversationThread,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { eligible } from "../workspaces/policy.ts";
import { retainedSource } from "../workspaces/threads.ts";
import { topicDiscussions } from "./discussions.ts";

const argumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    threadId: z.string().uuid().optional(),
    discussionId: z.string().uuid().optional(),
    before: z.iso.datetime().optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export const chatHistoryParameters = Type.Object(
  {
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    threadId: Type.Optional(Type.String({ format: "uuid" })),
    discussionId: Type.Optional(Type.String({ format: "uuid" })),
    before: Type.Optional(Type.String({ format: "date-time" })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

export function authorizeChatHistory(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  requireThat(
    r.threadId &&
      eligible(w, r.actor) &&
      (r.chatId === r.actor ||
        w.chats.some((c) => c.id === r.chatId && c.active)),
    "private_history_only",
    403,
  );
  const parsed = argumentsSchema.parse(args);
  if (parsed.discussionId) {
    requireThat(
      !parsed.threadId || parsed.threadId === r.threadId,
      "discussion_not_found",
      404,
    );
    requireThat(
      topicDiscussions(w, r).discussions.some(
        (d) => d.id === parsed.discussionId,
      ),
      "discussion_not_found",
      404,
    );
  }
  if (parsed.threadId)
    requireThat(
      w.threads?.some(
        (t) => t.id === parsed.threadId && readableThread(w, r, t),
      ),
      "thread_not_found",
      404,
    );
  return parsed;
}

export function queryChatHistory(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  const parsed = authorizeChatHistory(w, r, args);
  const discussion = parsed.discussionId
    ? topicDiscussions(w, r).discussions.find(
        (d) => d.id === parsed.discussionId,
      )
    : undefined;
  const threads = new Set(
    w.threads
      ?.filter(
        (t) =>
          readableThread(w, r, t) &&
          (!parsed.threadId || t.id === parsed.threadId),
      )
      .map((t) => t.id),
  );
  let matches = w.messages
    .filter(
      (m) =>
        m.chatId === r.chatId &&
        (r.chatId === r.actor || m.topicId === r.topicId) &&
        (!m.runId ||
          !w.runs.find((run) => run.id === m.runId)?.followup ||
          w.runs.find((run) => run.id === m.runId)?.followup?.decision ===
            "reply") &&
        m.threadId &&
        threads.has(m.threadId) &&
        (!discussion || discussion.messageIds.includes(m.id)) &&
        retainedSource(w, m) &&
        (!parsed.before || m.at < parsed.before) &&
        (!parsed.query ||
          m.text.toLowerCase().includes(parsed.query.toLowerCase())),
    )
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  if (parsed.cursor) {
    const position = matches.findIndex((m) => m.id === parsed.cursor);
    requireThat(position >= 0, "history_cursor_unavailable", 400);
    matches = matches.slice(position + 1);
  }
  const sources = matches.slice(0, parsed.limit).map((m) => {
    const index = parsed.query
      ? m.text.toLowerCase().indexOf(parsed.query.toLowerCase())
      : 0;
    const start = Math.max(0, index - 200);
    return { ...structuredClone(m), text: m.text.slice(start, start + 1000) };
  });
  // Retrieved excerpts become authorized citation sources for this execution only.
  for (const source of sources)
    if (!r.sources.some((s) => s.id === source.id)) r.sources.push(source);
  return {
    coverage:
      "Retained permitted conversations only: private history stays private; group retrieval stays in this group/topic. Text search is literal; results are excerpts, newest first. Older or pre-thread history may be unavailable.",
    hasMore: matches.length > sources.length,
    nextCursor:
      matches.length > sources.length ? sources.at(-1)?.id : undefined,
    messages: sources.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      role: m.role,
      author: m.author,
      at: m.at,
      text: m.text,
      telegramMessageId:
        m.role === "user"
          ? w.runs.find((run) => run.id === m.runId)?.replyTo
          : w.deliveries.find(
              (d) =>
                d.runId === m.runId &&
                d.id === `run:${m.runId}:result` &&
                d.state === "sent",
            )?.remoteId,
    })),
  };
}

function readableThread(w: Workspace, r: Run, t: ConversationThread) {
  if (r.chatId === r.actor)
    return t.kind !== "group" && t.actor === r.actor && t.chatId === r.actor;
  const current = w.threads?.find((thread) => thread.id === r.threadId);
  return (
    !!current &&
    t.kind === "group" &&
    t.chatId === r.chatId &&
    t.topicId === r.topicId &&
    t.botId === current.botId
  );
}
