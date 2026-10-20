import type { Run, Workspace } from "../domain.ts";
import { googlePlugins } from "./config.ts";

/** Recheck private/admin scope for retained answers, derived evidence and delivery. */
export function googleReadAllowed(w: Workspace, run: Run): boolean {
  if (!run.googleRead && !w.runs.some((r) => r.googleRead)) return true;
  const origins = new Map(w.runs.map((r) => [r.id, r]));
  const pending = [run];
  const seen = new Set<string>();
  const privateAdmin = (r: Run) =>
    r.chatId === r.actor &&
    !r.workflowId &&
    w.members.some(
      (m) =>
        m.id === r.actor && m.active && ["owner", "admin"].includes(m.role),
    );
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.googleRead) {
      if (!privateAdmin(run) || !privateAdmin(current)) return false;
      for (const plugin of googlePlugins) {
        const grant = current.googleRead[plugin];
        if (!grant) continue;
        const config = w.plugins?.google?.[plugin];
        if (
          !config?.settings.enabled ||
          !config.connection ||
          config.connection.reconnectRequired ||
          config.connection.id !== grant.connectionId ||
          w.plugins?.revision !== grant.revision
        )
          return false;
      }
    }
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
