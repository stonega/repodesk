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
    const suite = w.plugins?.google?.google;
    const connected = suite
      ? suite.settings.enabled &&
        suite.connection &&
        !suite.connection.reconnectRequired &&
        suite.connection.id === scope?.connectionId &&
        w.plugins?.searchConsole?.settings.siteUrls.length &&
        [run, current].every((r) =>
          w.members.some(
            (m) =>
              m.id === r.actor &&
              m.active &&
              ["owner", "admin"].includes(m.role),
          ),
        )
      : w.plugins?.searchConsole?.settings.enabled &&
        w.plugins.searchConsole.credential;
    if (
      scope &&
      (run.chatId !== run.actor ||
        !!run.workflowId ||
        !connected ||
        w.plugins?.revision !== scope.revision ||
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
