import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Delivery, requireThat, type Workspace } from "../domain.ts";
import { audit, authorize, eligible } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import { githubRepositoryScopeCurrent } from "./config.ts";
import {
  authorizeRepository,
  repositoryAccess,
  repositoryMaintainer,
} from "./user-access.ts";

export const notificationEvents = ["pull_request", "issues"] as const;
export type NotificationEvent = (typeof notificationEvents)[number];
export interface GitHubNotificationSettings {
  autoNotifyMaintainers: boolean;
  revision: number;
  updatedAt?: string;
  revokedRevisions?: Record<string, number>;
}
export const notificationSettingsInput = z
  .object({
    autoNotifyMaintainers: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationSettingsInput = z.infer<
  typeof notificationSettingsInput
>;
export function githubNotificationSettings(w: Workspace) {
  return {
    autoNotifyMaintainers:
      w.githubNotificationSettings?.autoNotifyMaintainers ?? true,
    revision: w.githubNotificationSettings?.revision ?? 0,
    ...(w.githubNotificationSettings?.updatedAt
      ? { updatedAt: w.githubNotificationSettings.updatedAt }
      : {}),
  };
}
export function repositoryAutoRevoked(w: Workspace, repositoryId: number) {
  const rev = w.github?.revision;
  if (rev === undefined) return true;
  const revoked = w.githubNotificationSettings?.revokedRevisions;
  if (!revoked) return false;
  return revoked["*"] === rev || revoked[String(repositoryId)] === rev;
}
export function revokeAutoNotifications(
  w: Workspace,
  repositoryIds?: number[],
) {
  if (!w.github) return;
  const current = githubNotificationSettings(w);
  const revokedRevisions = {
    ...(w.githubNotificationSettings?.revokedRevisions ?? {}),
  };
  if (repositoryIds) {
    for (const id of repositoryIds)
      revokedRevisions[String(id)] = w.github.revision;
  } else {
    revokedRevisions["*"] = w.github.revision;
  }
  w.githubNotificationSettings = {
    ...w.githubNotificationSettings,
    autoNotifyMaintainers: current.autoNotifyMaintainers,
    revision: current.revision + 1,
    revokedRevisions,
  };
  const affected = repositoryIds ? new Set(repositoryIds) : undefined;
  for (const d of w.deliveries)
    if (
      d.state === "pending" &&
      d.githubNotification?.kind === "maintainer" &&
      (!affected || affected.has(d.githubNotification.repositoryId))
    )
      d.state = "cancelled";
}
export function updateNotificationSettings(
  w: Workspace,
  actor: string,
  value: unknown,
) {
  const input = notificationSettingsInput.parse(value);
  const current = githubNotificationSettings(w);
  requireThat(current.revision === input.revision, "version_conflict", 409);
  if (current.autoNotifyMaintainers === input.autoNotifyMaintainers)
    return current;
  const next: GitHubNotificationSettings = {
    ...w.githubNotificationSettings,
    autoNotifyMaintainers: input.autoNotifyMaintainers,
    revision: current.revision + 1,
    updatedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
  };
  w.githubNotificationSettings = next;
  if (!next.autoNotifyMaintainers)
    for (const d of w.deliveries)
      if (d.state === "pending" && d.githubNotification?.kind === "maintainer")
        d.state = "cancelled";
  audit(w, actor, "github.notification_settings_updated", w.id, next.revision);
  return githubNotificationSettings(w);
}
export function automaticMaintainerRepositories(w: Workspace, actor: string) {
  if (!githubNotificationSettings(w).autoNotifyMaintainers) return [];
  if (!eligible(w, actor)) return [];
  return (w.github?.repositories ?? [])
    .filter(
      (r) =>
        !r.archived &&
        !r.disabled &&
        !repositoryAutoRevoked(w, r.id) &&
        repositoryMaintainer(w, actor, r.id) &&
        !(w.githubNotifications ?? []).some(
          (s) => s.actor === actor && s.repositoryId === r.id,
        ),
    )
    .map((r) => ({ id: r.id, full_name: r.full_name }));
}
export function hasActiveGitHubNotifications(w: Workspace) {
  if (w.githubNotifications?.some((s) => s.enabled)) return true;
  if (!githubNotificationSettings(w).autoNotifyMaintainers) return false;
  if (!w.github?.installationId || !w.github.repositories.length) return false;
  return w.members.some(
    (m) => automaticMaintainerRepositories(w, m.id).length > 0,
  );
}
export interface AutoNotificationRepository {
  id: number;
  full_name: string;
  lastDelivery?: string;
}
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
  settings: {
    autoNotifyMaintainers: boolean;
    revision: number;
  };
  autoRepositories: AutoNotificationRepository[];
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
  const settings = githubNotificationSettings(w);
  return {
    canManage,
    webhookConfigured,
    settings: {
      autoNotifyMaintainers: settings.autoNotifyMaintainers,
      revision: settings.revision,
    },
    autoRepositories: canManage
      ? automaticMaintainerRepositories(w, actor).map((r) => ({
          ...r,
          lastDelivery: w.deliveries.findLast(
            (d) =>
              d.actor === actor &&
              d.githubNotification?.kind === "maintainer" &&
              d.githubNotification.repositoryId === r.id,
          )?.state,
        }))
      : [],
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
              (d) =>
                d.githubNotification &&
                d.githubNotification.kind !== "maintainer" &&
                d.githubNotification.subscriptionId === s.id,
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
export function autoMaintainerNotificationAllowed(
  w: Workspace,
  actor: string,
  repositoryId: number,
  botId?: string,
) {
  return (
    !!botId &&
    githubNotificationSettings(w).autoNotifyMaintainers &&
    eligible(w, actor) &&
    !repositoryAutoRevoked(w, repositoryId) &&
    repositoryMaintainer(w, actor, repositoryId) &&
    !(w.githubNotifications ?? []).some(
      (s) => s.actor === actor && s.repositoryId === repositoryId,
    )
  );
}
export function notificationDeliveryAllowed(
  w: Workspace,
  d: Delivery,
  botId?: string,
) {
  if (!d.githubNotification) return true;
  if (d.githubNotification.kind === "maintainer") {
    const n = d.githubNotification;
    const settings = githubNotificationSettings(w);
    return (
      settings.autoNotifyMaintainers &&
      settings.revision === n.settingsRevision &&
      d.chatId === d.actor &&
      d.topicId === 0 &&
      d.botId === botId &&
      w.github?.installationId === n.installationId &&
      githubRepositoryScopeCurrent(w.github, n.connectionRevision, [
        n.repositoryId,
      ]) &&
      autoMaintainerNotificationAllowed(w, d.actor, n.repositoryId, botId)
    );
  }
  const s = w.githubNotifications?.find(
    (s) =>
      d.githubNotification?.kind !== "maintainer" &&
      s.id === d.githubNotification?.subscriptionId,
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
function cancelPendingMaintainerDeliveries(
  w: Workspace,
  actor: string,
  repositoryId: number,
) {
  for (const d of w.deliveries)
    if (
      d.actor === actor &&
      d.state === "pending" &&
      d.githubNotification?.kind === "maintainer" &&
      d.githubNotification.repositoryId === repositoryId
    )
      d.state = "cancelled";
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
      cancelPendingMaintainerDeliveries(w, actor, repository.id);
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
      cancelPendingMaintainerDeliveries(w, actor, repository.id);
    }
  } else {
    if (!s && input.action === "pause" && connected) {
      requireThat(
        w.github?.installationId &&
          !connected.archived &&
          !connected.disabled &&
          githubNotificationSettings(w).autoNotifyMaintainers &&
          repositoryMaintainer(w, actor, connected.id),
        "not_found",
        404,
      );
      requireThat(
        (w.githubNotifications?.length ?? 0) < 200 && own().length < 50,
        "notification_capacity_reached",
        409,
      );
      s = {
        id: randomUUID(),
        actor,
        repositoryId: connected.id,
        repository: connected.full_name,
        installationId: w.github.installationId,
        connectionRevision: w.github.revision,
        botId,
        events: [...notificationEvents],
        enabled: false,
        revision: 1,
        since: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      };
      w.githubNotifications ??= [];
      w.githubNotifications.push(s);
      cancelPendingMaintainerDeliveries(w, actor, connected.id);
    } else {
      requireThat(s, "not_found", 404);
      s.enabled = false;
      s.revision++;
      cancelPendingMaintainerDeliveries(w, actor, s.repositoryId);
      if (input.action === "delete")
        w.githubNotifications = w.githubNotifications?.filter((t) => t !== s);
    }
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
  authorId?: number;
  draft: boolean;
  createdAt: string;
}
export type NotificationRecipient =
  | { kind?: "subscription"; id: string; revision: number }
  | {
      kind: "maintainer";
      actor: string;
      repositoryId: number;
      installationId: number;
      connectionRevision: number;
      settingsRevision: number;
      botId: string;
    };
function isSelfAuthored(
  member: Workspace["members"][number] | undefined,
  payload: Pick<NotificationPayload, "author" | "authorId">,
) {
  const github = member?.github;
  if (!github) return false;
  if (payload.authorId !== undefined) return github.id === payload.authorId;
  return github.login.toLowerCase() === payload.author.toLowerCase();
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
      "SELECT id FROM workspaces WHERE operator_id=$1 AND data->'deletion' IS NULL AND data#>>'{github,installationId}'=$2 AND (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'githubNotifications','[]'::jsonb)) s WHERE s->>'enabled'='true' AND s->>'repositoryId'=$3) OR (COALESCE(data#>>'{githubNotificationSettings,autoNotifyMaintainers}','true')='true' AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'members','[]'::jsonb)) m, jsonb_array_elements(COALESCE(m->'github'->'repositories','[]'::jsonb)) r WHERE m->>'active'='true' AND m->'github'->>'status'='connected' AND r->>'id'=$3 AND (r->'permissions'->>'maintain'='true' OR r->'permissions'->>'admin'='true'))))",
      [
        operatorId,
        String(payload.installationId),
        String(payload.repositoryId),
      ],
    );
    for (const { id } of candidates.rows as { id: string }[]) {
      await this.store.change(id, async (w, sql) => {
        if (
          w.deletion ||
          w.operatorId !== operatorId ||
          w.github?.installationId !== payload.installationId
        )
          return;
        const explicitByActor = new Set<string>();
        const recipients: NotificationRecipient[] = [];
        for (const s of w.githubNotifications ?? []) {
          if (s.repositoryId !== payload.repositoryId) continue;
          explicitByActor.add(s.actor);
          if (
            s.installationId === payload.installationId &&
            s.events.includes(payload.event) &&
            Date.parse(s.since) <= Date.parse(payload.createdAt) &&
            subscriptionAllowed(w, s, deployment.bot?.id)
          )
            recipients.push({
              kind: "subscription",
              id: s.id,
              revision: s.revision,
            });
        }
        const settings = githubNotificationSettings(w);
        if (
          deployment.bot?.id &&
          settings.autoNotifyMaintainers &&
          (!settings.updatedAt ||
            Date.parse(settings.updatedAt) <= Date.parse(payload.createdAt)) &&
          !repositoryAutoRevoked(w, payload.repositoryId)
        ) {
          for (const member of w.members) {
            if (
              explicitByActor.has(member.id) ||
              isSelfAuthored(member, payload) ||
              !autoMaintainerNotificationAllowed(
                w,
                member.id,
                payload.repositoryId,
                deployment.bot.id,
              )
            )
              continue;
            recipients.push({
              kind: "maintainer",
              actor: member.id,
              repositoryId: payload.repositoryId,
              installationId: payload.installationId,
              connectionRevision: w.github.revision,
              settingsRevision: settings.revision,
              botId: deployment.bot.id,
            });
          }
        }
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
      const settings = githubNotificationSettings(w);
      for (const row of rows.rows) {
        const p = row.payload as NotificationPayload;
        const repository = w.github?.repositories.find(
          (r) => r.id === p.repositoryId,
        );
        for (const recipient of row.recipients as NotificationRecipient[]) {
          if (!repository) continue;
          const url = `https://github.com/${repository.full_name}/${p.event === "issues" ? "issues" : "pull"}/${p.number}`;
          const text = `${p.event === "issues" ? "📌 New issue" : "🔀 New PR"}${p.draft ? " (Draft)" : ""} · ${repository.full_name} #${p.number}\n${p.title}\nBy ${p.author}\n${url}`;
          if (recipient.kind === "maintainer") {
            const member = w.members.find((m) => m.id === recipient.actor);
            if (
              !settings.autoNotifyMaintainers ||
              settings.revision !== recipient.settingsRevision ||
              deployment.bot?.id !== recipient.botId ||
              w.github?.installationId !== recipient.installationId ||
              !githubRepositoryScopeCurrent(
                w.github,
                recipient.connectionRevision,
                [recipient.repositoryId],
              ) ||
              isSelfAuthored(member, p) ||
              !autoMaintainerNotificationAllowed(
                w,
                recipient.actor,
                recipient.repositoryId,
                deployment.bot?.id,
              )
            )
              continue;
            const id = deliver(w, recipient.actor, recipient.actor, text, {
              id: `github-notification:${row.id}:maintainer:${recipient.actor}`,
              buttons: [[{ text: "View on GitHub", url }]],
            });
            const d = w.deliveries.find((d) => d.id === id);
            if (d) {
              d.botId = recipient.botId;
              d.githubNotification = {
                kind: "maintainer",
                repositoryId: recipient.repositoryId,
                installationId: recipient.installationId,
                connectionRevision: recipient.connectionRevision,
                settingsRevision: recipient.settingsRevision,
              };
            }
            continue;
          }
          const s = w.githubNotifications?.find((s) => s.id === recipient.id);
          if (
            !s ||
            s.revision !== recipient.revision ||
            !subscriptionAllowed(w, s, deployment.bot?.id)
          )
            continue;
          const id = deliver(w, s.actor, s.actor, text, {
            id: `github-notification:${row.id}:${s.id}`,
            buttons: [[{ text: "View on GitHub", url }]],
          });
          const d = w.deliveries.find((d) => d.id === id);
          if (d) {
            d.botId = s.botId;
            d.githubNotification = {
              kind: "subscription",
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
