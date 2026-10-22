import type { Run, Workspace } from "../domain.ts";
import { obsidianEnabled, obsidianGeneration } from "./vault.ts";

/** Include derived answers, so disabling cannot be bypassed through retained history. */
export function obsidianReadAllowed(w: Workspace, run: Run): boolean {
  if (!run.obsidianRead && !w.runs.some((r) => r.obsidianRead)) return true;
  const origins = new Map(w.runs.map((r) => [r.id, r]));
  const pending = [run];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (
      current.obsidianRead &&
      (!obsidianEnabled(w) ||
        current.obsidianRead.generation !== obsidianGeneration(w))
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
