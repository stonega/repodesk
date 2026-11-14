import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Delivery, requireThat, type Workspace } from "../domain.ts";
import { audit, authorize, eligible } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import { githubRepositoryScopeCurrent } from "./config.ts";
import { authorizeRepository, repositoryAccess } from "./user-access.ts";

export const notificationEvents = ["pull_request", "issues"] as const;
export type NotificationEvent = (typeof notificationEvents)[number];
export interface GitHubSubscription {
  id: string;
  actor: string;
  repositoryId: number;
  repository: string;
  installationId: number;
  connectionRevision: number;
  botId: string;
  events: NotificationEvent[];
  enabled: boolean;
  revision: number;
  since: string;
  revoked?: boolean;
}
export const notificationInput = z
  .object({
    action: z.enum(["list", "subscribe", "pause", "resume", "delete"]),
    repository: z.string().trim().min(1).max(150).optional(),
    events: z.array(z.enum(notificationEvents)).min(1).max(2).optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict();
export type NotificationInput = z.infer<typeof notificationInput>;
export interface NotificationPage {
  canManage: boolean;
  webhookUrl?: string;
  canConfigureWebhook?: boolean;
  subscriptions: (GitHubSubscription & {
    available: boolean;
    lastDelivery?: string;
  })[];
  repositories: { id: number; full_name: string }[];
  webhookConfigured: boolean;
}
export function notificationPage(
  w: Workspace,
  actor: string | undefined,
  botId: string | undefined,
  webhookConfigured: boolean,
): NotificationPage {
  const canManage = !!actor && eligible(w, actor);
  return {
    canManage,
    webhookConfigured,
    repositories: canManage
      ? (w.github?.repositories ?? [])
          .filter(
            (r) =>
              !r.archived && !r.disabled && repositoryAccess(w, actor, r.id),
          )
          .map((r) => ({ id: r.id, full_name: r.full_name }))
      : [],
    subscriptions: canManage
      ? (w.githubNotifications ?? [])
          .filter((s) => s.actor === actor)
          .map((s) => ({
            ...s,
            repository:
              w.github?.repositories.find((r) => r.id === s.repositoryId)
                ?.full_name ?? s.repository,
            available: subscriptionAllowed(w, { ...s, enabled: true }, botId),
            lastDelivery: w.deliveries.findLast(
              (d) => d.githubNotification?.subscriptionId === s.id,
            )?.state,
          }))
      : [],
  };
}

export function subscriptionAllowed(
  w: Workspace,
  s: GitHubSubscription,
  botId?: string,
) {
  const repository = w.github?.repositories.find(
    (r) => r.id === s.repositoryId,
  );
  return (
    s.enabled &&
    eligible(w, s.actor) &&
    s.botId === botId &&
    w.github?.installationId === s.installationId &&
    githubRepositoryScopeCurrent(w.github, s.connectionRevision, [
      s.repositoryId,
    ]) &&
    !!repository &&
    !repository.archived &&
    !repository.disabled &&
    repositoryAccess(w, s.actor, s.repositoryId)
  );
}
export function notificationDeliveryAllowed(
  w: Workspace,
  d: Delivery,
  botId?: string,
) {
  if (!d.githubNotification) return true;
  const s = w.githubNotifications?.find(
    (s) => s.id === d.githubNotification?.subscriptionId,
  );
  return (
    !!s &&
    s.revision === d.githubNotification.revision &&
    s.actor === d.actor &&
    d.chatId === s.actor &&
    d.topicId === 0 &&
    d.botId === botId &&
    subscriptionAllowed(w, s, botId)
  );
}
export function manageNotifications(
  w: Workspace,
  actor: string,
  botId: string,
  value: unknown,
) {
  authorize(w, actor);
  const input = notificationInput.parse(value);
  const own = () =>
    (w.githubNotifications ?? []).filter((s) => s.actor === actor);
  if (input.action === "list") return own();
  requireThat(input.repository, "notification_repository_required");
  const connected = w.github?.repositories.find(
    (r) =>
      r.full_name.toLowerCase() === input.repository?.toLowerCase() ||
      String(r.id) === input.repository,
  );
  let s = own().find(
    (s) =>
      s.repository.toLowerCase() === input.repository?.toLowerCase() ||
      String(s.repositoryId) === input.repository ||
      s.id === input.repository ||
      s.repositoryId === connected?.id,
  );
  if (s && connected) s.repository = connected.full_name;
  if (input.revision !== undefined)
    requireThat(s?.revision === input.revision, "version_conflict", 409);
  if (input.action === "subscribe" || input.action === "resume") {
    const repository = w.github?.repositories.find(
      (r) =>
        r.full_name.toLowerCase() === input.repository?.toLowerCase() ||
        String(r.id) === input.repository ||
        r.id === s?.repositoryId,
    );
    requireThat(
      repository &&
        !repository.archived &&
        !repository.disabled &&
        w.github?.installationId,
      "github_repository_not_connected",
      409,
    );
    authorizeRepository(w, actor, repository.id);
    requireThat(
      !s?.revoked || s.connectionRevision !== w.github.revision,
      "github_notification_connection_revoked",
      409,
    );
    if (!s) {
      requireThat(input.action === "subscribe", "not_found", 404);
      requireThat(
        (w.githubNotifications?.length ?? 0) < 200 && own().length < 50,
        "notification_capacity_reached",
        409,
      );
      s = {
        id: randomUUID(),
        actor,
        repositoryId: repository.id,
        repository: repository.full_name,
        installationId: w.github.installationId,
        connectionRevision: w.github.revision,
        botId,
        events: [...new Set(input.events ?? notificationEvents)],
        enabled: true,
        revision: 1,
        since: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      };
      w.githubNotifications ??= [];
      w.githubNotifications.push(s);
    } else {
      const events = input.events ?? s.events;
      if (
        !(
          s.enabled &&
          s.botId === botId &&
          s.installationId === w.github.installationId &&
          githubRepositoryScopeCurrent(w.github, s.connectionRevision, [
            repository.id,
          ]) &&
          events.length === s.events.length &&
          events.every((e) => s?.events.includes(e))
        )
      ) {
        Object.assign(s, {
          enabled: true,
          revoked: false,
          events: [...new Set(events)],
          botId,
          installationId: w.github.installationId,
          connectionRevision: w.github.revision,
          repository: repository.full_name,
          revision: s.revision + 1,
          since: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
        });
      }
    }
  } else {
    requireThat(s, "not_found", 404);
    s.enabled = false;
    s.revision++;
    if (input.action === "delete")
      w.githubNotifications = w.githubNotifications?.filter((t) => t !== s);
  }
  audit(w, actor, `github.notification.${input.action}`, s.id, s.revision);
  return own();
}

export interface NotificationPayload {
  event: NotificationEvent;
  installationId: number;
  repositoryId: number;
  repository: string;
  number: number;
  title: string;
  author: string;
  draft: boolean;
  createdAt: string;
}
export class GitHubNotifications {
  constructor(readonly store: Store) {}
  async accept(
    operatorId: string,
    appId: number,
    deliveryId: string,
    payload: NotificationPayload,
  ) {
    const deployment = await this.store.deployment();
    const candidates = await this.store.pool.query(
      "SELECT id FROM workspaces WHERE operator_id=$1 AND data#>>'{github,installationId}'=$2 AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'githubNotifications','[]'::jsonb)) s WHERE s->>'enabled'='true' AND s->>'repositoryId'=$3)",
      [
        operatorId,
        String(payload.installationId),
        String(payload.repositoryId),
      ],
    );
    for (const { id } of candidates.rows as { id: string }[]) {
      await this.store.change(id, async (w, sql) => {
        const recipients =
          w.githubNotifications
            ?.filter(
              (s) =>
                w.operatorId === operatorId &&
                s.installationId === payload.installationId &&
                s.repositoryId === payload.repositoryId &&
                s.events.includes(payload.event) &&
                Date.parse(s.since) <= Date.parse(payload.createdAt) &&
                subscriptionAllowed(w, s, deployment.bot?.id),
            )
            .map((s) => ({ id: s.id, revision: s.revision })) ?? [];
        if (!recipients.length) return;
        await sql.query(
          "INSERT INTO github_notification_events(id,workspace_id,app_id,delivery_id,event_key,payload,recipients) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [
            randomUUID(),
            id,
            appId,
            deliveryId,
            `${payload.installationId}:${payload.repositoryId}:${payload.event}:${payload.number}`,
            JSON.stringify(payload),
            JSON.stringify(recipients),
          ],
        );
      });
    }
  }
  async tick(workspaceId: string) {
    await this.store.change(workspaceId, async (w, sql) => {
      const deployment = await this.store.deployment(sql);
      await this.cleanup(sql, w.id);
      if (
        !deployment.active ||
        deployment.paused ||
        w.settings.paused ||
        w.deletion
      )
        return;
      const rows = await sql.query(
        "SELECT id,payload,recipients FROM github_notification_events WHERE workspace_id=$1 AND processed_at IS NULL ORDER BY created_at LIMIT 20 FOR UPDATE",
        [w.id],
      );
      for (const row of rows.rows) {
        const p = row.payload as NotificationPayload;
        for (const recipient of row.recipients as {
          id: string;
          revision: number;
        }[]) {
          const s = w.githubNotifications?.find((s) => s.id === recipient.id);
          if (
            !s ||
            s.revision !== recipient.revision ||
            !subscriptionAllowed(w, s, deployment.bot?.id)
          )
            continue;
          const repository = w.github?.repositories.find(
            (r) => r.id === p.repositoryId,
          );
          if (!repository) continue;
          const url = `https://github.com/${repository.full_name}/${p.event === "issues" ? "issues" : "pull"}/${p.number}`;
          const text = `${p.event === "issues" ? "📌 New issue" : "🔀 New PR"}${p.draft ? " (Draft)" : ""} · ${repository.full_name} #${p.number}\n${p.title}\nBy ${p.author}\n${url}`;
          const id = deliver(w, s.actor, s.actor, text, {
            id: `github-notification:${row.id}:${s.id}`,
            buttons: [[{ text: "View on GitHub", url }]],
          });
          const d = w.deliveries.find((d) => d.id === id);
          if (d) {
            d.botId = s.botId;
            d.githubNotification = {
              subscriptionId: s.id,
              revision: s.revision,
            };
          }
        }
        await sql.query(
          "UPDATE github_notification_events SET processed_at=now(),payload=NULL,recipients='[]'::jsonb WHERE id=$1 AND workspace_id=$2",
          [row.id, w.id],
        );
      }
    });
  }
  async cleanup(sql: Sql, workspaceId: string) {
    await sql.query(
      "DELETE FROM github_notification_events WHERE workspace_id=$1 AND created_at<now()-interval '30 days'",
      [workspaceId],
    );
  }
}
