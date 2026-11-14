import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "../db/pool.ts";
import {
  type Delivery,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import {
  audit,
  authorize,
  eligible,
  runAllowed,
} from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import type { PluginNotification } from "./contract.ts";
import { PluginError } from "./contract.ts";
import type { PackageInstallation } from "./package-config.ts";

export interface PluginSubscription {
  id: string;
  actor: string;
  repositoryId: number;
  digest: string;
  generation: number;
  botId: string;
  events: string[];
  enabled: boolean;
  revision: number;
  since: string;
}
export interface PluginNotificationPage {
  canManage: boolean;
  generation: number;
  available: boolean;
  events: { name: string; title: string; description: string }[];
  subscription?: PluginSubscription;
}
export function pluginNotificationPage(
  w: Workspace,
  actor: string | undefined,
  repositoryId: number,
  botId?: string,
): PluginNotificationPage {
  const p = w.plugins?.packages?.find(
    (p) => p.source.repositoryId === repositoryId,
  );
  requireThat(p, "not_found", 404);
  const subscription = w.pluginNotifications?.find(
    (s) => s.actor === actor && s.repositoryId === repositoryId,
  );
  return {
    canManage: !!actor && eligible(w, actor),
    generation: p.generation,
    available:
      !!p.enabled &&
      p.grants.includes("notifications.publish") &&
      (!subscription ||
        pluginSubscriptionAllowed(
          w,
          { ...subscription, enabled: true },
          botId,
        )),
    events: p.manifest.notifications ?? [],
    subscription,
  };
}
export const pluginNotificationInput = z
  .object({
    action: z.enum(["list", "subscribe", "pause", "resume", "delete"]),
    plugin: z.string().min(1).max(256).optional(),
    events: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/))
      .min(1)
      .max(16)
      .optional(),
    revision: z.number().int().positive().optional(),
    generation: z.number().int().positive().optional(),
  })
  .strict();
