import { createHash, randomUUID } from "node:crypto";
import { operator } from "../admin/auth.ts";
import { publicOrigin } from "../admin/site.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import { decrypt, encrypt, hash, token } from "../setup/credentials.ts";
import { audit, authorize, runAllowed } from "../workspaces/policy.ts";
import { GoogleClient, type GoogleTransport } from "./client.ts";
import {
  type GoogleConfig,
  type GooglePage,
  type GooglePlugin,
  type GoogleRegistration,
  googleConfig,
  googleDefinitions,
  googlePlugins,
  googleQueries,
  googleSave,
  registrationScopes,
} from "./config.ts";
import { readGoogle } from "./queries.ts";

const aad = (id: string, plugin: GoogleRegistration, kind: string) =>
  `google:${id}:${plugin}:${kind}`;
function authority(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(!w.deletion && w.operatorId === admin.id, "access_denied", 403);
}
export function googleStateWorkspace(
  state: string,
  plugin: GoogleRegistration,
) {
  const match = /^rdg_([a-f0-9-]{36})_([a-z-]+)_([A-Za-z0-9_-]{43})$/.exec(
    state,
  );
  requireThat(
    match &&
      match[2] === plugin &&
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(match[1] ?? ""),
    "google_authorization_expired",
    409,
  );
  return match[1] as string;
}
function status(config?: GoogleConfig): GooglePage["status"] {
  const c = config?.connection;
  if (!c) return "not_connected";
  if (
    c.reconnectRequired ||
    (c.refresh && Date.parse(c.refresh.at) + 30000 < Date.now())
  )
    return "reconnect_required";
  return c.refresh ? "refreshing" : "connected";
}
function scope(
  w: Workspace,
  runId: string,
  revision: number,
  plugin: GooglePlugin,
) {
  const run = w.runs.find((r) => r.id === runId);
  requireThat(run && runAllowed(w, run), "run_revoked", 403);
  authorize(w, run.actor, true);
  requireThat(
    run.chatId === run.actor && !run.workflowId,
    "google_private_request_required",
    403,
  );
  const config = googleConfig(w.plugins, plugin);
  requireThat(
    config?.settings.enabled &&
      config.connection &&
      !config.connection.reconnectRequired,
    "google_not_connected",
    409,
  );
  requireThat(
    w.plugins?.revision === revision,
    "extension_configuration_changed",
    409,
  );
  return { run, config, connection: config.connection };
}

