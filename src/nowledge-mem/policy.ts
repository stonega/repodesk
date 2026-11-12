import type { Run, Workspace } from "../domain.ts";

/** Recheck private evidence transitively, including retained answers and handoffs. */
export function nowledgeReadAllowed(w: Workspace, run: Run, botId?: string) {
  if (!run.nowledgeRead && !w.runs.some((r) => r.nowledgeRead)) return true;
  const origins = new Map(w.runs.map((r) => [r.id, r]));
  const pending = [run],
    seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    const scope = current.nowledgeRead;
    const config = w.plugins?.nowledgeMem;
    if (
      scope &&
      (!config?.settings.enabled ||
        !config.credential ||
        w.plugins?.revision !== scope.revision ||
        config.botId !== scope.botId ||
        (botId !== undefined && botId !== scope.botId) ||
        run.actor !== current.actor ||
        run.actor !== config.settings.memberId ||
        [run, current].some((r) => r.chatId !== r.actor || !!r.workflowId) ||
        !w.members.some((m) => m.id === run.actor && m.active))
    )
      return false;
    for (const source of current.sources) {
      const origin =
        source.role === "assistant" && source.runId
          ? origins.get(source.runId)
          : undefined;
      if (origin) pending.push(origin);
    }
    for (const id of current.handoffRead?.runIds ?? []) {
      const origin = origins.get(id);
      if (origin) pending.push(origin);
    }
  }
  return true;
}
