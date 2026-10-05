import { z } from "zod";
import { operator } from "../admin/auth.ts";
import { deploymentOrigin } from "../admin/site.ts";
import {
  credentialsSchema,
  DEFAULT_MODEL_BASE_URL,
} from "../agent/model-settings.ts";
import { modelCapabilities, selectedModel } from "../agent/runtime.ts";
import { type Sql, transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Admin,
  type Deployment,
  requireThat,
  type Settings,
} from "../domain.ts";
import {
  type BotIdentity,
  registerWebhook,
  type Telegram,
  TelegramClient,
} from "../telegram/client.ts";
import {
  pollingStatus,
  type TelegramTransport,
} from "../telegram/polling-state.ts";
import { decideAccessRequest } from "../workspaces/access-requests.ts";
import { audit, revokeWork } from "../workspaces/policy.ts";
import { newWorkspace } from "../workspaces/service.ts";
import { decrypt, encrypt, hash, token } from "./credentials.ts";
export class SetupService {
  constructor(
    public store: Store,
    private key: string,
    private origin: string,
    private transport: (token: string) => Telegram = (t) =>
      new TelegramClient(t),
    public readonly telegramTransport: TelegramTransport = "webhook",
  ) {}
  async client(d?: Deployment) {
    d ??= await this.store.deployment();
    requireThat(d.credentials.bot, "bot_not_configured", 409);
    return this.transport(decrypt(this.key, "bot", d.credentials.bot));
  }
  async receiverStatus(d: Deployment, sql: Sql = this.store.pool) {
    return this.telegramTransport === "polling"
      ? pollingStatus(sql, d)
      : { ready: d.webhookReady, error: undefined };
  }
  async progress(admin: Admin) {
    operator(admin);
    const d = await this.store.deployment();
    const workspaces = (await this.store.all())
      .filter((w) => w.operatorId === admin.id)
      .map((w) => ({
        id: w.id,
        version: w.version,
        settings: w.settings,
        ownerVerified: w.members.some((m) => m.role === "owner"),
        skills: w.skills.map((s) => ({
          id: s.id,
          name: s.draft.name,
          enabled: s.enabled,
          published: s.published.length > 0,
        })),
        deleted: !!w.deletion,
        deletion: w.deletion,
      }));
    return {
      version: d.version,
      active: d.active,
      bot: d.bot,
      model: d.model,
      modelBaseUrl: d.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL,
      thinkingLevel: d.thinkingLevel ?? "off",
      modelPricing: d.modelPricing,
      modelLimits: d.modelLimits,
      modelCapabilities: modelCapabilities(d.model, d),
      webhookReady: d.webhookReady,
      telegramTransport: this.telegramTransport,
      receiver: await this.receiverStatus(d),
      paused: d.paused,
      credentials: { bot: !!d.credentials.bot, model: !!d.credentials.model },
      workspaces,
    };
  }
  async createWorkspace(admin: Admin, settings: Settings) {
    operator(admin);
    const w = newWorkspace(admin.id, settings);
    await transaction(this.store.pool, async (sql) => {
      await sql.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'workspace.created',$2)",
        [admin.id, w.id],
      );
    });
    return { id: w.id };
  }
  async saveCredentials(
    admin: Admin,
    input: z.infer<typeof credentialsSchema>,
  ) {
    operator(admin);
    input = credentialsSchema.parse(input);
    let identity: BotIdentity | undefined;
    if (input.botToken) {
      z.string()
        .regex(/^\d+:[A-Za-z0-9_-]{20,}$/)
        .parse(input.botToken);
      identity = await this.transport(input.botToken).call<BotIdentity>(
        "getMe",
      );
      requireThat(identity.is_bot && identity.username, "invalid_bot");
    }
    await transaction(this.store.pool, async (sql) => {
      const d = await this.store.deployment(sql, true);
      requireThat(d.version === input.version, "version_conflict", 409);
      const baseUrl =
        input.modelBaseUrl ?? d.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL;
      requireThat(
        baseUrl === (d.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL) ||
          !d.credentials.model ||
          input.modelKey,
        "new_endpoint_requires_api_key",
      );
      const modelChanged =
        (input.model !== undefined && input.model !== d.model) ||
        baseUrl !== (d.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL);
      const modelLimits =
        input.modelLimits !== undefined
          ? input.modelLimits
          : modelChanged
            ? undefined
            : d.modelLimits;
      // Updating Telegram alone must remain possible for an older custom-model setup.
      if (
        Object.keys(input).some(
          (key) => key !== "version" && key !== "botToken",
        )
      )
        selectedModel(input.model ?? d.model, {
          modelBaseUrl: baseUrl,
          thinkingLevel: input.thinkingLevel ?? d.thinkingLevel,
          modelPricing: input.modelPricing ?? d.modelPricing,
          modelLimits,
        });
      if (identity && input.botToken) {
        requireThat(
          !d.bot || d.bot.id === String(identity.id),
          "bot_identity_change_requires_new_deployment",
          409,
        );
        d.bot = {
          id: String(identity.id),
          username: identity.username,
          visibleAll: !!identity.can_read_all_group_messages,
        };
        d.credentials.bot = encrypt(this.key, "bot", input.botToken);
        d.webhookReady = false;
        d.active = false;
        d.credentials.webhook ??= encrypt(this.key, "webhook", token());
      }
      if (input.modelKey)
        d.credentials.model = encrypt(this.key, "model", input.modelKey);
      if (input.model) d.model = input.model;
      d.modelBaseUrl = baseUrl;
      d.modelLimits = modelLimits;
      if (input.thinkingLevel !== undefined)
        d.thinkingLevel = input.thinkingLevel;
      if (input.modelPricing !== undefined) d.modelPricing = input.modelPricing;
      d.version++;
      await this.store.saveDeployment(sql, d);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'credentials.updated','deployment')",
        [admin.id],
      );
    });
    return this.progress(admin);
  }
  async identityToken(admin: Admin, id: string) {
    const raw = token();
    await this.store.change(id, (w) => {
      requireThat(
        w.operatorId === admin.id ||
          (admin.telegramId &&
            w.members.some((m) => m.id === admin.telegramId && m.active)),
        "access_denied",
        403,
      );
      requireThat(!w.deletion, "workspace_deleted", 410);
      w.tokens = w.tokens.filter(
        (t) => !(t.kind === "identity" && t.adminId === admin.id),
      );
      w.tokens.push({
        hash: hash(raw),
        actor: "",
        kind: "identity",
        adminId: admin.id,
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      });
    });
    const d = await this.store.deployment();
    requireThat(d.bot, "bot_not_configured", 409);
    return {
      command: `/start verify_${raw}`,
      url: `https://t.me/${d.bot.username}?start=verify_${raw}`,
      expiresInMinutes: 15,
    };
  }
  async access(admin: Admin, id: string) {
    operator(admin);
    const w = await this.store.read(id);
    requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
    const d = await this.store.deployment();
    return {
      version: w.policy.version,
      members: w.members
        .filter((member) => member.active)
        .map((member) => ({
          id: member.id,
          role: member.role,
          allowed:
            w.policy.mode === "members" || w.policy.allowed.includes(member.id),
        })),
      requests: (w.accessRequests ?? []).filter(
        (request) => request.status === "pending",
      ),
      requestUrl: d.bot
        ? `https://t.me/${d.bot.username}?start=access_${w.id}`
        : null,
    };
  }
  async allowMember(admin: Admin, id: string, actor: string, version: number) {
    operator(admin);
    await this.store.change(id, (w) => {
      requireThat(
        w.operatorId === admin.id && !w.deletion,
        "access_denied",
        403,
      );
      requireThat(w.policy.version === version, "version_conflict", 409);
      const member = w.members.find((item) => item.id === actor);
      requireThat(
        member?.role !== "owner",
        "owner_requires_host_recovery",
        409,
      );
      if (member) {
        member.active = true;
      } else w.members.push({ id: actor, role: "member", active: true });
      if (!w.policy.allowed.includes(actor)) w.policy.allowed.push(actor);
      w.policy.version++;
      audit(w, admin.id, "member.updated", actor, w.policy.version);
      audit(w, admin.id, "access.allowed", actor, w.policy.version);
    });
    return this.access(admin, id);
  }
  async revokeMember(admin: Admin, id: string, actor: string, version: number) {
    operator(admin);
    await this.store.change(id, (w) => {
      requireThat(
        w.operatorId === admin.id && !w.deletion,
        "access_denied",
        403,
      );
      requireThat(w.policy.version === version, "version_conflict", 409);
      const member = w.members.find((item) => item.id === actor);
      requireThat(member && member.role !== "owner", "not_found", 404);
      member.active = false;
      w.policy.allowed = w.policy.allowed.filter((item) => item !== actor);
      w.policy.version++;
      revokeWork(w);
      audit(w, admin.id, "access.revoked", actor, w.policy.version);
    });
    return this.access(admin, id);
  }
  async decideAccess(
    admin: Admin,
    id: string,
    requestId: string,
    decision: "approved" | "rejected",
    version: number,
  ) {
    operator(admin);
    await this.store.change(id, async (w, sql) => {
      requireThat(
        w.operatorId === admin.id && !w.deletion,
        "access_denied",
        403,
      );
      const request = decideAccessRequest(
        w,
        admin.id,
        requestId,
        decision,
        version,
      );
      if (request.status === "approved")
        await sql.query(
          "INSERT INTO telegram_selections(actor,workspace_id) VALUES($1,$2) ON CONFLICT(actor) DO NOTHING",
          [request.actor, w.id],
        );
    });
    return this.access(admin, id);
  }
  async accountIdentityToken(
    operatorAdmin: Admin,
    accountId: string,
    workspaceId: string,
  ) {
    operator(operatorAdmin);
    const raw = token();
    await this.store.change(workspaceId, async (w, sql) => {
      requireThat(
        w.operatorId === operatorAdmin.id && !w.deletion,
        "access_denied",
        403,
      );
      const target = (
        await sql.query("SELECT id FROM admins WHERE id=$1", [accountId])
      ).rows[0];
      requireThat(target, "account_not_found", 404);
      w.tokens = w.tokens.filter(
        (t) => !(t.kind === "identity" && t.adminId === accountId),
      );
      w.tokens.push({
        hash: hash(raw),
        actor: "",
        kind: "identity",
        adminId: accountId,
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      });
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'identity.link_issued',$2)",
        [operatorAdmin.id, accountId],
      );
    });
    const d = await this.store.deployment();
    requireThat(d.bot, "bot_not_configured", 409);
    return {
      url: `https://t.me/${d.bot.username}?start=verify_${raw}`,
      command: `/start verify_${raw}`,
    };
  }
  async register(admin: Admin) {
    operator(admin);
    requireThat(
      this.telegramTransport === "webhook",
      "webhook_disabled_in_polling_mode",
      409,
    );
    const d = await this.store.deployment();
    const origin = deploymentOrigin(d, this.origin);
    requireThat(new URL(origin).protocol === "https:", "https_origin_required");
    requireThat(d.credentials.webhook, "bot_not_configured", 409);
    const result = await registerWebhook(
      await this.client(),
      origin,
      decrypt(this.key, "webhook", d.credentials.webhook),
    );
    await transaction(this.store.pool, async (sql) => {
      const current = await this.store.deployment(sql, true);
      requireThat(current.version === d.version, "version_conflict", 409);
      current.webhookReady = true;
      current.version++;
      await this.store.saveDeployment(sql, current);
    });
    return result;
  }
  async activate(admin: Admin) {
    operator(admin);
    await transaction(this.store.pool, async (sql) => {
      const d = await this.store.deployment(sql, true);
      requireThat(
        d.bot &&
          d.credentials.bot &&
          d.credentials.model &&
          (await this.receiverStatus(d, sql)).ready,
        "setup_incomplete",
        409,
      );
      selectedModel(d.model, d);
      const rows = await sql.query(
        "SELECT data FROM workspaces WHERE operator_id=$1 FOR UPDATE",
        [admin.id],
      );
      requireThat(
        rows.rows.some((r) => {
          const w = r.data;
          return (
            !w.deletion &&
            w.skills.some(
              (s: { enabled: boolean; published: unknown[] }) =>
                s.enabled && s.published.length,
            )
          );
        }),
        "workspace_and_skill_required",
        409,
      );
      d.active = true;
      d.ownerVerified = rows.rows.some((r) =>
        r.data.members.some(
          (m: { role: string; active: boolean }) =>
            m.role === "owner" && m.active,
        ),
      );
      d.version++;
      await this.store.saveDeployment(sql, d);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'deployment.activated','deployment')",
        [admin.id],
      );
    });
    return this.progress(admin);
  }
  async webhookSecret() {
    const d = await this.store.deployment();
    return d.credentials.webhook
      ? decrypt(this.key, "webhook", d.credentials.webhook)
      : undefined;
  }
  async modelKey(expectedBaseUrl?: string) {
    const d = await this.store.deployment();
    requireThat(d.credentials.model, "model_not_configured", 409);
    requireThat(
      !expectedBaseUrl ||
        expectedBaseUrl === (d.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL),
      "model_endpoint_changed",
      409,
    );
    return decrypt(this.key, "model", d.credentials.model);
  }
}
