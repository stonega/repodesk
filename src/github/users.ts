import { publicOrigin } from "../admin/site.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat, type Workspace } from "../domain.ts";
import { decrypt, encrypt, hash, token } from "../setup/credentials.ts";
import { audit, authorize, eligible } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import { type GitHubApp, GitHubRateLimitError } from "./app.ts";
import { availableGitHubAccount } from "./member-account.ts";
import type { GitHubApps } from "./registry.ts";
import { type GitHubUserAccess, invalidateGitHubWork } from "./user-access.ts";

export class GitHubUsers {
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private key: string,
    private origin: string,
  ) {}
  private async callback() {
    return `${await publicOrigin(this.store, this.origin)}/api/admin/github/callback`;
  }
  private scope(w: Workspace, actor: string) {
    return `github-user:${w.id}:${actor}`;
  }
  private async invalidateWork(sql: Sql, w: Workspace, actor: string) {
    invalidateGitHubWork(w, actor);
    await sql.query(
      `UPDATE coding_tasks SET data=data || '{"cancelRequested":true,"error":"github_user_access_denied"}'::jsonb,updated_at=now()
       WHERE workspace_id=$1 AND data->>'state' NOT IN ('review','failed','cancelled','unknown')
       AND (data->>'actor'=$2 OR id IN (SELECT task_id FROM coding_task_inputs WHERE workspace_id=$1 AND data->>'actor'=$2))`,
      [w.id, actor],
    );
  }
  private async app(w: Workspace) {
    requireThat(
      w.github?.installationId,
      "github_repository_not_connected",
      409,
    );
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    return app;
  }
  async begin(sql: Sql, w: Workspace, actor: string, botId: string) {
    authorize(w, actor);
    const app = await this.app(w);
    const state = `telegram_${token()}`,
      verifier = token();
    await sql.query("DELETE FROM github_user_flows WHERE expires_at<=now()");
    await sql.query(
      `INSERT INTO github_user_flows(state_hash,workspace_id,actor,bot_id,app_id,connection_revision,verifier,phase,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'oauth',now()+interval '10 minutes')
      ON CONFLICT(workspace_id,actor) DO UPDATE SET state_hash=EXCLUDED.state_hash,bot_id=EXCLUDED.bot_id,app_id=EXCLUDED.app_id,connection_revision=EXCLUDED.connection_revision,verifier=EXCLUDED.verifier,phase='oauth',identity=NULL,user_token=NULL,refresh_token=NULL,token_expires_at=NULL,expires_at=EXCLUDED.expires_at`,
      [
        hash(state),
        w.id,
        actor,
        botId,
        app.config.id,
        w.github?.revision,
        encrypt(this.key, this.scope(w, actor), verifier),
      ],
    );
    return app.authorizationUrl(state, verifier, await this.callback());
  }
  async callbackResult(state: string, code?: string) {
    requireThat(
      /^telegram_[A-Za-z0-9_-]{40,100}$/.test(state),
      "github_authorization_expired",
      409,
    );
    const row = (
      await this.store.pool.query(
        "UPDATE github_user_flows SET phase='exchanging' WHERE state_hash=$1 AND phase='oauth' AND expires_at>now() RETURNING *",
        [hash(state)],
      )
    ).rows[0];
    requireThat(row, "github_authorization_expired", 409);
    try {
      const w = await this.store.read(row.workspace_id);
      authorize(w, row.actor);
      const app = await this.app(w);
      requireThat(
        app.config.id === Number(row.app_id) &&
          w.github?.revision === row.connection_revision,
        "github_connection_changed",
        409,
      );
      requireThat(code, "github_authorization_cancelled", 400);
      const identity = await app.exchange(
        code,
        decrypt(this.key, this.scope(w, row.actor), row.verifier),
        await this.callback(),
      );
      await this.store.change(w.id, async (current, sql) => {
        authorize(current, row.actor);
        requireThat(
          current.github?.revision === row.connection_revision &&
            (await this.store.deployment(sql)).bot?.id === row.bot_id,
          "github_connection_changed",
          409,
        );
        const saved = await sql.query(
          "UPDATE github_user_flows SET phase='confirm',verifier='',identity=$2,user_token=$3,refresh_token=$4,token_expires_at=$5 WHERE state_hash=$1 AND phase='exchanging' AND expires_at>now() RETURNING state_hash",
          [
            hash(state),
            JSON.stringify({ id: identity.id, login: identity.login }),
            encrypt(this.key, this.scope(w, row.actor), identity.token),
            identity.refreshToken
              ? encrypt(
                  this.key,
                  `${this.scope(w, row.actor)}:refresh`,
                  identity.refreshToken,
                )
              : null,
            identity.expiresAt ?? null,
          ],
        );
        requireThat(saved.rowCount, "github_authorization_expired", 409);
        deliver(
          current,
          row.actor,
          row.actor,
          `Connect GitHub account ${identity.login} to your Telegram identity for this workspace? Confirm only if this is your account.`,
          {
            id: `github-user:${hash(state)}:confirm`,
            buttons: [
              [
                {
                  text: "Connect account",
                  callback_data: `github_confirm:${Buffer.from(hash(state), "hex").toString("base64url")}`,
                },
                {
                  text: "Reject",
                  callback_data: `github_reject:${Buffer.from(hash(state), "hex").toString("base64url")}`,
                },
              ],
            ],
          },
        );
      });
    } catch (error) {
      await this.store.pool.query(
        "DELETE FROM github_user_flows WHERE state_hash=$1",
        [hash(state)],
      );
      throw error;
    }
  }
  private async permissions(
    w: Workspace,
    app: GitHubApp,
    userToken: string,
    id: number,
    login: string,
  ): Promise<GitHubUserAccess> {
    const repos = await app.repositories(
      userToken,
      w.github?.installationId as number,
    );
    return {
      id,
      login,
      status: "connected",
      connectionRevision: w.github?.revision as number,
      syncedAt: new Date().toISOString(),
      repositories: repos.filter(
        (r) =>
          r.permissions?.pull &&
          w.github?.repositories.some(
            (selected) =>
              selected.id === r.id &&
              selected.full_name.toLowerCase() === r.full_name.toLowerCase(),
          ),
      ),
    };
  }
  async confirm(
    sql: Sql,
    w: Workspace,
    actor: string,
    botId: string,
    digest: string,
    accept: boolean,
  ) {
    authorize(w, actor);
    const row = (
      await sql.query(
        "SELECT * FROM github_user_flows WHERE state_hash=$1 AND workspace_id=$2 AND actor=$3 AND bot_id=$4 AND phase='confirm' AND expires_at>now() FOR UPDATE",
        [digest, w.id, actor, botId],
      )
    ).rows[0];
    requireThat(row, "github_authorization_expired", 409);
    if (!accept) {
      await sql.query("DELETE FROM github_user_flows WHERE state_hash=$1", [
        digest,
      ]);
      deliver(w, actor, actor, "GitHub account connection rejected.");
      return;
    }
    const app = await this.app(w);
    requireThat(
      Number(row.app_id) === app.config.id &&
        row.connection_revision === w.github?.revision,
      "github_connection_changed",
      409,
    );
    availableGitHubAccount(w, actor, row.identity.id);
    const conflict = await sql.query(
      "SELECT 1 FROM github_user_accounts WHERE workspace_id=$1 AND github_id=$2 AND actor<>$3",
      [w.id, row.identity.id, actor],
    );
    requireThat(!conflict.rowCount, "github_identity_already_linked", 409);
    const access = await this.permissions(
      w,
      app,
      decrypt(this.key, this.scope(w, actor), row.user_token),
      row.identity.id,
      row.identity.login,
    );
    const consumed = await sql.query(
      "DELETE FROM github_user_flows WHERE state_hash=$1 AND phase='confirm' AND expires_at>now() RETURNING state_hash",
      [digest],
    );
    requireThat(consumed.rowCount, "github_authorization_expired", 409);
    await sql.query(
      `INSERT INTO github_user_accounts(workspace_id,actor,github_id,app_id,user_token,refresh_token,token_expires_at,next_sync_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes') ON CONFLICT(workspace_id,actor) DO UPDATE SET github_id=EXCLUDED.github_id,app_id=EXCLUDED.app_id,user_token=EXCLUDED.user_token,refresh_token=EXCLUDED.refresh_token,token_expires_at=EXCLUDED.token_expires_at,next_sync_at=EXCLUDED.next_sync_at`,
      [
        w.id,
        actor,
        access.id,
        app.config.id,
        row.user_token,
        row.refresh_token,
        row.token_expires_at,
      ],
    );
    const member = w.members.find((m) => m.id === actor);
    requireThat(member, "access_denied", 403);
    await this.invalidateWork(sql, w, actor);
    member.github = access;
    member.githubAccount = { id: access.id, login: access.login };
    await sql.query("DELETE FROM github_user_flows WHERE state_hash=$1", [
      digest,
    ]);
    audit(w, actor, "github.user_connected", String(access.id));
    deliver(
      w,
      actor,
      actor,
      `GitHub account ${access.login} connected. Permissions synced for ${access.repositories.length} selected repositories. Use /github sync to refresh or /github disconnect to unlink.`,
    );
  }
  async sync(sql: Sql, w: Workspace, actor: string) {
    authorize(w, actor);
    const member = w.members.find((m) => m.id === actor);
    requireThat(member?.github, "github_account_not_connected", 409);
    const row = (
      await sql.query(
        "SELECT * FROM github_user_accounts WHERE workspace_id=$1 AND actor=$2",
        [w.id, actor],
      )
    ).rows[0];
    requireThat(row, "github_account_not_connected", 409);
    if (Date.parse(member.github.retryAt ?? "") > Date.now())
      return member.github;
    let access: GitHubUserAccess;
    let denied = false;
    let retryAt = Date.now() + 5 * 60000;
    try {
      const app = await this.app(w);
      requireThat(
        app.config.id === Number(row.app_id),
        "github_connection_changed",
        409,
      );
      let userToken = decrypt(this.key, this.scope(w, actor), row.user_token);
      if (
        row.token_expires_at &&
        new Date(row.token_expires_at).getTime() < Date.now() + 60000
      ) {
        requireThat(row.refresh_token, "github_authorization_expired", 409);
        const rotated = await app.refresh(
          decrypt(
            this.key,
            `${this.scope(w, actor)}:refresh`,
            row.refresh_token,
          ),
        );
        await sql.query(
          "UPDATE github_user_accounts SET user_token=$3,refresh_token=$4,token_expires_at=$5 WHERE workspace_id=$1 AND actor=$2",
          [
            w.id,
            actor,
            encrypt(this.key, this.scope(w, actor), rotated.token),
            rotated.refreshToken
              ? encrypt(
                  this.key,
                  `${this.scope(w, actor)}:refresh`,
                  rotated.refreshToken,
                )
              : null,
            rotated.expiresAt ?? null,
          ],
        );
        userToken = rotated.token;
      }
      const identity = await app.user(userToken);
      requireThat(
        identity.id === member.github.id,
        "github_identity_changed",
        403,
      );
      access = await this.permissions(
        w,
        app,
        userToken,
        identity.id,
        identity.login,
      );
    } catch (error) {
      denied =
        error instanceof Fault &&
        [
          "github_access_denied",
          "github_authorization_expired",
          "github_authorization_failed",
          "github_connection_changed",
          "github_identity_changed",
        ].includes(error.code);
      if (error instanceof GitHubRateLimitError)
        retryAt = Math.max(
          Date.now() +
            Math.min(
              3600000,
              300000 * 2 ** Math.min(member.github.syncFailures ?? 0, 4),
            ),
          error.retryAt,
        );
      const syncError = denied
        ? "github_access_denied"
        : error instanceof GitHubRateLimitError
          ? "github_rate_limited"
          : "github_unavailable";
      access = {
        ...member.github,
        status: "unavailable",
        repositories: denied ? [] : member.github.repositories,
        syncError,
        ...(error instanceof GitHubRateLimitError
          ? {
              retryAt: new Date(retryAt).toISOString(),
              syncFailures: (member.github.syncFailures ?? 0) + 1,
            }
          : {}),
      };
      this.store.log.write("github_user_sync_failed", {
        workspaceId: w.id,
        error: new Fault(syncError, 503),
      });
    }
    const prior = member.github;
    const lost =
      denied ||
      (access.status === "connected" &&
        (prior.id !== access.id ||
          prior.connectionRevision !== access.connectionRevision ||
          prior.repositories.some((r) => {
            const next = access.repositories.find(
              (n) => n.id === r.id && n.full_name === r.full_name,
            );
            return (
              !next ||
              (r.permissions?.push && !next.permissions?.push) ||
              (r.permissions?.admin && !next.permissions?.admin)
            );
          })));
    if (lost) await this.invalidateWork(sql, w, actor);
    member.github = access;
    await sql.query(
      "UPDATE github_user_accounts SET next_sync_at=$3 WHERE workspace_id=$1 AND actor=$2",
      [w.id, actor, new Date(retryAt)],
    );
    if (
      lost ||
      JSON.stringify(prior.repositories) !== JSON.stringify(access.repositories)
    )
      audit(w, actor, "github.permissions_synced", String(access.id));
    return access;
  }
  async disconnect(sql: Sql, w: Workspace, actor: string) {
    authorize(w, actor);
    await sql.query(
      "DELETE FROM github_user_accounts WHERE workspace_id=$1 AND actor=$2",
      [w.id, actor],
    );
    await sql.query(
      "DELETE FROM github_user_flows WHERE workspace_id=$1 AND actor=$2",
      [w.id, actor],
    );
    const member = w.members.find((m) => m.id === actor);
    if (member?.github)
      member.github = {
        ...member.github,
        status: "disconnected",
        repositories: [],
      };
    await this.invalidateWork(sql, w, actor);
    audit(w, actor, "github.user_disconnected", actor);
  }
  async syncDue() {
    await this.store.pool.query(
      "DELETE FROM github_user_flows WHERE expires_at<=now()",
    );
    const rows = (
      await this.store.pool.query(
        `UPDATE github_user_accounts SET next_sync_at=now()+interval '5 minutes' WHERE (workspace_id,actor) IN (SELECT workspace_id,actor FROM github_user_accounts WHERE next_sync_at<=now() ORDER BY next_sync_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING workspace_id,actor`,
      )
    ).rows;
    for (const row of rows) {
      try {
        await this.store.change(row.workspace_id, async (w, sql) => {
          if (!eligible(w, row.actor)) {
            await sql.query(
              "DELETE FROM github_user_accounts WHERE workspace_id=$1 AND actor=$2",
              [w.id, row.actor],
            );
            const member = w.members.find((m) => m.id === row.actor);
            if (member?.github)
              member.github = {
                ...member.github,
                status: "disconnected",
                repositories: [],
              };
            await this.invalidateWork(sql, w, row.actor);
            return;
          }
          await this.sync(sql, w, row.actor);
        });
      } catch {
        this.store.log.write("worker_maintenance_failed", {
          error: new Fault("github_user_sync_failed", 503),
        });
      }
    }
  }
}
