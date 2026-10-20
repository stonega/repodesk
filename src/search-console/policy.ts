import type { Run, Workspace } from "../domain.ts";

/** Apply the same current scope to retained evidence, derived answers and delivery. */
export function searchConsoleReadAllowed(w: Workspace, run: Run) {
  if (!run.searchConsoleRead && !w.runs.some((r) => r.searchConsoleRead))
    return true;
  const origins = new Map(w.runs.map((r) => [r.id, r]));
  const pending = [run];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    const scope = current.searchConsoleRead;
    if (
      scope &&
      (run.chatId !== run.actor ||
        !!run.workflowId ||
        !w.plugins?.searchConsole?.settings.enabled ||
        !w.plugins.searchConsole.credential ||
        w.plugins.revision !== scope.revision ||
        current.chatId !== current.actor ||
        !!current.workflowId)
    )
      return false;
    for (const source of current.sources) {
      if (
        source.role !== "assistant" ||
        !source.runId ||
        seen.has(source.runId)
      )
        continue;
      const origin = origins.get(source.runId);
      if (origin) pending.push(origin);
    }
    for (const id of current.handoffRead?.runIds ?? []) {
      const origin = origins.get(id);
      if (origin && !seen.has(id)) pending.push(origin);
    }
  }
  return true;
}
