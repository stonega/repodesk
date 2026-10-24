import { createHash, randomUUID } from "node:crypto";
import { operator } from "../admin/auth.ts";
import { publicOrigin } from "../admin/site.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import { decrypt, encrypt, hash, token } from "../setup/credentials.ts";
import {
  audit,
  authorize,
  revokeWork,
  runAllowed,
} from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import { GoogleClient, type GoogleTransport } from "./client.ts";
import {
  type GooglePage,
  type GooglePlugin,
  type GoogleRegistration,
  googleDefinitions,
  googlePlugins,
  googleQueries,
  googleSave,
  googleScopes,
} from "./config.ts";
import { readGoogle } from "./queries.ts";

const clientAad = (id: string, plugin: GoogleRegistration, clientId: string) =>
  `google:${id}:${plugin}:client:${clientId}`;
const userAad = (id: string, actor: string, kind: string) =>
  `google-user:${id}:${actor}:${kind}`;
function authority(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(!w.deletion && w.operatorId === admin.id, "access_denied", 403);
}
export function googleStateWorkspace(state: string) {
  const match =
    /^rdgu_([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})_([A-Za-z0-9_-]{43})$/.exec(
      state,
    );
  requireThat(match, "google_authorization_expired", 409);
  return match[1] as string;
}
export function googleUserScope(w: Workspace, actor: string, botId?: string) {
  authorize(w, actor);
  requireThat(!w.settings.paused, "workspace_paused", 409);
  const config = w.plugins?.google?.google;
  requireThat(
    config?.settings.enabled && config.clientId && config.clientSecret,
    "google_not_configured",
    409,
  );
  const user = w.googleUsers?.[actor];
  requireThat(
    user &&
      (!botId || user.botId === botId) &&
      user.connection &&
      !user.connection.reconnectRequired,
    "google_not_connected",
    409,
  );
  return { config, user, connection: user.connection };
}
function scope(w: Workspace, runId: string, revision: number) {
  const run = w.runs.find((r) => r.id === runId);
  requireThat(run && runAllowed(w, run), "run_revoked", 403);
  requireThat(
    run.chatId === run.actor && !run.workflowId,
    "google_private_request_required",
    403,
  );
  requireThat(
    w.plugins?.revision === revision,
    "extension_configuration_changed",
    409,
  );
  return { run, ...googleUserScope(w, run.actor) };
}

