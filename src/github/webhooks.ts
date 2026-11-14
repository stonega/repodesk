import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { operator } from "../admin/auth.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat } from "../domain.ts";
import { decrypt, encrypt } from "../setup/credentials.ts";
import { audit } from "../workspaces/policy.ts";
import {
  GitHubNotifications,
  type NotificationPayload,
} from "./notifications.ts";
import type { GitHubApps } from "./registry.ts";

export function verifyGitHubSignature(
  secret: string,
  body: Buffer,
  signature: string,
) {
  requireThat(
    /^sha256=[0-9a-f]{64}$/.test(signature),
    "unauthorized_webhook",
    401,
  );
  requireThat(
    timingSafeEqual(
      createHmac("sha256", secret).update(body).digest(),
      Buffer.from(signature.slice(7), "hex"),
    ),
    "unauthorized_webhook",
    401,
  );
}
export async function githubHookSecret(
  store: Store,
  apps: GitHubApps,
  key: string,
  operatorId: string,
) {
  const row = (
    await store.pool.query(
      "SELECT secret FROM review_bot_hooks WHERE operator_id=$1",
      [operatorId],
    )
  ).rows[0];
  return row
    ? decrypt(key, `review-hook:${operatorId}`, row.secret)
    : (await apps.get(operatorId))?.config.webhookSecret;
}
const positiveId = z.number().int().positive().safe();
const opened = z.object({
  action: z.literal("opened"),
  installation: z.object({ id: positiveId }),
  repository: z.object({
    id: positiveId,
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  }),
});
const item = z.object({
  number: positiveId,
  title: z.string().max(4096),
  user: z.object({ login: z.string().min(1).max(100) }),
  created_at: z.string().datetime(),
  draft: z.boolean().optional(),
  pull_request: z.unknown().optional(),
});
const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();

