import type { Run, Workspace } from "../domain.ts";

/** Apply the same current scope to retained evidence, derived answers and delivery. */
export function searchConsoleReadAllowed(
  w: Workspace,
  run: Run,
  botId?: string,
) {
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
    const user = w.googleUsers?.[current.actor];
    const connected =
      suite?.settings.enabled &&
      user?.connection &&
      (botId === undefined || user.botId === botId) &&
      !user.connection.reconnectRequired &&
      user.connection.id === scope?.connectionId &&
      user.siteRevision === scope?.selectionRevision &&
      run.actor === current.actor &&
      [run, current].every((r) =>
        w.members.some((m) => m.id === r.actor && m.active),
      );
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
