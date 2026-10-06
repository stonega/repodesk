import { createHash } from "node:crypto";
import type { MemoryReferences, Run, Source, Workspace } from "../domain.ts";

export function memoryReferences(sources: Source[]): MemoryReferences {
  const entries = [...new Map(sources.map((s) => [s.id, s])).values()].sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  return {
    sourceIds: entries.map((s) => s.id),
    sourceHash: createHash("sha256")
      .update(
        JSON.stringify(
          entries.map((s) => [
            s.id,
            s.text,
            s.author,
            s.role,
            s.runId,
            s.threadId,
            s.chatId,
            s.topicId,
            ...(s.attachments ? [s.attachments] : []),
          ]),
        ),
      )
      .digest("hex"),
  };
}

// Call with currently retained, authorized sources. Edits invalidate derived memory too.
export function validMemory(memory: MemoryReferences, sources: Source[]) {
  const ids = new Set(memory.sourceIds);
  const selected = sources.filter((s) => ids.has(s.id));
  return (
    selected.length === ids.size &&
    ids.size > 0 &&
    memoryReferences(selected).sourceHash === memory.sourceHash
  );
}

export function contextSources(run: Run) {
  const summarized = new Set(run.contextSummary?.sourceIds);
  return run.sources.filter((s) => !summarized.has(s.id));
}

export function commitDiscussions(w: Workspace, run: Run) {
  const thread = w.threads?.find((t) => t.id === run.threadId);
  if (!thread || !run.discussionUpdates?.length) return;
  // An older approval continuation must not overwrite more recent discussion state.
  if (
    w.runs
      .slice(w.runs.indexOf(run) + 1)
      .some((r) => r.threadId === run.threadId && r.result)
  ) {
    delete run.discussionUpdates;
    return;
  }
  const answer = w.messages.find((s) => s.id === `answer:${run.id}`);
  for (const update of run.discussionUpdates) {
    const dependencies = w.messages.filter((s) =>
      update.sourceIds.includes(s.id),
    );
    if (!validMemory(update, dependencies)) continue;
    if (answer) {
      dependencies.push(answer);
      update.messageIds = [...new Set([...update.messageIds, answer.id])];
    }
    Object.assign(update, memoryReferences(dependencies));
    thread.discussions = [
      ...(thread.discussions ?? []).filter((d) => d.id !== update.id),
      update,
    ].slice(-100);
    thread.activeDiscussionId = update.id;
  }
  delete run.discussionUpdates;
}
