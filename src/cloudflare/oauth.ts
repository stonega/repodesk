import { randomUUID } from "node:crypto";
import { operator, throttle } from "../admin/auth.ts";
import { publicOrigin } from "../admin/site.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import { decrypt, encrypt, hash, token } from "../setup/credentials.ts";
import { audit } from "../workspaces/policy.ts";
import { CloudflareClient, type CloudflareTransport, row } from "./client.ts";
import { type CloudflareConfig, cloudflareTools } from "./config.ts";
import { CloudflareOAuthClient, type OAuthTokens } from "./oauth-client.ts";

type OAuth = NonNullable<CloudflareConfig["oauth"]>;
const aad = (id: string, kind: string) => `cloudflare:${id}:oauth:${kind}`;
export const cloudflareClientSecretAAD = (id: string, clientId: string) =>
  aad(id, `client:${clientId}`);
export function cloudflareStateWorkspace(state: string) {
  const match =
    /^cf_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_[A-Za-z0-9_-]{43}$/.exec(
      state,
    );
  requireThat(match, "cloudflare_authorization_expired", 409);
  return match[1] as string;
}
function authority(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(!w.deletion && w.operatorId === admin.id, "access_denied", 403);
}
function status(oauth?: OAuth) {
  const c = oauth?.connection;
  if (!c) return "not_connected" as const;
  if (
    c.reconnectRequired ||
    (c.refresh && Date.parse(c.refresh.at) + 30000 < Date.now()) ||
    (!c.refreshToken && Date.parse(c.expiresAt) <= Date.now())
  )
    return "reconnect_required" as const;
  return c.refresh ? ("refreshing" as const) : ("connected" as const);
}