/** Operators configure the client; Telegram members own all account grants. */
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
  private async redirectUri() {
    const origin = new URL(await publicOrigin(this.store, this.origin));
    requireThat(
      origin.protocol === "https:" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname),
      "google_https_required",
      409,
    );
    return `${origin.origin}/api/admin/google/callback`;
  }
  async view(
    admin: Admin,
    id: string,
    plugin: GoogleRegistration = "google",
  ): Promise<GooglePage> {
    requireThat(plugin === "google", "google_plugin_merged", 409);
    const w = await this.store.read(id);
    authority(admin, w);
    const config = w.plugins?.google?.google;
    const legacy = !config
      ? googlePlugins
          .map((p) => w.plugins?.google?.[p])
          .find((c) => c?.clientSecret)
      : undefined;
    return {
      revision: w.plugins?.revision ?? 0,
      settings: { enabled: config?.settings.enabled ?? false },
      clientId: config?.clientId || legacy?.clientId || "",
      clientSecretConfigured: !!(config?.clientSecret || legacy?.clientSecret),
      redirectUri: await this.redirectUri(),
      scope: googleScopes.join(" "),
      ...(!config && legacy ? { legacy: true } : {}),
    };
  }
  async save(
    admin: Admin,
    id: string,
    plugin: GoogleRegistration,
    value: unknown,
    fallback: PluginRecord[] = [],
  ) {
    requireThat(plugin === "google", "google_plugin_merged", 409);
    const input = googleSave.parse(value);
    await this.store.change(id, (w) => {
      authority(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      const legacy =
        !w.plugins?.google?.google &&
        googlePlugins.find((p) => w.plugins?.google?.[p]?.clientSecret);
      const prior =
        w.plugins?.google?.google ??
        (legacy ? w.plugins?.google?.[legacy] : undefined);
      const clientId = input.clientId ?? prior?.clientId ?? "";
      requireThat(
        clientId || (!input.settings.enabled && !input.clientSecret),
        "google_client_required",
        409,
      );
      requireThat(
        !clientId ||
          input.clientSecret ||
          (prior?.clientSecret && clientId === prior.clientId),
        "google_client_secret_required",
        409,
      );
      const changed =
        !!legacy || clientId !== prior?.clientId || !!input.clientSecret;
      const clientSecret = input.clientSecret
        ? encrypt(
            this.key,
            clientAad(id, "google", clientId),
            input.clientSecret,
          )
        : legacy && prior
          ? encrypt(
              this.key,
              clientAad(id, "google", clientId),
              decrypt(
                this.key,
                clientAad(id, legacy, clientId),
                prior.clientSecret,
              ),
            )
          : (prior?.clientSecret ?? "");
      if (input.settings.enabled) {
        requireThat(clientId && clientSecret, "google_client_required", 409);
        for (const entry of w.plugins?.entries ?? fallback)
          requireThat(
            !entry.enabled ||
              !entry.tools.some((name) =>
                [
                  ...googlePlugins.map((p) => googleDefinitions[p].tool),
                  "query_search_console",
                ].includes(name),
              ),
            "extension_tool_collision",
            409,
          );
      }
      w.plugins = {
        ...w.plugins,
        revision: input.revision + 1,
        entries: w.plugins?.entries ?? fallback,
        google: {
          google: { settings: input.settings, clientId, clientSecret },
        },
      };
      delete w.plugins.searchConsole;
      if (changed) delete w.googleUsers;
      revokeWork(w);
      audit(w, admin.id, "plugins.updated", "google", w.plugins.revision);
    });
    return this.view(admin, id);
  }
  async assertBot(botId: string) {
    const d = await this.store.deployment();
    requireThat(
      d.active && !d.paused && d.bot?.id === botId,
      "google_connection_changed",
      409,
    );
  }
  async begin(w: Workspace, actor: string, botId: string, topicId?: number) {
    authorize(w, actor);
    requireThat(!w.settings.paused, "workspace_paused", 409);
    await this.assertBot(botId);
    const config = w.plugins?.google?.google;
    requireThat(
      config?.settings.enabled && config.clientId && config.clientSecret,
      "google_not_configured",
      409,
    );
    const redirectUri = await this.redirectUri();
    const state = `rdgu_${w.id}_${token()}`;
    const verifier = token();
    w.googleUsers ??= {};
    const previous = w.googleUsers[actor];
    const user =
      previous?.botId === botId
        ? previous
        : { botId, siteUrls: [], siteRevision: 0 };
    user.flow = {
      stateHash: hash(state),
      topicId,
      revision: w.plugins?.revision ?? 0,
      redirectUri,
      verifier: encrypt(this.key, userAad(w.id, actor, "verifier"), verifier),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    w.googleUsers[actor] = user;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: `openid email ${googleScopes.join(" ")}`,
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return url.toString();
  }
  async callback(state: string, code?: string) {
    const id = googleStateWorkspace(state);
    const digest = hash(state);
    const redirectUri = await this.redirectUri();
    const snapshot = await this.store.read(id);
    const actor = Object.keys(snapshot.googleUsers ?? {}).find(
      (a) => snapshot.googleUsers?.[a]?.flow?.stateHash === digest,
    );
    requireThat(actor, "google_authorization_expired", 409);
    const check = (w: Workspace) => {
      authorize(w, actor);
      requireThat(!w.settings.paused, "workspace_paused", 409);
      const user = w.googleUsers?.[actor];
      const flow = user?.flow;
      const config = w.plugins?.google?.google;
      requireThat(
        user &&
          flow &&
          config?.settings.enabled &&
          flow.stateHash === digest &&
          flow.revision === w.plugins?.revision &&
          flow.redirectUri === redirectUri &&
          Date.parse(flow.expiresAt) > Date.now(),
        "google_authorization_expired",
        409,
      );
      return { user, flow, config };
    };
    const claimed = await this.store.change(id, async (w) => {
      const current = check(w);
      await this.assertBot(current.user.botId);
      requireThat(
        !current.flow.exchanging,
        "google_authorization_expired",
        409,
      );
      current.flow.exchanging = true;
      return structuredClone(current);
    });
    const guard = async () => {
      const current = check(await this.store.read(id));
      requireThat(
        current.flow.redirectUri === (await this.redirectUri()),
        "google_authorization_expired",
        409,
      );
      await this.assertBot(current.user.botId);
      requireThat(!current.flow.candidate, "google_authorization_expired", 409);
    };
    try {
      requireThat(code, "google_authorization_denied", 409);
      await guard();
      const data = await this.client.token({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: claimed.config.clientId,
        client_secret: decrypt(
          this.key,
          clientAad(id, "google", claimed.config.clientId),
          claimed.config.clientSecret,
        ),
        code_verifier: decrypt(
          this.key,
          userAad(id, actor, "verifier"),
          claimed.flow.verifier,
        ),
      });
      await guard();
      requireThat(
        typeof data.scope === "string" &&
          googleScopes.every((s) =>
            (data.scope as string).split(" ").includes(s),
          ),
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
          identity.sub.length > 0 &&
          identity.sub.length <= 256 &&
          typeof identity.email === "string" &&
          identity.email.length <= 320 &&
          identity.email_verified === true,
        "google_account_unverified",
        409,
      );
      await this.store.change(id, async (w) => {
        const { flow, user } = check(w);
        await this.assertBot(user.botId);
        requireThat(!flow.candidate, "google_authorization_expired", 409);
        flow.candidate = {
          id: randomUUID(),
          account: identity.email as string,
          subject: identity.sub as string,
          accessToken: encrypt(
            this.key,
            userAad(id, actor, "access"),
            data.access_token as string,
          ),
          refreshToken: encrypt(
            this.key,
            userAad(id, actor, "refresh"),
            data.refresh_token as string,
          ),
          expiresAt: new Date(
            Date.now() + (data.expires_in as number) * 1000,
          ).toISOString(),
        };
        flow.verifier = "";
        const key = Buffer.from(digest, "hex").toString("base64url");
        const deliveryId = deliver(
          w,
          actor,
          actor,
          `Connect Google account ${identity.email} to your Telegram identity in ${w.settings.name}? Confirm only if this is your account.`,
          {
            id: `google:${digest}:confirm`,
            topicId: flow.topicId,
            buttons: [
              [
                {
                  text: "Connect account",
                  callback_data: `google_confirm:${key}`,
                },
                { text: "Reject", callback_data: `google_reject:${key}` },
              ],
            ],
          },
        );
        const delivery = w.deliveries.find((d) => d.id === deliveryId);
        if (delivery)
          delivery.googleControl = {
            botId: user.botId,
            flow: { hash: digest, phase: "confirm" },
          };
      });
    } catch (cause) {
      await this.store.change(id, (w) => {
        const user = w.googleUsers?.[actor];
        if (user?.flow?.stateHash === digest) delete user.flow;
      });
      throw cause;
    }
  }
  async confirm(
    w: Workspace,
    actor: string,
    botId: string,
    digest: string,
    accept: boolean,
  ) {
    authorize(w, actor);
    await this.assertBot(botId);
    requireThat(!w.settings.paused, "workspace_paused", 409);
    const user = w.googleUsers?.[actor];
    const flow = user?.flow;
    const redirectUri = await this.redirectUri();
    requireThat(
      user?.botId === botId &&
        flow?.candidate &&
        flow.stateHash === digest &&
        flow.redirectUri === redirectUri &&
        flow.revision === w.plugins?.revision &&
        w.plugins?.google?.google?.settings.enabled &&
        Date.parse(flow.expiresAt) > Date.now(),
      "google_authorization_expired",
      409,
    );
    if (accept) {
      user.connection = flow.candidate;
      user.siteUrls = [];
      user.siteRevision++;
      delete user.properties;
      audit(w, actor, "google.connected", actor);
    }
    delete user.flow;
    revokeWork(w);
    return accept
      ? "Google account connected. You can read your Docs, Sheets, Drive and Gmail here. Send /google properties to choose your Search Console properties."
      : "Google account connection rejected.";
  }
  disconnect(w: Workspace, actor: string) {
    authorize(w, actor);
    if (w.googleUsers) delete w.googleUsers[actor];
    revokeWork(w);
    audit(w, actor, "google.disconnected", actor);
  }
  /** A locked Telegram command may supply its workspace to avoid nested transactions. */
  async accountAccess(
    id: string,
    actor: string,
    guard: () => Promise<void>,
    signal?: AbortSignal,
    locked?: Workspace,
  ) {
    await guard();
    const snapshot = locked ?? (await this.store.read(id));
    const { config, user, connection: c } = googleUserScope(snapshot, actor);
    await this.assertBot(user.botId);
    requireThat(
      !c.refresh,
      Date.parse(c.refresh?.at ?? "") + 30000 < Date.now()
        ? "google_reconnect_required"
        : "google_refresh_pending",
      409,
    );
    const check = async () => {
      await guard();
      await this.assertBot(user.botId);
    };
    const change = async (action: (w: Workspace) => void) =>
      locked ? action(locked) : this.store.change(id, action);
    if (Date.parse(c.expiresAt) > Date.now() + 60000) {
      await check();
      return decrypt(this.key, userAad(id, actor, "access"), c.accessToken);
    }
    const claim = randomUUID();
    await change((w) => {
      const connection = googleUserScope(w, actor).connection;
      requireThat(
        connection.id === c.id && connection.accessToken === c.accessToken,
        "google_reconnect_required",
        409,
      );
      requireThat(!connection.refresh, "google_refresh_pending", 409);
      connection.refresh = { id: claim, at: new Date().toISOString() };
    });
    try {
      await check();
      const data = await this.client.token(
        {
          grant_type: "refresh_token",
          client_id: config.clientId,
          client_secret: decrypt(
            this.key,
            clientAad(id, "google", config.clientId),
            config.clientSecret,
          ),
          refresh_token: decrypt(
            this.key,
            userAad(id, actor, "refresh"),
            c.refreshToken,
          ),
        },
        signal,
      );
      await check();
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
          googleScopes.every((s) =>
            (data.scope as string).split(" ").includes(s),
          ),
          "google_scope_required",
          409,
        );
      await change((w) => {
        const connection = googleUserScope(w, actor).connection;
        requireThat(
          connection.id === c.id && connection.refresh?.id === claim,
          "google_reconnect_required",
          409,
        );
        connection.accessToken = encrypt(
          this.key,
          userAad(id, actor, "access"),
          data.access_token as string,
        );
        if (typeof data.refresh_token === "string" && data.refresh_token)
          connection.refreshToken = encrypt(
            this.key,
            userAad(id, actor, "refresh"),
            data.refresh_token,
          );
        connection.expiresAt = new Date(
          Date.now() + (data.expires_in as number) * 1000,
        ).toISOString();
        delete connection.refresh;
      });
      await check();
      return data.access_token as string;
    } catch (cause) {
      await change((w) => {
        const connection = w.googleUsers?.[actor]?.connection;
        if (connection?.id === c.id && connection.refresh?.id === claim) {
          connection.reconnectRequired = true;
          delete connection.refresh;
        }
      });
      throw cause;
    }
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
    const initial = scope(await this.store.read(id), runId, revision);
    const connectionId = initial.connection.id;
    const actor = initial.run.actor;
    const guard = async () => {
      await runtimeGuard?.();
      const current = scope(await this.store.read(id), runId, revision);
      requireThat(
        current.connection.id === connectionId,
        "google_connection_changed",
        409,
      );
      await this.assertBot(current.user.botId);
      signal?.throwIfAborted();
    };
    await guard();
    await this.store.change(id, (w) => {
      const current = scope(w, runId, revision);
      requireThat(
        current.connection.id === connectionId,
        "google_connection_changed",
        409,
      );
      current.run.googleRead = {
        ...current.run.googleRead,
        [plugin]: { revision, connectionId },
      };
    });
    const accessToken = await this.accountAccess(id, actor, guard, signal);
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
        await this.store.change(id, (w) => {
          const connection = w.googleUsers?.[actor]?.connection;
          if (connection?.id === connectionId)
            connection.reconnectRequired = true;
        });
      throw cause;
    }
  }
}
