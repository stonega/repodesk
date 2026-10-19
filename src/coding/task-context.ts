import type { Sql } from "../db/pool.ts";
import type { Run, Workspace } from "../domain.ts";
import { memoryReferences } from "../workspaces/conversation-memory.ts";
import { taskList } from "./task-store.ts";
import { checkDevelopment } from "./tasks.ts";

/** Small current-state snapshot, scoped separately from historical chat memory. */
export async function codingTaskContext(
  sql: Sql,
  w: Workspace,
  run: Run,
  botId?: string,
) {
  if (
    !botId ||
    run.workflowId ||
    !w.coding?.settings.enabled ||
    !w.github?.installationId
  )
    return [];
  const tasks = await taskList(sql, w.id);
  const candidates = tasks.filter((task) => {
    if (
      task.contentRemoved ||
      task.actor !== run.actor ||
      task.botId !== botId ||
      task.chatId !== run.chatId ||
      task.topicId !== run.topicId ||
      (run.threadId !== undefined &&
        w.messages.find((s) => s.id === task.sourceId)?.threadId !==
          run.threadId)
    )
      return false;
    try {
      checkDevelopment(w, task, run.actor, false, true);
      return true;
    } catch {
      return false;
    }
  });
  const snapshots = [];
  const sourceIds = new Set(run.handoffRead?.references.sourceIds);
  const repositoryIds = new Set(run.handoffRead?.repositoryIds);
  const acceptedInputs: {
    task_id: string;
    data: { sourceId: string; text: string };
  }[] = candidates.length
    ? (
        await sql.query(
          "SELECT task_id,data FROM coding_task_inputs WHERE workspace_id=$1 AND task_id=ANY($2::uuid[])",
          [w.id, candidates.map((t) => t.id)],
        )
      ).rows
    : [];
  const contexts: {
    task_id: string;
    data: { sources?: { id: string; text: string }[] };
  }[] = candidates.length
    ? (
        await sql.query(
          "SELECT task_id,data FROM coding_task_events WHERE workspace_id=$1 AND id='context' AND task_id=ANY($2::uuid[])",
          [w.id, candidates.map((t) => t.id)],
        )
      ).rows
    : [];
  for (const task of candidates) {
    const inputs = acceptedInputs
      .filter((row) => row.task_id === task.id)
      .map((row) => row.data);
    const references =
      contexts.find((row) => row.task_id === task.id)?.data.sources ?? [];
    const originals = [
      ...inputs.map((i) => ({ id: i.sourceId, text: i.text })),
      ...references,
    ];
    if (
      !inputs.length ||
      !originals.every((original) =>
        w.messages.some(
          (s) =>
            s.id === original.id &&
            s.text === original.text &&
            s.chatId === task.chatId &&
            s.topicId === task.topicId &&
            Date.parse(s.expiresAt) > Date.now(),
        ),
      )
    )
      continue;
    for (const original of originals) sourceIds.add(original.id);
    repositoryIds.add(task.payload.repositoryId);
    snapshots.push({
      taskId: task.id,
      repository: task.payload.repository,
      baseBranch: task.payload.baseBranch,
      state: task.state,
      cancelRequested: task.cancelRequested,
      question: task.question?.text,
      summary: task.result?.summary.slice(0, 1500),
      hasChanges: task.hasChanges,
      replacementTaskId: task.replacementTaskId,
      pr: task.pr?.url,
      error: task.error,
      observedAt: new Date().toISOString(),
    });
    if (snapshots.length === 5) break;
  }
  if (snapshots.length) {
    for (const source of w.messages)
      if (
        sourceIds.has(source.id) &&
        !run.sources.some((s) => s.id === source.id)
      )
        run.sources.push(structuredClone(source));
    run.handoffRead = {
      ...run.handoffRead,
      references: memoryReferences(
        w.messages.filter((s) => sourceIds.has(s.id)),
      ),
      chatIds: [...new Set([...(run.handoffRead?.chatIds ?? []), run.chatId])],
      repositoryIds: [...repositoryIds],
      codingRevision: w.coding?.revision,
    };
  }
  return snapshots;
}
export type CodingTaskContext = Awaited<ReturnType<typeof codingTaskContext>>;
