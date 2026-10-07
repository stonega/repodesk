import type { MemoryReferences, Workspace } from "../domain.ts";
import { validMemory } from "../workspaces/conversation-memory.ts";

export function skillSourcesPresent(
  w: Workspace,
  refs: MemoryReferences,
  now = Date.now(),
) {
  return validMemory(
    refs,
    w.messages.filter(
      (s) =>
        Date.parse(s.expiresAt) > now &&
        Date.parse(s.retentionOriginAt ?? s.at) >
          now - w.settings.retentionDays * 86400000,
    ),
  );
}
