import type { Run, Workspace } from "../domain.ts";
import { cloudflareHasCredentials } from "./config.ts";

/** Apply the same current scope to retained evidence, derived answers and delivery. */
export function cloudflareReadAllowed(w: Workspace, run: Run) {
  if (!run.cloudflareRead && !w.runs.some((r) => r.cloudflareRead)) return true;
  const origins = new Map(w.runs.map((r) => [r.id, r]));
  const pending = [run];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    const scope = current.cloudflareRead;
    if (
      scope &&
      (run.chatId !== run.actor ||
        !!run.workflowId ||
        !w.plugins?.cloudflare?.settings.enabled ||
        !cloudflareHasCredentials(w.plugins.cloudflare) ||
        w.plugins.revision !== scope.revision ||
        w.plugins.cloudflare.settings.accountId !== scope.accountId ||
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
