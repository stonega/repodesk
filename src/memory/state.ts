import { createHash } from "node:crypto";
import { browserRunPrivate } from "../browser/privacy.ts";
import type { Run, Source, Workspace } from "../domain.ts";
import { githubReadAllowed } from "../github/metadata-policy.ts";
import {
  memoryReferences,
  validMemory,
} from "../workspaces/conversation-memory.ts";
import { retainedSource } from "../workspaces/threads.ts";
import type { MemoryEntry, MemoryScope, MemoryState } from "./types.ts";

export const hashMemory = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
// JSONB can reorder object keys; identity must survive a database round trip.
export const scopeKey = (scope: MemoryScope) =>
  hashMemory([
    scope.kind,
    scope.botId,
    scope.chatId,
    scope.actor ?? null,
    scope.topicId ?? null,
  ]);
export function memoryState(w: Workspace): MemoryState {
  w.memory ??= {
    entries: [],
    jobs: [],
    checkpoints: [],
    indexes: [],
    forgotten: [],
    disabled: [],
  };
  return w.memory;
}
export function memoryScope(w: Workspace, r: Run): MemoryScope | undefined {
  if (r.workflowId || !r.threadId) return;
  const t = w.threads?.find((t) => t.id === r.threadId);
  if (!t?.botId || t.chatId !== r.chatId) return;
  if (r.chatId === r.actor && t.kind !== "group" && t.actor === r.actor)
    return {
      kind: "private",
      botId: t.botId,
      chatId: r.chatId,
      actor: r.actor,
    };
  if (
    t.kind === "group" &&
    t.topicId === r.topicId &&
    t.participants?.includes(r.actor)
  )
    return {
      kind: "group",
      botId: t.botId,
      chatId: r.chatId,
      topicId: r.topicId,
    };
}
export function scopeActive(w: Workspace, scope: MemoryScope) {
  return (
    !w.deletion &&
    !w.memory?.disabled.includes(scopeKey(scope)) &&
    (scope.kind === "private"
      ? w.members.some((m) => m.id === scope.actor && m.active)
      : w.chats.some((c) => c.id === scope.chatId && c.active))
  );
}
export function scopeSources(
  w: Workspace,
  scope: MemoryScope,
  now = Date.now(),
  actor?: string,
) {
  const origins = new Map(w.runs.map((r) => [r.id, r]));
  const threads = new Set(
    w.threads
      ?.filter(
        (t) =>
          t.botId === scope.botId &&
          t.chatId === scope.chatId &&
          (scope.kind === "private"
            ? t.kind !== "group" && t.actor === scope.actor
            : t.kind === "group" && t.topicId === scope.topicId),
      )
      .map((t) => t.id),
  );
  const forgotten = new Set(
    w.memory?.forgotten
      .filter((f) => scopeKey(f.scope) === scopeKey(scope))
      .flatMap((f) => f.sourceIds),
  );
  return w.messages.filter((s) => {
    if (
      s.browserRead ||
      !s.threadId ||
      !threads.has(s.threadId) ||
      !retainedSource(w, s, now) ||
      forgotten.has(s.id)
    )
      return false;
    const origin = origins.get(s.runId ?? "");
    return (
      origin &&
      !browserRunPrivate(w, origin) &&
      !origin.cancelled &&
      (!origin.followup || origin.followup.decision === "reply") &&
      githubReadAllowed(w, actor ? { ...origin, actor } : origin)
    );
  });
}
export function entryValid(
  w: Workspace,
  entry: MemoryEntry,
  now = Date.now(),
  actor?: string,
) {
  return (
    scopeActive(w, entry.scope) &&
    validMemory(entry, scopeSources(w, entry.scope, now, actor))
  );
}
export function readableMemories(w: Workspace, r: Run, now = Date.now()) {
  const scope = memoryScope(w, r);
  if (
    !scope ||
    !scopeActive(w, scope) ||
    !w.members.some((m) => m.id === r.actor && m.active)
  )
    return [];
  const key = scopeKey(scope);
  const sources = scopeSources(w, scope, now, r.actor);
  return (w.memory?.entries ?? [])
    .filter((e) => scopeKey(e.scope) === key && validMemory(e, sources))
    .sort(
      (a, b) =>
        Number(!!b.explicit) - Number(!!a.explicit) ||
        b.usageCount - a.usageCount ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}
export function memoryInputHash(entries: MemoryEntry[]) {
  return hashMemory(
    entries
      .map((e) => [e.id, e.title, e.summary, e.sourceHash])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
export function memoryContextValid(w: Workspace, r: Run, history = false) {
  if (!r.memoryContext) return true;
  if (history)
    return (
      r.memoryContext.entryIds.every((id) =>
        w.memory?.entries.some((e) => e.id === id),
      ) && validMemory(r.memoryContext, w.messages)
    );
  const scope = memoryScope(w, r);
  if (!scope) return false;
  const entries = readableMemories(w, r);
  return (
    r.memoryContext.entryIds.every((id) => entries.some((e) => e.id === id)) &&
    validMemory(r.memoryContext, scopeSources(w, scope, Date.now(), r.actor))
  );
}
export function attachMemoryContext(w: Workspace, r: Run) {
  if (r.transcript.length) return;
  const entries = readableMemories(w, r);
  if (!entries.length) {
    delete r.memoryContext;
    return;
  }
  const scope = memoryScope(w, r) as MemoryScope;
  const index = w.memory?.indexes.find(
    (i) =>
      scopeKey(i.scope) === scopeKey(scope) &&
      i.inputHash === memoryInputHash(entries),
  );
  const selected = index
    ? entries.filter((e) => index.entryIds.includes(e.id))
    : entries.slice(0, 8);
  if (!selected.length) {
    delete r.memoryContext;
    return;
  }
  const ids = new Set(selected.flatMap((e) => e.sourceIds));
  r.memoryContext = {
    entryIds: selected.map((e) => e.id),
    text:
      index?.text ??
      selected
        .map((e) => `[memory:${e.id}] ${e.title}: ${e.summary.slice(0, 220)}`)
        .join("\n"),
    ...memoryReferences(scopeSources(w, scope).filter((s) => ids.has(s.id))),
  };
}
export function memoryDependencies(w: Workspace, r: Run): Source[] {
  const ids = new Set(r.memoryContext?.sourceIds);
  return w.messages.filter((s) => ids.has(s.id));
}
export function pruneMemories(w: Workspace, now = Date.now()) {
  if (w.deletion) {
    delete w.memory;
    return;
  }
  const state = w.memory;
  if (!state) return;
  // Disabled scopes retain their records, but cannot contribute context or work.
  const disabled = state.disabled;
  state.disabled = [];
  const sourcesByScope = new Map<string, Source[]>();
  state.entries = state.entries
    .filter((e) => {
      const key = scopeKey(e.scope);
      let sources = sourcesByScope.get(key);
      if (!sources) {
        sources = scopeActive(w, e.scope) ? scopeSources(w, e.scope, now) : [];
        sourcesByScope.set(key, sources);
      }
      return (
        validMemory(e, sources) &&
        Date.parse(e.lastUsedAt ?? e.updatedAt) > now - 30 * 86400000
      );
    })
    .slice(-256);
  state.disabled = disabled;
  const retained = new Set(
    w.messages.filter((s) => retainedSource(w, s, now)).map((s) => s.id),
  );
  state.forgotten = state.forgotten
    .map((f) => ({
      ...f,
      sourceIds: f.sourceIds.filter((id) => retained.has(id)),
    }))
    .filter((f) => f.sourceIds.length);
  state.checkpoints = state.checkpoints.filter((c) =>
    w.threads?.some((t) => t.id === c.threadId),
  );
  state.indexes = state.indexes.filter((i) =>
    i.entryIds.every((id) => state.entries.some((e) => e.id === id)),
  );
  state.jobs = state.jobs
    .filter((j) => {
      const keep =
        validMemory(j, scopeSources(w, j.scope, now)) &&
        Date.parse(j.at) > now - w.settings.retentionDays * 86400000;
      if (!keep)
        for (const a of w.runs.find((r) => r.id === j.runId)?.attempts ?? [])
          if (j.attemptIds.includes(a.id) && a.status === "reserved")
            a.status = "unknown";
      return keep;
    })
    .slice(-32);
}

/** Redact generated artifacts and model inputs; credentials never belong in recall. */
export function redactMemory(text: string) {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|\d{6,}:[A-Za-z0-9_-]{25,})\b/g,
      "[REDACTED]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, "$1[REDACTED]")
    .replace(
      /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[^\s,"';]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /([?&](?:token|key|secret|password|signature|sig|code)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@");
}

export function redactMemoryValue(value: unknown): unknown {
  if (typeof value === "string") return redactMemory(value);
  if (Array.isArray(value)) return value.map(redactMemoryValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, redactMemoryValue(val)]),
    );
  return value;
}
export function redactMemoryOutput(text: string) {
  try {
    return JSON.stringify(redactMemoryValue(JSON.parse(text)));
  } catch {
    return redactMemory(text);
  }
}
export function clipMemory(text: string, maxBytes: number) {
  let result = "",
    bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    result += char;
  }
  return result;
}
