import { Type } from "typebox";
import { z } from "zod";
import type {
  DevelopmentInput,
  DevelopmentTask,
} from "../coding/development.ts";
import { checkCodingPayload, checkCodingTask } from "../coding/policy.ts";
import { checkDevelopment } from "../coding/tasks.ts";
import type { Sql } from "../db/pool.ts";
import {
  type Run,
  requireThat,
  type Source,
  type Workspace,
} from "../domain.ts";
import { githubReadAllowed } from "../github/metadata-policy.ts";
import { skillSourcesPresent } from "../skills/provenance.ts";
import { memoryReferences } from "../workspaces/conversation-memory.ts";
import { audience, runAllowed } from "../workspaces/policy.ts";

const querySchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export const workHandoffParameters = Type.Object(
  {
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);
interface Entry {
  id: string;
  kind: string;
  goal: string;
  status: string;
  nextAction: string;
  updatedAt: string;
  question?: string;
  summary?: string;
  prUrl?: string;
  verification?: unknown;
  checkpoint?: {
    phase: string;
    consumedRevision: number;
    stage?: string;
    observedAt?: number;
  };
  decisions?: string[];
  todos?: string[];
  runId?: string;
  topicId: number;
  chatId: string;
  repositoryId?: number;
  repository?: string;
  sources: Source[];
}
function readable(
  w: Workspace,
  r: Run,
  actor: string,
  chatId: string,
  topicId: number,
) {
  return r.chatId === r.actor
    ? actor === r.actor &&
        (chatId === actor || w.chats.some((c) => c.id === chatId && c.active))
    : chatId === r.chatId && topicId === r.topicId;
}
function visibleSource(w: Workspace, r: Run, s: Source) {
  return r.chatId === r.actor
    ? s.chatId === r.actor ||
        w.chats.some((chat) => chat.id === s.chatId && chat.active)
    : s.chatId === r.chatId && s.topicId === r.topicId;
}
function sourcesFor(w: Workspace, r: Run, ids: string[]) {
  const sources = w.messages.filter((s) => ids.includes(s.id));
  return ids.length &&
    sources.every((s) => visibleSource(w, r, s)) &&
    skillSourcesPresent(w, memoryReferences(sources)) &&
    new Set(ids).size === sources.length
    ? sources
    : undefined;
}
function allowed(check: () => void) {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}
function nextAction(state: string, pr = false) {
  if (state === "waiting")
    return "Answer the recorded question in the original task conversation.";
  if (state === "auth_required")
    return "Reconnect Codex authentication in the panel.";
  if (state === "unknown")
    return "Inspect the unconfirmed outcome before retrying.";
  if (state === "failed")
    return "Inspect the failure before starting further work.";
  if (state === "cancelled")
    return "Task stopped; previously created artifacts remain.";
  if (state === "review" || state === "succeeded")
    return pr
      ? "Review the linked PR in GitHub; merge status has not been fetched."
      : "Read the recorded result.";
  if (state === "awaiting_approval")
    return "Review the pending proposal in the original conversation.";
  return "Work is in progress; check the original task conversation.";
}

/** Pure aggregation after relational task inputs have been checked by the caller. */
function developmentEntries(
  w: Workspace,
  r: Run,
  cutoff: number,
  tasks: DevelopmentTask[],
): Entry[] {
  const entries: Entry[] = [];
  for (const task of tasks) {
    if (
      task.workspaceId !== w.id ||
      task.contentRemoved ||
      Date.parse(task.createdAt) <= cutoff ||
      !readable(w, r, task.actor, task.chatId, task.topicId) ||
      !allowed(() => checkDevelopment(w, task, r.actor, false, true))
    )
      continue;
    const sources = sourcesFor(w, r, [task.sourceId]);
    if (!sources) continue;
    entries.push({
      id: `development:${task.id}`,
      kind: "development",
      goal: task.payload.title,
      status:
        task.cancelRequested &&
        !["cancelled", "failed", "unknown"].includes(task.state)
          ? "stopping"
          : task.state,
      nextAction: task.cancelRequested
        ? "Wait for confirmed termination; publication may already be in flight."
        : nextAction(task.state, !!task.pr),
      updatedAt: task.updatedAt,
      question: task.question?.text,
      summary: task.result?.summary.slice(0, 1500),
      prUrl: task.pr?.url,
      verification: {
        revision: task.revision,
        verifiedRevision: task.verifiedRevision,
        currentRevisionVerified:
          task.verifiedRevision === task.revision &&
          task.result?.status === "completed",
      },
      checkpoint: {
        phase: task.phase,
        consumedRevision: task.consumedRevision,
        stage: task.progress?.stage,
        observedAt: task.progress?.observedAt,
      },
      topicId: task.topicId,
      chatId: task.chatId,
      repositoryId: task.payload.repositoryId,
      repository: task.payload.repository,
      sources,
    });
  }
  return entries;
}

function reviewedCodingEntries(w: Workspace, r: Run, cutoff: number): Entry[] {
  const entries: Entry[] = [];
  for (const task of w.codingTasks ?? []) {
    if (
      Date.parse(task.createdAt) <= cutoff ||
      !readable(w, r, task.actor, task.chatId, task.topicId) ||
      !allowed(() => {
        checkCodingTask(w, task);
        checkCodingPayload(w, r.actor, task.payload);
      })
    )
      continue;
    const origin = w.runs.find((run) => run.id === task.runId);
    const sources = origin
      ? sourcesFor(
          w,
          r,
          origin.sources.map((s) => s.id),
        )
      : undefined;
    if (!sources) continue;
    entries.push({
      id: `coding:${task.id}`,
      kind: "coding",
      goal: task.payload.title,
      status: task.state,
      nextAction: nextAction(task.state, !!task.prUrl),
      updatedAt: task.updatedAt,
      prUrl: task.prUrl,
      topicId: task.topicId,
      chatId: task.chatId,
      repositoryId: task.payload.repositoryId,
      repository: task.payload.repository,
      sources,
    });
  }
  return entries;
}

function assistantEntries(w: Workspace, r: Run, cutoff: number): Entry[] {
  const entries: Entry[] = [];
  for (const run of w.runs) {
    if (
      run.id === r.id ||
      run.codingTaskId ||
      run.cancelled ||
      Date.parse(run.at) <= cutoff ||
      !readable(w, r, run.actor, run.chatId, run.topicId) ||
      !githubReadAllowed(w, run) ||
      !runAllowed(w, run)
    )
      continue;
    const sources = sourcesFor(
      w,
      r,
      run.sources.map((s) => s.id),
    );
    if (!sources || !skillSourcesPresent(w, memoryReferences(run.sources)))
      continue;
    entries.push({
      id: `run:${run.id}`,
      kind: "assistant",
      runId: run.id,
      goal: run.task.slice(0, 1000),
      status: run.status,
      nextAction: nextAction(run.status),
      updatedAt: run.finishedAt ?? run.at,
      summary: run.result?.slice(0, 1500),
      chatId: run.chatId,
      topicId: run.topicId,
      sources,
    });
  }
  return entries;
}

function discussionEntries(w: Workspace, r: Run): Entry[] {
  const entries: Entry[] = [];
  for (const thread of w.threads ?? []) {
    if (
      r.chatId === r.actor
        ? thread.kind === "group" ||
          thread.actor !== r.actor ||
          thread.chatId !== r.actor
        : thread.kind !== "group" ||
          thread.chatId !== r.chatId ||
          (thread.topicId ?? 0) !== r.topicId
    )
      continue;
    for (const d of thread.discussions ?? []) {
      if (!skillSourcesPresent(w, d)) continue;
      const sources = sourcesFor(w, r, d.sourceIds);
      if (!sources) continue;
      entries.push({
        id: `discussion:${d.id}`,
        kind: "discussion",
        goal: d.title,
        summary: d.summary.slice(0, 1500),
        status: "discussion",
        nextAction: d.todos.length
          ? "Review the recorded next steps; they are reference notes, not executed tasks."
          : "Review the recorded decisions.",
        decisions: d.decisions,
        todos: d.todos,
        updatedAt: d.updatedAt,
        chatId: thread.chatId,
        topicId: thread.topicId ?? 0,
        sources,
      });
    }
  }
  return entries;
}

export function workHandoff(
  w: Workspace,
  r: Run,
  tasks: DevelopmentTask[],
  args: Record<string, unknown>,
) {
  audience(w, r.actor, r.chatId);
  const q = querySchema.parse(args);
  const cutoff = Date.now() - w.settings.retentionDays * 86400000;
  const entries: Entry[] = [
    ...developmentEntries(w, r, cutoff, tasks),
    ...reviewedCodingEntries(w, r, cutoff),
    ...assistantEntries(w, r, cutoff),
    ...discussionEntries(w, r),
  ];
  const attention = (e: Entry) =>
    [
      "waiting",
      "awaiting_approval",
      "review",
      "failed",
      "unknown",
      "auth_required",
    ].includes(e.status)
      ? 0
      : 1;
  let matches = entries
    .filter(
      (e) =>
        !q.query ||
        JSON.stringify(e).toLowerCase().includes(q.query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        attention(a) - attention(b) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
  if (q.cursor) {
    const index = matches.findIndex((e) => e.id === q.cursor);
    requireThat(index >= 0, "handoff_cursor_unavailable");
    matches = matches.slice(index + 1);
  }
  const selected = matches.slice(0, q.limit);
  const sources = selected.flatMap((e) => e.sources);
  if (sources.length) {
    const previous = r.handoffRead;
    const all = w.messages.filter(
      (s) =>
        sources.some((source) => source.id === s.id) ||
        previous?.references.sourceIds.includes(s.id),
    );
    r.handoffRead = {
      references: memoryReferences(all),
      runIds: [
        ...new Set([
          ...(previous?.runIds ?? []),
          ...selected.flatMap((e) => (e.runId ? [e.runId] : [])),
        ]),
      ],
      chatIds: [
        ...new Set([
          ...(previous?.chatIds ?? []),
          ...selected.map((e) => e.chatId),
        ]),
      ],
      repositoryIds: [
        ...new Set([
          ...(previous?.repositoryIds ?? []),
          ...selected.flatMap((e) => (e.repositoryId ? [e.repositoryId] : [])),
        ]),
      ],
      codingRevision: selected.some((e) => e.repositoryId)
        ? w.coding?.revision
        : previous?.codingRevision,
    };
    for (const source of sources)
      if (!r.sources.some((s) => s.id === source.id))
        r.sources.push(structuredClone(source));
  }
  return {
    retrievedAt: new Date().toISOString(),
    scope:
      r.chatId === r.actor
        ? "Your own retained work across permitted conversations and personal discussions."
        : "This group/topic only.",
    coverage:
      "Application records only; no personal agent folders or live PR merge state. Continuous tasks are bounded to the latest 200 records.",
    hasMore: matches.length > selected.length,
    nextCursor:
      matches.length > selected.length ? selected.at(-1)?.id : undefined,
    entries: selected.map(({ sources: originals, ...e }) => ({
      ...e,
      sourceIds: originals.map((s) => s.id),
    })),
  };
}

export async function queryWorkHandoff(
  sql: Sql,
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  querySchema.parse(args);
  const listed: DevelopmentTask[] = (
    await sql.query(
      r.chatId === r.actor
        ? "SELECT data FROM coding_tasks WHERE workspace_id=$1 AND data->>'actor'=$2 ORDER BY updated_at DESC,id DESC LIMIT 200"
        : "SELECT data FROM coding_tasks WHERE workspace_id=$1 AND data->>'chatId'=$2 AND data->>'topicId'=$3 ORDER BY updated_at DESC,id DESC LIMIT 200",
      r.chatId === r.actor
        ? [w.id, r.actor]
        : [w.id, r.chatId, String(r.topicId)],
    )
  ).rows.map((row) => row.data);
  const candidates = listed.filter(
    (task) =>
      !task.contentRemoved &&
      readable(w, r, task.actor, task.chatId, task.topicId) &&
      allowed(() => checkDevelopment(w, task, r.actor, false, true)),
  );
  const dependencies = new Map<string, string[]>();
  const inputs = candidates.length
    ? ((
        await sql.query(
          "SELECT task_id,data FROM coding_task_inputs WHERE workspace_id=$1 AND task_id=ANY($2::uuid[])",
          [w.id, candidates.map((t) => t.id)],
        )
      ).rows as { task_id: string; data: DevelopmentInput }[])
    : [];
  const contexts = candidates.length
    ? ((
        await sql.query(
          "SELECT task_id,data FROM coding_task_events WHERE workspace_id=$1 AND id='context' AND task_id=ANY($2::uuid[])",
          [w.id, candidates.map((t) => t.id)],
        )
      ).rows as { task_id: string; data: { sources?: Source[] } }[])
    : [];
  const tasks: DevelopmentTask[] = [];
  for (const task of candidates) {
    const taskInputs = inputs
      .filter((row) => row.task_id === task.id)
      .map((row) => row.data);
    const context =
      contexts.find((row) => row.task_id === task.id)?.data.sources ?? [];
    const originals = [
      ...taskInputs.map((input) => ({ id: input.sourceId, text: input.text })),
      ...context,
    ];
    if (
      !taskInputs.length ||
      !originals.every((input) =>
        w.messages.some(
          (s) =>
            s.id === input.id &&
            visibleSource(w, r, s) &&
            s.text === input.text &&
            Date.parse(s.expiresAt) > Date.now(),
        ),
      )
    )
      continue;
    tasks.push(task);
    dependencies.set(
      task.id,
      originals.map((s) => s.id),
    );
  }
  const result = workHandoff(w, r, tasks, args);
  // Every authenticated input used to produce a returned task remains a dependency.
  const selected = tasks.filter((t) =>
    result.entries.some((e) => e.id === `development:${t.id}`),
  );
  if (selected.length && r.handoffRead) {
    const ids = new Set(r.handoffRead.references.sourceIds);
    for (const task of selected)
      for (const id of dependencies.get(task.id) ?? []) ids.add(id);
    const sources = w.messages.filter((s) => ids.has(s.id));
    r.handoffRead.references = memoryReferences(sources);
    r.handoffRead.chatIds = [
      ...new Set([...r.handoffRead.chatIds, ...sources.map((s) => s.chatId)]),
    ];
    for (const s of sources)
      if (!r.sources.some((prior) => prior.id === s.id))
        r.sources.push(structuredClone(s));
  }
  return {
    ...result,
    continuousTaskCoverageLimited: listed.length === 200,
    complete: !result.hasMore && listed.length < 200,
  };
}