/** OAuth state and encrypted credentials live in the existing workspace aggregate. */
export class CloudflareOAuth {
  private client: CloudflareOAuthClient;
  private api: CloudflareClient;
  constructor(
    private store: Store,
    private key: string,
    private origin: string,
    transport?: CloudflareTransport,
  ) {
    this.client = new CloudflareOAuthClient(transport);
    this.api = new CloudflareClient(transport);
  }
  async redirectUri(secure = false) {
    const origin = new URL(await publicOrigin(this.store, this.origin));
    requireThat(
      !secure ||
        origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)),
      "cloudflare_https_required",
      409,
    );
    return `${origin.origin}/api/admin/cloudflare/callback`;
  }
  async view(w: Workspace) {
    const oauth = w.plugins?.cloudflare?.oauth;
    return {
      clientId: oauth?.clientId ?? "",
      scopes: oauth?.scopes ?? [],
      clientSecretConfigured: !!oauth?.clientSecret,
      redirectUri: await this.redirectUri(),
      status: status(oauth),
      expiresAt: oauth?.connection?.expiresAt,
    };
  }
  private async session(
    admin: Admin,
    sessionHash: string,
    sql: Sql = this.store.pool,
  ) {
    const found = await sql.query(
      "SELECT 1 FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.admin_id=$2 AND s.expires_at>now() AND a.operator=true",
      [sessionHash, admin.id],
    );
    requireThat(found.rowCount, "cloudflare_authorization_expired", 409);
  }
  async begin(admin: Admin, id: string, sessionHash: string, revision: number) {
    operator(admin);
    const snapshot = await this.store.read(id);
    authority(admin, snapshot);
    await this.session(admin, sessionHash);
    await throttle(this.store.pool, `cloudflare-oauth:${admin.id}:${id}`);
    const redirectUri = await this.redirectUri(true);
    const state = `cf_${id}_${token()}`,
      verifier = token();
    return this.store.change(id, async (w, sql) => {
      authority(admin, w);
      await this.session(admin, sessionHash, sql);
      requireThat(w.plugins?.revision === revision, "version_conflict", 409);
      const config = w.plugins.cloudflare,
        oauth = config?.oauth;
      requireThat(
        config?.settings.authMethod === "oauth" &&
          config.settings.accountId &&
          oauth?.clientSecret &&
          oauth.scopes.length,
        "cloudflare_oauth_client_required",
        409,
      );
      oauth.flow = {
        stateHash: hash(state),
        sessionHash,
        adminId: admin.id,
        revision,
        redirectUri,
        verifier: encrypt(this.key, aad(id, hash(state)), verifier),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
      audit(w, admin.id, "cloudflare.authorization_started", id);
      return {
        url: this.client.authorizationUrl(
          oauth.clientId,
          oauth.scopes,
          state,
          verifier,
          redirectUri,
        ),
      };
    });
  }
  private flow(w: Workspace, admin: Admin, sessionHash: string, state: string) {
    authority(admin, w);
    const oauth = w.plugins?.cloudflare?.oauth,
      flow = oauth?.flow;
    requireThat(
      oauth &&
        flow &&
        flow.stateHash === hash(state) &&
        flow.adminId === admin.id &&
        flow.sessionHash === sessionHash &&
        flow.revision === w.plugins?.revision &&
        w.plugins.cloudflare?.settings.authMethod === "oauth" &&
        Date.parse(flow.expiresAt) > Date.now(),
      "cloudflare_authorization_expired",
      409,
    );
    return { oauth, flow };
  }
  private secret(id: string, oauth: OAuth) {
    return decrypt(
      this.key,
      cloudflareClientSecretAAD(id, oauth.clientId),
      oauth.clientSecret,
    );
  }
  private connection(id: string, tokens: OAuthTokens, priorRefresh?: string) {
    const generation = randomUUID();
    return {
      id: generation,
      accessToken: encrypt(
        this.key,
        aad(id, `${generation}:access`),
        tokens.access_token,
      ),
      refreshToken:
        tokens.refresh_token || priorRefresh
          ? encrypt(
              this.key,
              aad(id, `${generation}:refresh`),
              tokens.refresh_token ?? priorRefresh ?? "",
            )
          : undefined,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    };
  }
  private async revokeTokens(id: string, oauth: OAuth, tokens?: OAuthTokens) {
    const c = oauth.connection;
    const refresh = tokens
      ? tokens.refresh_token
      : c?.refreshToken
        ? decrypt(this.key, aad(id, `${c.id}:refresh`), c.refreshToken)
        : undefined;
    const access = tokens
      ? tokens.access_token
      : c
        ? decrypt(this.key, aad(id, `${c.id}:access`), c.accessToken)
        : undefined;
    const results = await Promise.allSettled([
      ...(refresh
        ? [
            this.client.revoke(
              oauth.clientId,
              this.secret(id, oauth),
              refresh,
              true,
            ),
          ]
        : []),
      ...(access
        ? [
            this.client.revoke(
              oauth.clientId,
              this.secret(id, oauth),
              access,
              false,
            ),
          ]
        : []),
    ]);
    return results.every((r) => r.status === "fulfilled");
  }
  async callback(
    admin: Admin,
    sessionHash: string,
    state: string,
    code?: string,
  ) {
    const id = cloudflareStateWorkspace(state);
    const snapshot = await this.store.change(id, async (w, sql) => {
      const current = this.flow(w, admin, sessionHash, state);
      await this.session(admin, sessionHash, sql);
      requireThat(
        !current.flow.exchanging,
        "cloudflare_authorization_expired",
        409,
      );
      current.flow.exchanging = true;
      return {
        oauth: structuredClone(current.oauth),
        accountId: w.plugins?.cloudflare?.settings.accountId,
      };
    });
    let tokens: OAuthTokens | undefined;
    try {
      const flow = snapshot.oauth.flow;
      requireThat(flow && code, "cloudflare_authorization_cancelled", 409);
      const guard = async () => {
        this.flow(await this.store.read(id), admin, sessionHash, state);
        await this.session(admin, sessionHash);
        requireThat(
          (await this.redirectUri()) === flow.redirectUri,
          "cloudflare_authorization_expired",
          409,
        );
      };
      await guard();
      tokens = await this.client.exchange(
        snapshot.oauth.clientId,
        this.secret(id, snapshot.oauth),
        code,
        decrypt(this.key, aad(id, hash(state)), flow.verifier),
        flow.redirectUri,
      );
      const account = await this.api.request(
        tokens.access_token,
        `/accounts/${snapshot.accountId}`,
        { guard },
      );
      requireThat(
        row(account.result).id === snapshot.accountId,
        "cloudflare_oauth_account_denied",
        403,
      );
      await guard();
      await this.store.change(id, async (w, sql) => {
        const current = this.flow(w, admin, sessionHash, state);
        await this.session(admin, sessionHash, sql);
        requireThat(
          tokens && current.flow.exchanging && w.plugins?.cloudflare,
          "cloudflare_authorization_expired",
          409,
        );
        requireThat(
          !(w.plugins.entries ?? []).some(
            (entry) =>
              entry.enabled &&
              entry.tools.some((tool) =>
                (cloudflareTools as readonly string[]).includes(tool),
              ),
          ),
          "extension_tool_collision",
          409,
        );
        current.oauth.connection = this.connection(id, tokens);
        delete current.oauth.flow;
        w.plugins.cloudflare.settings.enabled = true;
        w.plugins.revision++;
        audit(w, admin.id, "cloudflare.connected", id, w.plugins.revision);
      });
      return id;
    } catch (error) {
      await this.store
        .change(id, (w) => {
          const oauth = w.plugins?.cloudflare?.oauth;
          if (oauth?.flow?.stateHash === hash(state)) delete oauth.flow;
        })
        .catch(() => {});
      if (tokens)
        await this.revokeTokens(id, snapshot.oauth, tokens).catch(() => false);
      throw error instanceof Fault
        ? error
        : new Fault("cloudflare_oauth_failed", 409);
    }
  }
  async disconnect(admin: Admin, id: string, revision: number) {
    const previous = await this.store.change(id, (w) => {
      authority(admin, w);
      requireThat(w.plugins?.revision === revision, "version_conflict", 409);
      const oauth = w.plugins.cloudflare?.oauth,
        snapshot = structuredClone(oauth);
      if (oauth) {
        delete oauth.connection;
        delete oauth.flow;
      }
      if (w.plugins.cloudflare?.settings.authMethod === "oauth")
        w.plugins.cloudflare.settings.enabled = false;
      w.plugins.revision++;
      audit(w, admin.id, "cloudflare.disconnected", id, w.plugins.revision);
      return snapshot;
    });
    return (
      !previous?.connection ||
      (await this.revokeTokens(id, previous).catch(() => false))
    );
  }
  async accessToken(id: string, revision: number): Promise<string> {
    const deadline = Date.now() + 17000;
    for (;;) {
      const result = await this.store.change(id, (w) => {
        requireThat(
          !w.deletion &&
            !w.settings.paused &&
            w.plugins?.revision === revision &&
            w.plugins.cloudflare?.settings.enabled &&
            w.plugins.cloudflare.settings.authMethod === "oauth",
          "extension_configuration_changed",
          409,
        );
        const oauth = w.plugins.cloudflare.oauth,
          c = oauth?.connection;
        requireThat(oauth && c, "cloudflare_not_configured", 409);
        if (status(oauth) === "reconnect_required") {
          c.reconnectRequired = true;
          return { reconnect: true } as const;
        }
        if (c.refresh) return { wait: true } as const;
        if (
          Date.parse(c.expiresAt) > Date.now() + 60000 ||
          (!c.refreshToken && Date.parse(c.expiresAt) > Date.now())
        )
          return {
            token: decrypt(this.key, aad(id, `${c.id}:access`), c.accessToken),
          } as const;
        if (!c.refreshToken) {
          c.reconnectRequired = true;
          return { reconnect: true } as const;
        }
        const claim = { id: randomUUID(), at: new Date().toISOString() };
        c.refresh = claim;
        return { oauth: structuredClone(oauth), claim } as const;
      });
      if ("reconnect" in result)
        throw new Fault("cloudflare_reconnect_required", 409);
      if ("token" in result) {
        requireThat(result.token, "cloudflare_reconnect_required", 409);
        return result.token;
      }
      if ("wait" in result) {
        requireThat(Date.now() < deadline, "cloudflare_refresh_pending", 409);
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const old = result.oauth.connection;
      requireThat(old?.refreshToken, "cloudflare_reconnect_required", 409);
      const refresh = decrypt(
        this.key,
        aad(id, `${old.id}:refresh`),
        old.refreshToken,
      );
      let tokens: OAuthTokens | undefined;
      let replacementId: string | undefined;
      try {
        tokens = await this.client.refresh(
          result.oauth.clientId,
          this.secret(id, result.oauth),
          refresh,
        );
        const replacement = this.connection(id, tokens, refresh);
        replacementId = replacement.id;
        const saved = await this.store.change(id, (w) => {
          const oauth = w.plugins?.cloudflare?.oauth;
          if (
            w.deletion ||
            w.plugins?.revision !== revision ||
            oauth?.connection?.reconnectRequired ||
            oauth?.connection?.refresh?.id !== result.claim.id ||
            Date.parse(oauth.connection.refresh.at) + 30000 < Date.now()
          )
            return false;
          requireThat(tokens, "cloudflare_oauth_failed", 409);
          oauth.connection = replacement;
          return true;
        });
        if (!saved) {
          throw new Fault("extension_configuration_changed", 409);
        }
        return tokens.access_token;
      } catch (error) {
        await this.store.change(id, (w) => {
          const c = w.plugins?.cloudflare?.oauth?.connection;
          if (
            c &&
            (c.refresh?.id === result.claim.id || c.id === replacementId)
          ) {
            c.reconnectRequired = true;
            delete c.refresh;
          }
        });
        if (tokens)
          await this.revokeTokens(id, result.oauth, tokens).catch(() => false);
        if (
          error instanceof Fault &&
          error.code === "extension_configuration_changed"
        )
          throw error;
        throw new Fault("cloudflare_reconnect_required", 409);
      }
    }
  }
}
