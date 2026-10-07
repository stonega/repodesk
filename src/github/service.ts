import { z } from "zod";
import { operator, throttle } from "../admin/auth.ts";
import { publicOrigin } from "../admin/site.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, requireThat, type Workspace } from "../domain.ts";
import { decrypt, encrypt, hash, token } from "../setup/credentials.ts";
import { audit } from "../workspaces/policy.ts";
import type { GitHubApp, GitHubMemberDirectory } from "./app.ts";
import type { GitHubPage } from "./config.ts";
import {
  GitHubApps,
  githubAppPermissions,
  registrationInput,
} from "./registry.ts";
import { RepositorySync } from "./repository-sync.ts";

import { GitHubUsers } from "./users.ts";

const revisionSchema = z.number().int().nonnegative();
const selectionSchema = z.union([
  z
    .object({
      revision: revisionSchema,
      installationId: z.number().int().positive(),
      repositoryIds: z.array(z.number().int().positive()).min(1),
    })
    .strict(),
  z
    .object({
      revision: revisionSchema,
      installationId: z.number().int().positive(),
      allRepositories: z.literal(true),
    })
    .strict(),
]);
const flowState = (source?: "setup") =>
  source === "setup" ? `setup_${token()}` : token();
export function githubAuthority(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
export class GitHubService {
  private apps: GitHubApps;
  readonly repositorySync: RepositorySync;
  readonly users: GitHubUsers;
  constructor(
    private store: Store,
    private key: string,
    private origin: string,
    app?: GitHubApp | GitHubApps,
  ) {
    this.apps =
      app instanceof GitHubApps ? app : new GitHubApps(store, key, app);
    this.repositorySync = new RepositorySync(store, this.apps);
    this.users = new GitHubUsers(store, this.apps, key, origin);
  }
  private async callback() {
    return `${await publicOrigin(this.store, this.origin)}/api/admin/github/callback`;
  }
  async memberDirectory(w: Workspace): Promise<GitHubMemberDirectory> {
    const revision = w.github?.revision ?? 0;
    if (!w.github?.installationId)
      return { connected: false, revision, members: [] };
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    return {
      connected: true,
      revision,
      ...(await app.members(w.github.installationId, w.github.repositories)),
    };
  }
  private async workspace(admin: Admin, id: string) {
    operator(admin);
    const w = await this.store.read(id);
    githubAuthority(admin, w);
    return w;
  }
  private async flow(admin: Admin, id: string, sessionHash: string) {
    await this.workspace(admin, id);
    const row = (
      await this.store.pool.query(
        "SELECT * FROM github_flows WHERE workspace_id=$1 AND admin_id=$2 AND session_hash=$3 AND phase='selecting' AND expires_at>now()",
        [id, admin.id, sessionHash],
      )
    ).rows[0];
    requireThat(row?.user_token, "github_authorization_expired", 409);
    return {
      row,
      token: decrypt(this.key, `github:${id}:${sessionHash}`, row.user_token),
    };
  }
  async view(
    admin: Admin,
    id: string,
    sessionHash: string,
  ): Promise<GitHubPage> {
    const { workspace: w, refreshError } = await this.repositorySync.refresh(
      admin,
      id,
    );
    const app = await this.apps.get(w.operatorId);
    await this.store.pool.query(
      "DELETE FROM github_flows WHERE expires_at<=now()",
    );
    const row = (
      await this.store.pool.query(
        "SELECT login FROM github_flows WHERE workspace_id=$1 AND admin_id=$2 AND session_hash=$3 AND phase='selecting'",
        [id, admin.id, sessionHash],
      )
    ).rows[0];
    const installations =
      row && app
        ? await app.installations(
            (await this.flow(admin, id, sessionHash)).token,
          )
        : [];
    return {
      configured: !!app,
      canRegister: !app && this.apps.canRegister,
      appSlug: app?.config.slug,
      installUrl: app?.installUrl,
      connection: w.github,
      refreshError,
      revision: w.github?.revision ?? 0,
      pending: !!row,
      login: row?.login,
      installations,
    };
  }
  async begin(admin: Admin, id: string, sessionHash: string, source?: "setup") {
    const w = await this.workspace(admin, id);
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    await throttle(this.store.pool, `github:${admin.id}`);
    const state = flowState(source),
      verifier = token();
    await this.store.pool.query(
      "DELETE FROM github_flows WHERE expires_at<=now()",
    );
    await this.store.pool.query(
      "INSERT INTO github_flows(state_hash,workspace_id,admin_id,session_hash,verifier,phase,expires_at) VALUES($1,$2,$3,$4,$5,'oauth',now()+interval '10 minutes') ON CONFLICT(workspace_id,admin_id,session_hash) DO UPDATE SET state_hash=EXCLUDED.state_hash,verifier=EXCLUDED.verifier,phase='oauth',user_token=NULL,login=NULL,expires_at=EXCLUDED.expires_at",
      [
        hash(state),
        id,
        admin.id,
        sessionHash,
        encrypt(this.key, `github:${id}:${sessionHash}`, verifier),
      ],
    );
    return {
      url: app.authorizationUrl(state, verifier, await this.callback()),
    };
  }
  async callbackResult(
    admin: Admin,
    sessionHash: string,
    state: string,
    code?: string,
  ) {
    operator(admin);
    const row = (
      await this.store.pool.query(
        "UPDATE github_flows SET phase='exchanging' WHERE state_hash=$1 AND admin_id=$2 AND session_hash=$3 AND phase='oauth' AND expires_at>now() RETURNING *",
        [hash(state), admin.id, sessionHash],
      )
    ).rows[0];
    requireThat(row, "github_authorization_expired", 409);
    try {
      const w = await this.workspace(admin, row.workspace_id);
      const app = await this.apps.get(w.operatorId);
      requireThat(app, "github_app_not_configured", 409);
      requireThat(code, "github_authorization_cancelled", 400);
      const identity = await app.exchange(
        code,
        decrypt(
          this.key,
          `github:${row.workspace_id}:${sessionHash}`,
          row.verifier,
        ),
        await this.callback(),
      );
      await this.workspace(admin, row.workspace_id);
      const saved = await this.store.pool.query(
        "UPDATE github_flows SET phase='selecting',verifier='',user_token=$2,login=$3 WHERE state_hash=$1 AND expires_at>now()",
        [
          hash(state),
          encrypt(
            this.key,
            `github:${row.workspace_id}:${sessionHash}`,
            identity.token,
          ),
          identity.login,
        ],
      );
      requireThat(saved.rowCount, "github_authorization_expired", 409);
      return row.workspace_id as string;
    } catch (error) {
      await this.store.pool.query(
        "DELETE FROM github_flows WHERE state_hash=$1",
        [hash(state)],
      );
      throw error;
    }
  }
  async register(
    admin: Admin,
    id: string,
    sessionHash: string,
    value: unknown,
  ) {
    await this.workspace(admin, id);
    const input = registrationInput.parse(value);
    requireThat(
      this.apps.canRegister && !(await this.apps.get(admin.id)),
      "github_app_already_configured",
      409,
    );
    await throttle(this.store.pool, `github-registration:${admin.id}`);
    const state = flowState(input.source);
    const organization =
      input.owner === "organization" ? input.organization : null;
    await this.store.pool.query(
      "DELETE FROM github_app_flows WHERE expires_at<=now()",
    );
    await this.store.pool.query(
      "INSERT INTO github_app_flows(state_hash,workspace_id,admin_id,session_hash,organization,phase,expires_at) VALUES($1,$2,$3,$4,$5,'pending',now()+interval '10 minutes') ON CONFLICT(admin_id,session_hash) DO UPDATE SET state_hash=EXCLUDED.state_hash,workspace_id=EXCLUDED.workspace_id,organization=EXCLUDED.organization,phase='pending',expires_at=EXCLUDED.expires_at",
      [hash(state), id, admin.id, sessionHash, organization],
    );
    const path = organization
      ? `/organizations/${organization}/settings/apps/new`
      : "/settings/apps/new";
    const origin = await publicOrigin(this.store, this.origin);
    return {
      url: `https://github.com${path}?state=${state}`,
      manifest: {
        name: input.name,
        url: origin,
        redirect_url: `${origin}/api/admin/github/app/callback`,
        callback_urls: [`${origin}/api/admin/github/callback`],
        // GitHub validates this required URL even for an inactive hook. Use
        // the reserved example domain; this app never subscribes to webhooks.
        hook_attributes: {
          url: "https://example.com/github/webhook",
          active: false,
        },
        public: input.public,
        request_oauth_on_install: false,
        default_permissions: { ...githubAppPermissions },
        default_events: [],
      },
    };
  }
  async registrationResult(
    admin: Admin,
    sessionHash: string,
    state: string,
    code?: string,
  ) {
    operator(admin);
    const row = (
      await this.store.pool.query(
        "UPDATE github_app_flows SET phase='exchanging' WHERE state_hash=$1 AND admin_id=$2 AND session_hash=$3 AND phase='pending' AND expires_at>now() RETURNING *",
        [hash(state), admin.id, sessionHash],
      )
    ).rows[0];
    requireThat(row, "github_authorization_expired", 409);
    try {
      await this.workspace(admin, row.workspace_id);
      requireThat(
        this.apps.canRegister && !(await this.apps.get(admin.id)),
        "github_app_already_configured",
        409,
      );
      requireThat(code, "github_registration_cancelled", 400);
      const config = await this.apps.convert(code, row.organization);
      await this.store.change(row.workspace_id, async (w, sql) => {
        githubAuthority(admin, w);
        const consumed = await sql.query(
          "DELETE FROM github_app_flows WHERE state_hash=$1 AND session_hash=$2 AND phase='exchanging' AND expires_at>now() RETURNING state_hash",
          [hash(state), sessionHash],
        );
        requireThat(consumed.rowCount, "github_authorization_expired", 409);
        await this.apps.save(sql, admin.id, config);
        audit(w, admin.id, "github.app_created", String(config.id));
      });
      return row.workspace_id as string;
    } catch (error) {
      await this.store.pool.query(
        "DELETE FROM github_app_flows WHERE state_hash=$1",
        [hash(state)],
      );
      throw error;
    }
  }
  async repositories(
    admin: Admin,
    id: string,
    sessionHash: string,
    installationId: number,
  ) {
    const pending = await this.flow(admin, id, sessionHash);
    const app = await this.apps.get(admin.id);
    requireThat(app, "github_app_not_configured", 409);
    return app.repositories(pending.token, installationId);
  }
  async connect(admin: Admin, id: string, sessionHash: string, value: unknown) {
    const input = selectionSchema.parse(value);
    const pending = await this.flow(admin, id, sessionHash);
    const app = await this.apps.get(admin.id);
    requireThat(app, "github_app_not_configured", 409);
    const installation = (await app.installations(pending.token)).find(
      (i) => i.id === input.installationId,
    );
    requireThat(installation, "github_access_denied", 403);
    const accessible = await app.repositories(
      pending.token,
      input.installationId,
    );
    const selected =
      "allRepositories" in input
        ? accessible
        : accessible.filter((r) => input.repositoryIds.includes(r.id));
    if ("allRepositories" in input)
      requireThat(selected.length > 0, "github_repository_not_connected", 409);
    else
      requireThat(
        selected.length === new Set(input.repositoryIds).size,
        "github_access_denied",
        403,
      );
    await this.store.change(id, async (w, sql) => {
      githubAuthority(admin, w);
      requireThat(
        (w.github?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      const consumed = await sql.query(
        "DELETE FROM github_flows WHERE state_hash=$1 AND session_hash=$2 AND phase='selecting' AND expires_at>now() RETURNING state_hash",
        [pending.row.state_hash, sessionHash],
      );
      requireThat(consumed.rowCount, "github_authorization_expired", 409);
      w.github = {
        revision: input.revision + 1,
        installationId: installation.id,
        account: installation.account,
        connectedBy: pending.row.login,
        connectedAt: new Date().toISOString(),
        repositories: selected,
      };
      if (w.plugins) w.plugins.revision++;
      audit(
        w,
        admin.id,
        "github.connected",
        String(installation.id),
        w.github.revision,
      );
    });
    return this.view(admin, id, sessionHash);
  }
  async disconnect(
    admin: Admin,
    id: string,
    sessionHash: string,
    value: unknown,
  ) {
    const input = z.object({ revision: revisionSchema }).strict().parse(value);
    await this.store.change(id, async (w, sql) => {
      githubAuthority(admin, w);
      requireThat(
        (w.github?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      w.github = { revision: input.revision + 1, repositories: [] };
      if (w.plugins) w.plugins.revision++;
      await sql.query("DELETE FROM github_flows WHERE workspace_id=$1", [id]);
      audit(w, admin.id, "github.disconnected", id, w.github.revision);
    });
    return this.view(admin, id, sessionHash);
  }
}
