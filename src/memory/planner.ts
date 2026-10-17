import { randomUUID } from "node:crypto";
import type { Workspace } from "../domain.ts";
import {
  memoryReferences,
  validMemory,
} from "../workspaces/conversation-memory.ts";
import { eligible } from "../workspaces/policy.ts";
import {
  memoryInputHash,
  memoryScope,
  memoryState,
  pruneMemories,
  readableMemories,
  scopeActive,
  scopeKey,
  scopeSources,
} from "./state.ts";
import type { MemoryJob } from "./types.ts";

export const MEMORY_IDLE_MS = 30 * 60 * 1000;
export const MEMORY_LEASE_MS = 120000;
export function claimMemoryJob(
  w: Workspace,
  now = Date.now(),
  idleMs = MEMORY_IDLE_MS,
): MemoryJob | undefined {
  pruneMemories(w, now);
  if (w.deletion || w.settings.paused) return;
  const state = memoryState(w);
  if (
    state.jobs.some(
      (j) => j.status === "running" && Date.parse(j.leaseUntil) > now,
    )
  )
    return;
  for (const job of state.jobs) {
    if (
      !["running", "retry"].includes(job.status) ||
      Date.parse(job.retryAt ?? "1970-01-01") > now ||
      !scopeActive(w, job.scope)
    )
      continue;
    const run = w.runs.find((r) => r.id === job.runId);
    if (
      !run ||
      !eligible(w, run.actor) ||
      job.tries >= 3 ||
      run.attempts.some(
        (a) => job.attemptIds.includes(a.id) && a.status !== "settled",
      )
    ) {
      job.status = "failed";
      job.error = "memory_recovery_required";
      for (const a of run?.attempts ?? [])
        if (job.attemptIds.includes(a.id) && a.status === "reserved")
          a.status = "unknown";
      job.transcript = [];
      if (job.phase === "extract")
        state.checkpoints = [
          ...state.checkpoints.filter((c) => c.threadId !== job.threadId),
          {
            threadId: job.threadId,
            sourceHash: job.sourceHash,
            at: new Date(now).toISOString(),
          },
        ];
      continue;
    }
    job.status = "running";
    job.token = randomUUID();
    job.tries++;
    job.leaseUntil = new Date(now + MEMORY_LEASE_MS).toISOString();
    return structuredClone(job);
  }
  const threads = [...(w.threads ?? [])].reverse();
  for (const thread of threads) {
    const runs = w.runs.filter((r) => r.threadId === thread.id);
    if (
      runs.some((r) =>
        ["queued", "running", "awaiting_approval"].includes(r.status),
      )
    )
      continue;
    const parent = runs.findLast(
      (r) =>
        r.status === "succeeded" &&
        !r.cancelled &&
        !r.memoryMutation &&
        r.result &&
        eligible(w, r.actor),
    );
    if (!parent) continue;
    const scope = memoryScope(w, parent);
    if (!scope || !scopeActive(w, scope)) continue;
    const available = scopeSources(w, scope, now);
    const own = available.filter(
      (s) =>
        s.threadId === thread.id &&
        !w.runs.find((r) => r.id === s.runId)?.memoryMutation,
    );
    if (
      !own.some((s) => s.role === "user") ||
      !own.some((s) => s.role === "assistant")
    )
      continue;
    const lastAt = Math.max(...own.map((s) => Date.parse(s.at)));
    if (lastAt > now - idleMs) continue;
    const selected = [];
    let bytes = 0;
    for (const source of [...own].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(source));
      if (bytes + size > 24000) break;
      selected.unshift(source);
      bytes += size;
    }
    if (
      !selected.some((s) => s.role === "user") ||
      !selected.some((s) => s.role === "assistant")
    )
      continue;
    // Derived answers depend on originals too, including sources recalled from other threads.
    const ids = new Set(
      selected.flatMap((s) => {
        const origin = w.runs.find((r) => r.id === s.runId);
        return [
          s.id,
          ...(s.role === "assistant"
            ? [
                ...(origin?.sources.map((s) => s.id) ?? []),
                ...(origin?.memoryContext?.sourceIds ?? []),
              ]
            : []),
        ];
      }),
    );
    for (const id of state.entries.find((e) => e.id === `thread:${thread.id}`)
      ?.sourceIds ?? [])
      ids.add(id);
    const sources = available.filter((s) => ids.has(s.id));
    if (sources.length !== ids.size) continue;
    const refs = memoryReferences(sources);
    if (
      !validMemory(refs, available) ||
      state.checkpoints.some(
        (c) => c.threadId === thread.id && c.sourceHash === refs.sourceHash,
      ) ||
      state.jobs.some(
        (j) => j.threadId === thread.id && j.sourceHash === refs.sourceHash,
      )
    )
      continue;
    const job = {
      id: randomUUID(),
      scope,
      threadId: thread.id,
      runId: parent.id,
      phase: "extract" as const,
      status: "running" as const,
      token: randomUUID(),
      leaseUntil: new Date(now + MEMORY_LEASE_MS).toISOString(),
      tries: 1,
      transcript: [],
      attemptIds: [],
      at: new Date(now).toISOString(),
      inputSourceIds: selected.map((s) => s.id),
      ...refs,
    };
    state.jobs = [...state.jobs, job].slice(-32);
    return structuredClone(job);
  }
  // Explicit notes and source pruning can change a scope without a new extractable thread.
  for (const entry of state.entries) {
    if (
      !scopeActive(w, entry.scope) ||
      Date.parse(entry.updatedAt) > now - idleMs
    )
      continue;
    const parent = w.runs.findLast(
      (r) =>
        r.status === "succeeded" &&
        !r.cancelled &&
        eligible(w, r.actor) &&
        memoryScope(w, r) &&
        scopeKey(memoryScope(w, r) as typeof entry.scope) ===
          scopeKey(entry.scope),
    );
    if (!parent) continue;
    const entries = readableMemories(w, parent, now).slice(0, 48);
    const inputHash = memoryInputHash(entries);
    if (
      state.indexes.some(
        (i) =>
          scopeKey(i.scope) === scopeKey(entry.scope) &&
          i.inputHash === memoryInputHash(readableMemories(w, parent, now)),
      ) ||
      state.jobs.some(
        (j) =>
          scopeKey(j.scope) === scopeKey(entry.scope) &&
          j.inputHash === inputHash &&
          ["done", "failed", "running", "retry"].includes(j.status),
      )
    )
      continue;
    const ids = new Set(entries.flatMap((e) => e.sourceIds));
    const job: MemoryJob = {
      id: randomUUID(),
      scope: entry.scope,
      threadId: entry.threadId,
      runId: parent.id,
      phase: "consolidate",
      status: "running",
      token: randomUUID(),
      leaseUntil: new Date(now + MEMORY_LEASE_MS).toISOString(),
      tries: 1,
      transcript: [],
      attemptIds: [],
      inputHash,
      at: new Date(now).toISOString(),
      ...memoryReferences(
        scopeSources(w, entry.scope, now).filter((s) => ids.has(s.id)),
      ),
    };
    state.jobs = [...state.jobs, job].slice(-32);
    return structuredClone(job);
  }
}
