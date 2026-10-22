import type { Delivery, Run, Workspace } from "../domain.ts";
import { googlePlugins } from "./config.ts";

/** Recheck personal ownership for retained answers, derived evidence and delivery. */
export function googleReadAllowed(
  w: Workspace,
  run: Run,
  botId?: string,
): boolean {
  if (!run.googleRead && !w.runs.some((r) => r.googleRead)) return true;
  const origins = new Map(w.runs.map((r) => [r.id, r]));
  const pending = [run];
  const seen = new Set<string>();
  const privateMember = (r: Run) =>
    r.chatId === r.actor &&
    !r.workflowId &&
    w.members.some((m) => m.id === r.actor && m.active);
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.googleRead) {
      if (
        !privateMember(run) ||
        !privateMember(current) ||
        run.actor !== current.actor
      )
        return false;
      for (const plugin of googlePlugins) {
        const grant = current.googleRead[plugin];
        if (!grant) continue;
        const config = w.plugins?.google?.google;
        const user = w.googleUsers?.[current.actor];
        const connection = user?.connection;
        if (
          !config?.settings.enabled ||
          !connection ||
          (botId !== undefined && user?.botId !== botId) ||
          connection.reconnectRequired ||
          connection.id !== grant.connectionId ||
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

/** Suppress expired account links and selectors before queued Telegram delivery. */
export function googleDeliveryAllowed(
  w: Workspace,
  delivery: Delivery,
  botId?: string,
) {
  const control = delivery.googleControl;
  if (!control) return true;
  if (
    w.deletion ||
    delivery.chatId !== delivery.actor ||
    control.botId !== botId ||
    !w.members.some((m) => m.id === delivery.actor && m.active)
  )
    return false;
  const user = w.googleUsers?.[delivery.actor];
  if (
    control.connectionId &&
    (user?.botId !== botId || user.connection?.id !== control.connectionId)
  )
    return false;
  const config = w.plugins?.google?.google;
  if (control.flow) {
    const flow = user?.flow;
    return !!(
      config?.settings.enabled &&
      user?.botId === botId &&
      flow &&
      flow.stateHash === control.flow.hash &&
      flow.revision === w.plugins?.revision &&
      Date.parse(flow.expiresAt) > Date.now() &&
      (control.flow.phase === "confirm" ? flow.candidate : !flow.exchanging)
    );
  }
  if (control.properties) {
    const draft = user?.properties;
    return !!(
      config?.settings.enabled &&
      user?.botId === botId &&
      draft &&
      draft.key === control.properties &&
      draft.connectionId === user.connection?.id &&
      draft.revision === w.plugins?.revision &&
      Date.parse(draft.expiresAt) > Date.now()
    );
  }
  return true;
}
