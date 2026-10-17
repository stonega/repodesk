import { z } from "zod";
import { type Run, requireThat, type Workspace } from "../domain.ts";
import { membersWithProfiles } from "../workspaces/member-profile.ts";
import { threadMatchesRun } from "../workspaces/threads.ts";
import { summarizeRun } from "./run-statistics.ts";

export const historyPage = z.object({
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const threadKey = z.union([
  z.uuid(),
  z
    .string()
    .regex(
      /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    ),
]);
export interface TelegramUser {
  id: string;
  name?: string;
  username?: string;
}
export interface ThreadSummary {
  id: string;
  kind: "private" | "group" | "standalone" | "workflow";
  title: string;
  preview: string;
  at: string;
  updatedAt: string;
  status: Run["status"];
  requestCount: number;
  user: TelegramUser;
  group?: { id: string; title?: string };
  topicId: number;
  participants: TelegramUser[];
  participantCount: number;
}
type ThreadGroup = { id: string; kind: ThreadSummary["kind"]; runs: Run[] };
export interface ThreadHistoryPage {
  mode: "member" | "operator";
  items: ThreadSummary[];
  total: number;
  offset: number;
  limit: number;
}
export interface ThreadTurn {
  id: string;
  user: TelegramUser;
  task: string;
  result?: string;
  status: Run["status"];
  at: string;
  finishedAt?: string;
  model: string;
}
export interface ThreadDetail {
  mode: "member" | "operator";
  thread: ThreadSummary;
  statistics: ReturnType<typeof summarizeRun>;
  items: ThreadTurn[];
  total: number;
  offset: number;
  limit: number;
}

/** Identity comes from persisted routing, never a guessed user/chat/time window. */
export function threadGroups(w: Workspace) {
  const threads = new Map(w.threads?.map((thread) => [thread.id, thread]));
  const groups = new Map<string, ThreadGroup>();
  for (const run of w.runs) {
    // Unaccepted follow-up classifiers are not conversation turns.
    if (run.followup && run.followup.decision !== "reply") continue;
    const thread = run.threadId ? threads.get(run.threadId) : undefined;
    const grouped = thread && !run.workflowId && threadMatchesRun(thread, run);
    const id = grouped ? thread.id : `run-${run.id}`;
    const group: ThreadGroup = groups.get(id) ?? {
      id,
      kind: grouped
        ? thread.kind === "group"
          ? "group"
          : "private"
        : run.workflowId
          ? "workflow"
          : "standalone",
      runs: [],
    };
    group.runs.push(run);
    // Equal timestamps follow the last retained request's persisted order.
    groups.delete(id);
    groups.set(id, group);
  }
  return groups;
}

const preview = (text: string, limit: number) => {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};
const users = (w: Workspace) =>
  new Map(
    membersWithProfiles(w).map(({ id, name, username }) => [
      id,
      { id, name, username },
    ]),
  );

function summary(
  w: Workspace,
  group: ThreadGroup,
  profiles: ReturnType<typeof users>,
): ThreadSummary {
  const first = group.runs[0];
  const last = group.runs.at(-1);
  requireThat(first && last, "not_found", 404);
  const participants = [...new Set(group.runs.map((run) => run.actor))];
  const active =
    group.runs.findLast((run) => run.status === "running") ??
    group.runs.findLast((run) => run.status === "awaiting_approval") ??
    group.runs.findLast((run) => run.status === "queued");
  return {
    id: group.id,
    kind: group.kind,
    title: preview(first.task, 120) || "Conversation",
    preview: preview(last.result || last.task, 200),
    at: first.at,
    updatedAt: group.runs.reduce((latest, run) => {
      const at =
        run.finishedAt && run.finishedAt > run.at ? run.finishedAt : run.at;
      return at > latest ? at : latest;
    }, first.at),
    status: active?.status ?? last.status,
    requestCount: group.runs.length,
    user: profiles.get(first.actor) ?? { id: first.actor },
    group:
      first.chatId !== first.actor
        ? {
            id: first.chatId,
            title: w.chats.find((chat) => chat.id === first.chatId)?.title,
          }
        : undefined,
    topicId: first.topicId,
    participants: participants
      .slice(0, 3)
      .map((id) => profiles.get(id) ?? { id }),
    participantCount: participants.length,
  };
}

export function threadSummaries(w: Workspace, offset: number, limit: number) {
  const profiles = users(w);
  const items = [...threadGroups(w).values()].map((group) =>
    summary(w, group, profiles),
  );
  // Reverse insertion order breaks equal activity timestamps deterministically.
  items.reverse().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  };
}

export function threadDetail(
  w: Workspace,
  id: string,
  offset: number,
  limit: number,
) {
  const group = threadGroups(w).get(id);
  requireThat(group, "not_found", 404);
  const profiles = users(w);
  const statistics = summarizeRun({
    task: "",
    transcript: [],
    tools: {},
    attempts: group.runs.flatMap((run) => run.attempts),
  });
  statistics.messages = group.runs.reduce(
    (count, run) => count + 1 + Number(!!run.result),
    0,
  );
  statistics.toolCalls = group.runs.reduce(
    (count, run) => count + summarizeRun(run).toolCalls,
    0,
  );
  return {
    thread: summary(w, group, profiles),
    statistics,
    items: group.runs.slice(offset, offset + limit).map(
      (run): ThreadTurn => ({
        id: run.id,
        user: profiles.get(run.actor) ?? { id: run.actor },
        task: run.task,
        result: run.result,
        status: run.status,
        at: run.at,
        finishedAt: run.finishedAt,
        model: run.model,
      }),
    ),
    total: group.runs.length,
    offset,
    limit,
  };
}

export function runThreadKey(w: Workspace, run: Run) {
  const thread = w.threads?.find((thread) => thread.id === run.threadId);
  return thread && !run.workflowId && threadMatchesRun(thread, run)
    ? thread.id
    : `run-${run.id}`;
}
