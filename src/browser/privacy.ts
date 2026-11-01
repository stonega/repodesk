import type { DevelopmentTask } from "../coding/development.ts";
import type { BrowserReadStamp, Delivery, Run, Workspace } from "../domain.ts";
import { browserEnabled, browserGeneration } from "./config.ts";

export const browserEpoch = (w: Workspace, actor: string) =>
  w.browserEpochs?.[actor] ?? 0;

/** Source snapshots retain their own stamp when the originating run expires. */
export function browserPrivateGrants(w: Workspace, run: Run) {
  if (
    !run.browserRead &&
    !run.sources.some((source) => source.browserRead) &&
    !w.runs.some(
      (origin) =>
        origin.browserRead ||
        origin.sources.some((source) => source.browserRead),
    )
  )
    return [];
  const origins = new Map(w.runs.map((origin) => [origin.id, origin]));
  const pending = [run],
    seen = new Set<string>(),
    grants: BrowserReadStamp[] = [];
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.browserRead) grants.push(current.browserRead);
    for (const source of current.sources) {
      if (source.browserRead) grants.push(source.browserRead);
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
  return grants;
}

export const browserRunPrivate = (w: Workspace, run: Run) =>
  browserPrivateGrants(w, run).length > 0;
export const browserStampAllowed = (
  w: Workspace,
  grant: BrowserReadStamp,
  botId?: string,
) =>
  browserEnabled(w) &&
  !w.deletion &&
  w.members.some((member) => member.id === grant.owner && member.active) &&
  grant.generation === browserGeneration(w) &&
  grant.epoch === browserEpoch(w, grant.owner) &&
  (!botId || grant.botId === botId);
export function browserReadAllowed(w: Workspace, run: Run, botId?: string) {
  const grants = browserPrivateGrants(w, run);
  if (!grants.length) return true;
  return (
    run.chatId === run.actor &&
    !run.workflowId &&
    grants.every(
      (grant) =>
        run.actor === grant.owner && browserStampAllowed(w, grant, botId),
    )
  );
}
export function browserDeliveryAllowed(
  w: Workspace,
  delivery: Delivery,
  botId?: string,
) {
  const stamp = delivery.browserRead;
  return (
    !stamp ||
    (delivery.actor === stamp.owner &&
      delivery.chatId === stamp.owner &&
      browserStampAllowed(w, stamp, botId))
  );
}

/** Panel roles never substitute for verified personal browser ownership. */
export function browserPanelRun(w: Workspace, run: Run): Run {
  if (!browserRunPrivate(w, run)) return run;
  const safe = structuredClone(run);
  safe.task = "Private browser task";
  safe.sources = [];
  safe.instructions = [];
  safe.transcript = [];
  safe.tools = {};
  delete safe.result;
  delete safe.contextSummary;
  delete safe.compaction;
  delete safe.discussionUpdates;
  delete safe.pendingInputs;
  delete safe.memoryContext;
  delete safe.followup;
  delete safe.handoffRead;
  return safe;
}
export function browserPanelTask(task: DevelopmentTask): DevelopmentTask {
  if (!task.browserRead && !task.browserCapability) return task;
  const safe = structuredClone(task);
  delete safe.browserCapability;
  delete safe.browserBridgeOrigin;
  if (!task.browserRead) return safe;
  safe.payload = {
    ...safe.payload,
    title: "Private browser task",
    body: "Private browser task",
  };
  delete safe.result;
  delete safe.question;
  delete safe.referenceSources;
  delete safe.threadId;
  delete safe.progress;
  delete safe.browserWait;
  delete safe.browserCapability;
  return safe;
}