/** One workspace-owned Google registration; legacy records are read only until replaced. */
export class GoogleService {
  private client: GoogleClient;
  constructor(
    private store: Store,
    private key: string,
    private origin = "http://localhost:3000",
    transport?: GoogleTransport,
  ) {
    this.client = new GoogleClient(transport);
  }
  private async redirectUri(plugin: GoogleRegistration) {
    const origin = new URL(await publicOrigin(this.store, this.origin));
    requireThat(
      origin.protocol === "https:" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname),
      "google_https_required",
      409,
    );
    return `${origin.origin}/api/admin/google/${plugin === "google" ? "" : `${plugin}/`}callback`;
  }
  async view(
    admin: Admin,
    id: string,
    plugin: GoogleRegistration,
  ): Promise<GooglePage> {
    const w = await this.store.read(id);
    authority(admin, w);
    const config = w.plugins?.google?.[plugin];
    const legacy =
      plugin === "google" && !config
        ? googlePlugins
            .map((p) => w.plugins?.google?.[p])
            .find((c) => c?.clientSecret)
        : undefined;
    return {
      revision: w.plugins?.revision ?? 0,
      settings: {
        enabled:
          config?.settings.enabled ??
          (plugin === "google" &&
            (googlePlugins.some(
              (p) => w.plugins?.google?.[p]?.settings.enabled,
            ) ||
              !!w.plugins?.searchConsole?.settings.enabled)),
      },
      clientId: config?.clientId ?? legacy?.clientId ?? "",
      clientSecretConfigured: !!(config?.clientSecret || legacy?.clientSecret),
      redirectUri: await this.redirectUri(plugin),
      scope: registrationScopes(plugin).join(" "),
      status: status(config),
      account: config?.connection?.account,
      siteUrls: config
        ? (w.plugins?.searchConsole?.settings.siteUrls ?? [])
        : [],
      ...(plugin === "google" && !config && (legacy || w.plugins?.searchConsole)
        ? { legacy: true }
        : {}),
    };
  }
  async save(
    admin: Admin,
    id: string,
    plugin: GoogleRegistration,
    value: unknown,
    fallback: PluginRecord[] = [],
  ) {
    operator(admin);
    const input = googleSave.parse(value);
    await this.store.change(id, (w) => {
      authority(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      requireThat(
        plugin === "google" || !w.plugins?.google?.google,
        "google_plugin_merged",
        409,
      );
      const legacyPlugin =
        plugin === "google" && !w.plugins?.google?.google
          ? googlePlugins.find((p) => w.plugins?.google?.[p]?.clientSecret)
          : undefined;
      const prior =
        w.plugins?.google?.[plugin] ??
        (legacyPlugin ? w.plugins?.google?.[legacyPlugin] : undefined);
      const clientId = input.clientId ?? prior?.clientId ?? "";
      const emptyDisabled =
        plugin === "google" &&
        !clientId &&
        !input.clientSecret &&
        !input.settings.enabled;
      requireThat(clientId || emptyDisabled, "google_client_required");
      requireThat(
        emptyDisabled ||
          input.clientSecret ||
          (prior?.clientSecret && clientId === prior.clientId),
        "google_client_secret_required",
      );
      const changed =
        !!legacyPlugin || clientId !== prior?.clientId || !!input.clientSecret;
      const config: GoogleConfig = {
        settings: input.settings,
        clientId,
        clientSecret: input.clientSecret
          ? encrypt(
              this.key,
              aad(id, plugin, `client:${clientId}`),
              input.clientSecret,
            )
          : legacyPlugin && prior
            ? encrypt(
                this.key,
                aad(id, plugin, `client:${clientId}`),
                decrypt(
                  this.key,
                  aad(id, legacyPlugin, `client:${clientId}`),
                  prior.clientSecret,
                ),
              )
            : (prior?.clientSecret ?? ""),
        connection: changed ? undefined : prior?.connection,
      };
      if (changed) config.settings.enabled = false;
      requireThat(
        !config.settings.enabled ||
          (config.connection && status(config) !== "reconnect_required"),
        "google_not_connected",
        409,
      );
      if (config.settings.enabled)
        for (const entry of w.plugins?.entries ?? fallback) {
          requireThat(
            !entry.enabled ||
              !(
                plugin === "google"
                  ? [
                      ...googlePlugins.map((p) => googleDefinitions[p].tool),
                      "query_search_console",
                    ]
                  : [googleDefinitions[plugin].tool]
              ).some((tool) => entry.tools.includes(tool)),
            "extension_tool_collision",
            409,
          );
        }
      w.plugins = {
        ...w.plugins,
        revision: input.revision + 1,
        entries: w.plugins?.entries ?? fallback,
        google:
          plugin === "google"
            ? { google: config }
            : { ...w.plugins?.google, [plugin]: config },
        ...(plugin === "google" && changed
          ? { searchConsole: { settings: { enabled: false, siteUrls: [] } } }
          : {}),
      };
      audit(w, admin.id, "plugins.updated", plugin, w.plugins.revision);
    });
    return this.view(admin, id, plugin);
  }
  private async session(admin: Admin, sessionHash: string) {
    const found = await this.store.pool.query(
      "SELECT 1 FROM admins a JOIN sessions s ON a.id=s.admin_id WHERE a.id=$1 AND a.operator=true AND s.token_hash=$2 AND s.expires_at>now()",
      [admin.id, sessionHash],
    );
    requireThat(found.rowCount, "authentication_required", 401);
  }
  async begin(
    admin: Admin,
    id: string,
    plugin: GoogleRegistration,
    revision: number,
    sessionHash: string,
  ) {
    await this.session(admin, sessionHash);
    const redirectUri = await this.redirectUri(plugin);
    const state = `rdg_${id}_${plugin}_${token()}`;
    const verifier = token();
    let clientId = "";
    await this.store.change(id, (w) => {
      authority(admin, w);
      requireThat(w.plugins?.revision === revision, "version_conflict", 409);
      const config = w.plugins?.google?.[plugin];
      requireThat(
        config?.clientId && config.clientSecret,
        "google_client_required",
        409,
      );
      clientId = config.clientId;
      config.flow = {
        stateHash: hash(state),
        sessionHash,
        adminId: admin.id,
        revision,
        redirectUri,
        verifier: encrypt(this.key, aad(id, plugin, "verifier"), verifier),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: `openid email ${registrationScopes(plugin).join(" ")}`,
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: plugin === "google" ? "true" : "false",
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return { url: url.toString() };
  }
  async callback(
    admin: Admin,
    plugin: GoogleRegistration,
    sessionHash: string,
    state: string,
    code?: string,
  ) {
    const id = googleStateWorkspace(state, plugin);
    const redirectUri = await this.redirectUri(plugin);
    const check = (w: Workspace) => {
      authority(admin, w);
      const config = w.plugins?.google?.[plugin];
      const f = config?.flow;
      requireThat(
        config &&
          f &&
          f.stateHash === hash(state) &&
          f.adminId === admin.id &&
          f.sessionHash === sessionHash &&
          f.revision === w.plugins?.revision &&
          Date.parse(f.expiresAt) > Date.now() &&
          f.redirectUri === redirectUri,
        "google_authorization_expired",
        409,
      );
      return { config, flow: f };
    };
    await this.session(admin, sessionHash);
    const claimed = await this.store.change(id, (w) => {
      const result = check(w);
      requireThat(!result.flow.exchanging, "google_authorization_expired", 409);
      result.flow.exchanging = true;
      return structuredClone(result);
    });
    try {
      requireThat(code, "google_authorization_denied", 409);
      const guard = async () => {
        await this.session(admin, sessionHash);
        check(await this.store.read(id));
      };
      await guard();
      const data = await this.client.token({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: claimed.config.clientId,
        client_secret: decrypt(
          this.key,
          aad(id, plugin, `client:${claimed.config.clientId}`),
          claimed.config.clientSecret,
        ),
        code_verifier: decrypt(
          this.key,
          aad(id, plugin, "verifier"),
          claimed.flow.verifier,
        ),
      });
      await guard();
      const granted =
        typeof data.scope === "string" ? data.scope.split(" ") : [];
      requireThat(
        registrationScopes(plugin).every((scope) => granted.includes(scope)),
        "google_scope_required",
        409,
      );
      requireThat(
        typeof data.access_token === "string" &&
          typeof data.refresh_token === "string" &&
          data.refresh_token.length > 0 &&
          typeof data.expires_in === "number" &&
          data.expires_in > 0 &&
          data.expires_in <= 86400 &&
          data.token_type === "Bearer",
        "google_invalid_response",
        502,
      );
      const identity = await this.client.get(
        new URL("https://openidconnect.googleapis.com/v1/userinfo"),
        data.access_token,
        guard,
      );
      requireThat(
        typeof identity.sub === "string" &&
          typeof identity.email === "string" &&
          identity.email.length <= 320 &&
          identity.email_verified === true,
        "google_account_unverified",
        409,
      );
      await this.session(admin, sessionHash);
      await this.store.change(id, (w) => {
        const { config } = check(w);
        config.connection = {
          id: randomUUID(),
          account: identity.email as string,
          subject: identity.sub as string,
          accessToken: encrypt(
            this.key,
            aad(id, plugin, "access"),
            data.access_token as string,
          ),
          refreshToken: encrypt(
            this.key,
            aad(id, plugin, "refresh"),
            data.refresh_token as string,
          ),
          expiresAt: new Date(
            Date.now() + (data.expires_in as number) * 1000,
          ).toISOString(),
        };
        delete config.flow;
        // Connecting never grants runtime access until the operator explicitly enables it.
        config.settings.enabled = false;
        if (plugin === "google" && w.plugins) {
          w.plugins.searchConsole = {
            settings: { enabled: false, siteUrls: [] },
          };
        }
        if (w.plugins) {
          w.plugins.revision++;
          audit(w, admin.id, "google.connected", plugin, w.plugins.revision);
        }
      });
    } catch (cause) {
      await this.store.change(id, (w) => {
        const config = w.plugins?.google?.[plugin];
        if (config?.flow?.stateHash === hash(state)) delete config.flow;
      });
      throw cause;
    }
    return id;
  }
  async disconnect(
    admin: Admin,
    id: string,
    plugin: GoogleRegistration,
    revision: number,
  ) {
    await this.store.change(id, (w) => {
      authority(admin, w);
      requireThat(w.plugins?.revision === revision, "version_conflict", 409);
      const config = w.plugins?.google?.[plugin];
      requireThat(config, "google_client_required", 409);
      delete config.connection;
      delete config.flow;
      config.settings.enabled = false;
      if (w.plugins) {
        w.plugins.revision++;
        audit(w, admin.id, "google.disconnected", plugin, w.plugins.revision);
      }
    });
    // Local disconnect preserves the OAuth client for reconnection.
    return this.view(admin, id, plugin);
  }
  private async access(
    id: string,
    plugin: GoogleRegistration,
    guard: () => Promise<void>,
    signal?: AbortSignal,
  ) {
    await guard();
    const w = await this.store.read(id);
    const config = w.plugins?.google?.[plugin];
    const c = config?.connection;
    requireThat(
      config && c && !c.reconnectRequired,
      "google_reconnect_required",
      409,
    );
    requireThat(
      !c.refresh || Date.parse(c.refresh.at) + 30000 > Date.now(),
      "google_reconnect_required",
      409,
    );
    requireThat(!c.refresh, "google_refresh_pending", 409);
    if (Date.parse(c.expiresAt) > Date.now() + 60000)
      return decrypt(this.key, aad(id, plugin, "access"), c.accessToken);
    const claim = randomUUID();
    await this.store.change(id, (current) => {
      const connection = current.plugins?.google?.[plugin]?.connection;
      requireThat(
        connection?.id === c.id &&
          connection.accessToken === c.accessToken &&
          !connection.reconnectRequired,
        "google_reconnect_required",
        409,
      );
      requireThat(!connection.refresh, "google_refresh_pending", 409);
      connection.refresh = { id: claim, at: new Date().toISOString() };
    });
    try {
      await guard();
      const data = await this.client.token(
        {
          grant_type: "refresh_token",
          client_id: config.clientId,
          client_secret: decrypt(
            this.key,
            aad(id, plugin, `client:${config.clientId}`),
            config.clientSecret,
          ),
          refresh_token: decrypt(
            this.key,
            aad(id, plugin, "refresh"),
            c.refreshToken,
          ),
        },
        signal,
      );
      await guard();
      requireThat(
        typeof data.access_token === "string" &&
          data.token_type === "Bearer" &&
          typeof data.expires_in === "number" &&
          data.expires_in > 0 &&
          data.expires_in <= 86400,
        "google_invalid_response",
        502,
      );
      if (typeof data.scope === "string")
        requireThat(
          registrationScopes(plugin).every((scope) =>
            (data.scope as string).split(" ").includes(scope),
          ),
          "google_scope_required",
          409,
        );
      await this.store.change(id, (current) => {
        const connection = current.plugins?.google?.[plugin]?.connection;
        requireThat(
          connection?.id === c.id && connection.refresh?.id === claim,
          "google_reconnect_required",
          409,
        );
        connection.accessToken = encrypt(
          this.key,
          aad(id, plugin, "access"),
          data.access_token as string,
        );
        if (typeof data.refresh_token === "string" && data.refresh_token)
          connection.refreshToken = encrypt(
            this.key,
            aad(id, plugin, "refresh"),
            data.refresh_token,
          );
        connection.expiresAt = new Date(
          Date.now() + (data.expires_in as number) * 1000,
        ).toISOString();
        delete connection.refresh;
      });
      await guard();
      return data.access_token as string;
    } catch (cause) {
      await this.store.change(id, (current) => {
        const connection = current.plugins?.google?.[plugin]?.connection;
        if (connection?.id === c.id && connection.refresh?.id === claim) {
          connection.reconnectRequired = true;
          delete connection.refresh;
        }
      });
      throw cause;
    }
  }
  /** Shared token access for Search Console; callers supply session or run guards. */
  async accountAccess(
    id: string,
    guard: () => Promise<void>,
    signal?: AbortSignal,
  ) {
    return this.access(id, "google", guard, signal);
  }
  async query(
    id: string,
    runId: string,
    revision: number,
    plugin: GooglePlugin,
    value: unknown,
    signal?: AbortSignal,
    runtimeGuard?: () => Promise<void>,
  ) {
    const input = googleQueries[plugin].parse(value);
    const guard = async () => {
      await runtimeGuard?.();
      scope(await this.store.read(id), runId, revision, plugin);
      signal?.throwIfAborted();
    };
    await guard();
    await this.store.change(id, (w) => {
      const { run, connection } = scope(w, runId, revision, plugin);
      run.googleRead = {
        ...run.googleRead,
        [plugin]: { revision, connectionId: connection.id },
      };
    });
    const registration = (await this.store.read(id)).plugins?.google?.google
      ? "google"
      : plugin;
    const accessToken = await this.access(id, registration, guard, signal);
    try {
      const result = await readGoogle(
        this.client,
        plugin,
        input,
        accessToken,
        guard,
        signal,
      );
      requireThat(
        Buffer.byteLength(JSON.stringify(result)) <= 32000,
        "google_result_too_large",
        409,
      );
      await guard();
      return result;
    } catch (cause) {
      if (cause instanceof Fault && cause.code === "google_reconnect_required")
        await this.store.change(id, (current) => {
          const connection = googleConfig(current.plugins, plugin)?.connection;
          if (connection && current.plugins?.revision === revision)
            connection.reconnectRequired = true;
        });
      throw cause;
    }
  }
}