export function pluginSubscriptionAllowed(
  w: Workspace,
  s: PluginSubscription,
  botId?: string,
) {
  const p = w.plugins?.packages?.find(
    (p) => p.source.repositoryId === s.repositoryId,
  );
  return (
    s.enabled &&
    eligible(w, s.actor) &&
    s.botId === botId &&
    !!p?.enabled &&
    p.digest === s.digest &&
    p.generation === s.generation &&
    p.grants.includes("notifications.publish") &&
    s.events.every((e) => p.manifest.notifications?.some((n) => n.name === e))
  );
}
export function managePluginNotifications(
  w: Workspace,
  actor: string,
  botId: string,
  value: unknown,
) {
  authorize(w, actor);
  const input = pluginNotificationInput.parse(value);
  const own = () =>
    (w.pluginNotifications ?? []).filter((s) => s.actor === actor);
  if (input.action === "list")
    return {
      subscriptions: own(),
      plugins: (w.plugins?.packages ?? [])
        .filter((p) => p.enabled && p.grants.includes("notifications.publish"))
        .map((p) => ({
          repositoryId: p.source.repositoryId,
          name: p.manifest.name,
          repository: p.source.repository,
          events: p.manifest.notifications ?? [],
          generation: p.generation,
        })),
    };
  requireThat(input.plugin, "notification_plugin_required");
  const packages = (w.plugins?.packages ?? []).filter(
    (p) =>
      String(p.source.repositoryId) === input.plugin ||
      p.manifest.id === input.plugin ||
      p.source.repository.toLowerCase() === input.plugin?.toLowerCase(),
  );
  requireThat(packages.length <= 1, "notification_plugin_ambiguous");
  const p = packages[0];
  let s = own().find(
    (s) =>
      s.repositoryId === p?.source.repositoryId ||
      String(s.repositoryId) === input.plugin ||
      s.id === input.plugin,
  );
  if (input.revision !== undefined)
    requireThat(s?.revision === input.revision, "version_conflict", 409);
  if (input.action === "subscribe" || input.action === "resume") {
    if (input.generation !== undefined)
      requireThat(p?.generation === input.generation, "version_conflict", 409);
    requireThat(
      p?.enabled &&
        p.manifest.notifications?.length &&
        p.grants.includes("notifications.publish"),
      "notification_plugin_unavailable",
      409,
    );
    const events = [
      ...new Set(
        input.events ??
          s?.events ??
          p.manifest.notifications.map((e) => e.name),
      ),
    ];
    requireThat(
      events.every((event) =>
        p.manifest.notifications?.some((n) => n.name === event),
      ),
      "notification_event_unavailable",
      409,
    );
    if (!s) {
      requireThat(input.action === "subscribe", "not_found", 404);
      requireThat(
        (w.pluginNotifications?.length ?? 0) < 200 && own().length < 50,
        "notification_capacity_reached",
        409,
      );
      s = {
        id: randomUUID(),
        actor,
        repositoryId: p.source.repositoryId,
        digest: p.digest,
        generation: p.generation,
        botId,
        events,
        enabled: true,
        revision: 1,
        since: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      };
      w.pluginNotifications ??= [];
      w.pluginNotifications.push(s);
    } else if (
      !s.enabled ||
      s.digest !== p.digest ||
      s.generation !== p.generation ||
      s.botId !== botId ||
      events.length !== s.events.length ||
      events.some((e) => !s?.events.includes(e))
    ) {
      Object.assign(s, {
        enabled: true,
        digest: p.digest,
        generation: p.generation,
        botId,
        events,
        revision: s.revision + 1,
        since: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      });
    }
  } else {
    requireThat(s, "not_found", 404);
    s.enabled = false;
    s.revision++;
    if (input.action === "delete")
      w.pluginNotifications = w.pluginNotifications?.filter((t) => t !== s);
  }
  audit(w, actor, `plugin.notification.${input.action}`, s.id, s.revision);
  return { subscriptions: own() };
}
const clean = (v: string) => v.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
/** Called only after the complete sandbox result validates, under the tenant lock. */
export async function publishPluginNotifications(
  sql: Sql,
  w: Workspace,
  run: Run,
  pinned: PackageInstallation,
  events: PluginNotification[] | undefined,
  botId?: string,
) {
  if (!events?.length) return;
  const p = w.plugins?.packages?.find(
    (p) => p.source.repositoryId === pinned.source.repositoryId,
  );
  if (
    !p?.enabled ||
    p.digest !== pinned.digest ||
    p.generation !== pinned.generation ||
    !p.grants.includes("notifications.publish")
  )
    throw new PluginError("plugin_permission_denied");
  // Member HTTP connections can contain private data. Events never fan out to other members.
  if (
    run.chatId !== run.actor ||
    !runAllowed(w, run) ||
    !botId ||
    w.settings.paused
  )
    return;
  const s = w.pluginNotifications?.find(
    (s) => s.actor === run.actor && s.repositoryId === p.source.repositoryId,
  );
  if (!s || !pluginSubscriptionAllowed(w, s, botId)) return;
  for (const event of events) {
    const at = Date.parse(event.occurredAt);
    if (
      !s.events.includes(event.event) ||
      at < Date.parse(s.since) ||
      at < Date.now() - 3 * 86400000 ||
      at > Date.now() + 60000
    )
      continue;
    const key = createHash("sha256")
      .update(JSON.stringify([event.event, event.id]))
      .digest("hex");
    const receipt = randomUUID();
    const accepted = await sql.query(
      "INSERT INTO plugin_notification_events(id,workspace_id,actor,repository_id,event_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
      [receipt, w.id, run.actor, p.source.repositoryId, key],
    );
    if (!accepted.rowCount) continue;
    const id = deliver(
      w,
      run.actor,
      run.actor,
      `Plugin ${clean(p.manifest.name)} (${p.source.repository}): ${clean(event.title)}\n${clean(event.body)}`,
      {
        id: `plugin-notification:${receipt}`,
        runId: run.id,
        buttons: event.url
          ? [[{ text: "View source", url: event.url }]]
          : undefined,
      },
    );
    const d = w.deliveries.find((d) => d.id === id);
    if (d) {
      d.botId = botId;
      d.pluginNotification = { subscriptionId: s.id, revision: s.revision };
    }
  }
}
export function pluginNotificationDeliveryAllowed(
  w: Workspace,
  d: Delivery,
  botId?: string,
) {
  if (!d.pluginNotification) return true;
  const s = w.pluginNotifications?.find(
    (s) => s.id === d.pluginNotification?.subscriptionId,
  );
  return (
    !!s &&
    s.revision === d.pluginNotification.revision &&
    d.botId === botId &&
    d.actor === s.actor &&
    d.chatId === s.actor &&
    d.topicId === 0 &&
    pluginSubscriptionAllowed(w, s, botId)
  );
}
