import { type Run, requireThat, type Workspace } from "../domain.ts";
import {
  preferenceContextValid,
  preferencePack,
} from "../memory/preferences.ts";
import { preferenceSettings } from "../memory/settings.ts";
import {
  clipMemory,
  memoryScope,
  mergeMemoryReferences,
  readableMemories,
  referenceMemoryValid,
  scopeSources,
} from "../memory/state.ts";
import {
  memoryReferences,
  validMemory,
} from "../workspaces/conversation-memory.ts";
import type { DevelopmentTask } from "./development.ts";

export function taskMemory(w: Workspace, task: DevelopmentTask) {
  if (preferenceSettings(w).recall !== "pi_and_coding") return;
  const source = w.messages.find((s) => s.id === task.sourceId);
  const run = w.runs.find(
    (r) =>
      r.id === source?.runId &&
      r.actor === task.actor &&
      r.chatId === task.chatId &&
      r.topicId === task.topicId,
  );
  if (!run) return;
  const scope = memoryScope(w, run);
  if (!scope) return;
  let historical = readableMemories(w, run)
    .filter((entry) => !("taskId" in entry) || entry.taskId !== task.id)
    .slice(0, 8);
  const preference = preferencePack(
    w,
    { ...run, codingTaskId: task.id },
    task.payload.repositoryId,
    true,
  );
  let bytes = Buffer.byteLength(preference?.text ?? "");
  historical = historical.filter((e) => {
    const size = Buffer.byteLength(`[memory:${e.id}] ${e.summary}\n`);
    if (bytes + size > 24000) return false;
    bytes += size;
    return true;
  });
  const ids = new Set([
    ...historical.flatMap((e) => e.sourceIds),
    ...(preference?.sourceIds ?? []),
  ]);
  if (!ids.size) return;
  return {
    entryIds: historical.map((e) => e.id),
    preferences: preference?.preferences,
    text: clipMemory(
      [
        preference?.text ?? "",
        ...historical.map((e) => `[memory:${e.id}] ${e.summary}`),
      ].join("\n"),
      24000,
    ),
    ...memoryReferences(
      scopeSources(w, scope, Date.now(), task.actor).filter((s) =>
        ids.has(s.id),
      ),
    ),
  };
}
export function taskMemoryValid(w: Workspace, task: DevelopmentTask) {
  if (task.memoryInvalidated) return false;
  if (!referenceMemoryValid(w, task.referenceMemory, task.actor, task.botId))
    return false;
  if (!task.memory) return true;
  const source = w.messages.find((s) => s.id === task.sourceId);
  const run = w.runs.find(
    (r) => r.id === source?.runId && r.actor === task.actor,
  );
  const scope = run && memoryScope(w, run);
  return (
    !!scope &&
    preferenceSettings(w).recall === "pi_and_coding" &&
    preferenceContextValid(w, task.memory, task.actor) &&
    task.memory.entryIds.every((id) =>
      readableMemories(w, run).some((entry) => entry.id === id),
    ) &&
    validMemory(task.memory, scopeSources(w, scope, Date.now(), task.actor))
  );
}

/** A task result's memory dependencies follow it into Pi status and handoff replies. */
export function trackTaskMemory(w: Workspace, run: Run, task: DevelopmentTask) {
  requireThat(taskMemoryValid(w, task), "coding_memory_revoked", 409);
  const memory = mergeMemoryReferences(
    w,
    run.handoffRead?.memory,
    task.memory,
    task.referenceMemory,
  );
  if (!memory) return;
  const botId = w.threads?.find((thread) => thread.id === run.threadId)?.botId;
  requireThat(
    botId && referenceMemoryValid(w, memory, run.actor, botId),
    "coding_memory_revoked",
    409,
  );
  const { text: _text, ...refs } = memory;
  const ids = new Set([
    ...(run.handoffRead?.references.sourceIds ?? []),
    ...refs.sourceIds,
    task.sourceId,
  ]);
  const sources = w.messages.filter((s) => ids.has(s.id));
  run.handoffRead = {
    ...run.handoffRead,
    memory: refs,
    references: memoryReferences(sources),
    chatIds: [
      ...new Set([
        ...(run.handoffRead?.chatIds ?? []),
        ...sources.map((s) => s.chatId),
      ]),
    ],
    repositoryIds: [
      ...new Set([
        ...(run.handoffRead?.repositoryIds ?? []),
        task.payload.repositoryId,
      ]),
    ],
    codingRevision: w.coding?.revision,
  };
}