/** Shared ingress and recovery; Review Bot remains an independent consumer. */
export class GitHubWebhooks {
  readonly notifications: GitHubNotifications;
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private key: string,
  ) {
    this.notifications = new GitHubNotifications(store);
  }
  async configure(admin: Admin, workspaceId: string, value: unknown) {
    operator(admin);
    const input = z
      .object({ secret: z.string().trim().min(32).max(8192).optional() })
      .strict()
      .parse(value);
    requireThat(this.key, "coding_credentials_unavailable", 503);
    const secret = input.secret ?? randomBytes(32).toString("hex");
    await this.store.change(workspaceId, async (w, sql) => {
      requireThat(
        w.operatorId === admin.id && !w.deletion,
        "access_denied",
        403,
      );
      requireThat(
        await this.apps.get(w.operatorId),
        "github_app_not_configured",
        409,
      );
      await sql.query(
        "INSERT INTO review_bot_hooks(operator_id,secret) VALUES($1,$2) ON CONFLICT(operator_id) DO UPDATE SET secret=EXCLUDED.secret,updated_at=now()",
        [
          w.operatorId,
          encrypt(this.key, `review-hook:${w.operatorId}`, secret),
        ],
      );
      audit(w, admin.id, "github.webhook_configured", w.id);
    });
    return { secret };
  }
  async configured(operatorId: string) {
    return !!(await githubHookSecret(
      this.store,
      this.apps,
      this.key,
      operatorId,
    ));
  }
  async accept(
    operatorId: string,
    event: string,
    delivery: string,
    signature: string,
    body: Buffer,
  ) {
    z.uuid().parse(operatorId);
    requireThat(
      /^[a-zA-Z0-9-]{1,100}$/.test(delivery),
      "invalid_github_delivery",
    );
    const secret = await githubHookSecret(
      this.store,
      this.apps,
      this.key,
      operatorId,
    );
    requireThat(secret, "unauthorized_webhook", 401);
    verifyGitHubSignature(secret, body, signature);
    let raw: Record<string, unknown>;
    try {
      raw = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(body.toString("utf8")));
    } catch {
      throw new Fault("invalid_github_event");
    }
    const app = await this.apps.get(operatorId);
    requireThat(app, "github_app_not_configured", 409);
    if (
      (event === "installation" &&
        ["deleted", "suspend"].includes(String(raw.action))) ||
      (event === "installation_repositories" && raw.action === "removed")
    ) {
      const lifecycle = z
        .object({
          installation: z.object({ id: positiveId }),
          repositories_removed: z
            .array(z.object({ id: positiveId }))
            .optional(),
        })
        .parse(raw);
      for (const id of await this.store.ids()) {
        const current = await this.store.read(id);
        if (
          current.operatorId !== operatorId ||
          current.github?.installationId !== lifecycle.installation.id
        )
          continue;
        await this.store.change(id, (w) => {
          if (
            w.operatorId !== operatorId ||
            w.github?.installationId !== lifecycle.installation.id
          )
            return;
          for (const s of w.githubNotifications ?? [])
            if (
              s.enabled &&
              (!lifecycle.repositories_removed ||
                lifecycle.repositories_removed.some(
                  (r) => r.id === s.repositoryId,
                ))
            ) {
              s.enabled = false;
              s.revoked = true;
              s.revision++;
            }
        });
      }
    }
    if (!["pull_request", "issues"].includes(event) || raw.action !== "opened")
      return { accepted: true };
    const interested = (
      await this.store.pool.query(
        "SELECT 1 FROM workspaces WHERE operator_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'githubNotifications','[]'::jsonb)) s WHERE s->>'enabled'='true') LIMIT 1",
        [operatorId],
      )
    ).rowCount;
    if (!interested) return { accepted: true };
    const base = opened.parse(raw);
    const data = item.parse(raw[event === "issues" ? "issue" : "pull_request"]);
    if (event === "issues" && data.pull_request !== undefined)
      return { accepted: true };
    const payload: NotificationPayload = {
      event: event as NotificationPayload["event"],
      installationId: base.installation.id,
      repositoryId: base.repository.id,
      repository: base.repository.full_name,
      number: data.number,
      title: clean(data.title).slice(0, 500),
      author: clean(data.user.login),
      draft: data.draft ?? false,
      createdAt: data.created_at,
    };
    if (Date.parse(payload.createdAt) < Date.now() - 3 * 86400000)
      return { accepted: true };
    await this.notifications.accept(
      operatorId,
      app.config.id,
      delivery,
      payload,
    );
    return { accepted: true };
  }
  async recover(operatorId: string, workspaceId?: string) {
    // A database lease bounds checks across worker instances and process restarts.
    const app = await this.apps.get(operatorId);
    if (!app) return;
    const due = await this.store.pool.query(
      "INSERT INTO github_webhook_recovery(operator_id,app_id,next_at) VALUES($1,$2,now()+interval '5 minutes') ON CONFLICT(operator_id) DO UPDATE SET next_at=now()+interval '5 minutes',app_id=EXCLUDED.app_id,cursor=CASE WHEN github_webhook_recovery.app_id=EXCLUDED.app_id THEN github_webhook_recovery.cursor END,attempts=CASE WHEN github_webhook_recovery.app_id=EXCLUDED.app_id THEN github_webhook_recovery.attempts ELSE '{}'::jsonb END WHERE github_webhook_recovery.next_at<=now() RETURNING cursor,attempts",
      [operatorId, app.config.id],
    );
    if (!due.rowCount) return;
    try {
      const state = due.rows[0];
      const batch = await app.webhookDeliveries(state.cursor ?? undefined);
      const attempts = state.attempts as Record<string, number>;
      const succeeded = new Set(
        batch.items
          .filter((d) => d.status_code >= 200 && d.status_code < 300)
          .map((d) => d.guid),
      );
      const retried = new Set<string>();
      for (const d of batch.items) {
        if (
          succeeded.has(d.guid) ||
          retried.has(d.guid) ||
          (d.status_code >= 200 && d.status_code < 300) ||
          (attempts[d.guid] ?? 0) >= 3 ||
          Date.parse(d.delivered_at) < Date.now() - 3 * 86400000 ||
          retried.size >= 3
        )
          continue;
        retried.add(d.guid);
        attempts[d.guid] = (attempts[d.guid] ?? 0) + 1;
        // Commit the retry reservation before HTTP; a lost response consumes it.
        await this.store.pool.query(
          "UPDATE github_webhook_recovery SET attempts=$3 WHERE operator_id=$1 AND app_id=$2",
          [operatorId, app.config.id, JSON.stringify(attempts)],
        );
        await app.redeliverWebhook(d.id);
      }
      const retained = Object.fromEntries(
        Object.entries(attempts).slice(-2000),
      );
      await this.store.pool.query(
        "UPDATE github_webhook_recovery SET cursor=$3,attempts=$4 WHERE operator_id=$1 AND app_id=$2",
        [
          operatorId,
          app.config.id,
          batch.cursor ?? null,
          JSON.stringify(retained),
        ],
      );
    } catch {
      this.store.log.write("github_webhook_recovery_failed", {
        workspaceId,
        error: new Fault("github_webhook_recovery_failed", 503),
      });
    }
  }
}
