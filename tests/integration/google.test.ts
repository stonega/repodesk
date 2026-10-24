import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { claim } from "../../src/admin/auth.ts";
import { extensionToolExecution } from "../../src/agent/extension-execution.ts";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import type { PluginRecord } from "../../src/agent/plugin-config.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import {
  googleDefinitions,
  googlePlugins,
  googleScopes,
} from "../../src/google/config.ts";
import { googleWorkspaceExtension } from "../../src/google/extension.ts";
import { googleReadAllowed } from "../../src/google/policy.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { sweep } from "../../src/privacy/service.ts";
import { decrypt, encrypt, hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { TelegramPoller } from "../../src/telegram/polling.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { revokeWork, runAllowed } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { spec } from "../fixtures.ts";
import { googleFixture } from "../google-fixture.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)("Personal Google accounts", () => {
  const root = database(rootUrl ?? "postgres://unused@localhost/unused");
  const name = `repodesk_google_${randomUUID().replaceAll("-", "")}`;
  const key = "ab".repeat(32),
    origin = "http://localhost:3000";
  let store: Store, admin: Admin, auth: { raw: string; csrf: string };
  let update = 4000;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(rootUrl as string);
    url.pathname = `/${name}`;
    store = new Store(database(url.toString()));
    await migrate(store.pool);
    auth = await claim(store.pool, "googleoperator", "google fixture password");
    admin = {
      id: (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='googleoperator'",
        )
      ).rows[0].id,
      username: "googleoperator",
      operator: true,
    };
    const d = await store.deployment();
    d.credentials.bot = encrypt(key, "bot", "fixture-bot");
    d.active = true;
    d.bot = { id: "999", username: "repodesk", visibleAll: true };
    await store.saveDeployment(store.pool, d);
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  function must<T>(value: T): NonNullable<T> {
    if (value === undefined || value === null)
      throw Error("missing fixture value");
    return value;
  }
  const fixture = (actor = "101", chat = actor) =>
    googleFixture(store, admin, key, actor, chat);
  function message(text: string, actor = 202, chat = actor, topicId?: number) {
    return {
      update_id: ++update,
      message: {
        message_id: update,
        message_thread_id: topicId,
        date: 1,
        from: { id: actor, is_bot: false, first_name: "Fixture" },
        chat: {
          id: chat,
          type: chat === actor ? ("private" as const) : ("supergroup" as const),
        },
        text,
        entities: [
          {
            type: "bot_command",
            offset: 0,
            length: text.split(" ")[0]?.length ?? 0,
          },
        ],
      },
    };
  }
  function callback(data: string, actor = 202, topicId?: number) {
    return {
      update_id: ++update,
      callback_query: {
        id: String(update),
        from: { id: actor, is_bot: false, first_name: "Fixture" },
        message: {
          message_id: update,
          message_thread_id: topicId,
          date: 1,
          chat: { id: actor, type: "private" as const },
        },
        data,
      },
    };
  }
  test("one client and callback serve every member, with separately encrypted account grants", async () => {
    const f = await fixture("202");
    const consent = await f.connect();
    await f.connect("101");
    expect(consent.searchParams.get("scope")).toBe(
      `openid email ${googleScopes.join(" ")}`,
    );
    expect(consent.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/admin/google/callback`,
    );
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    const w = await store.read(f.w.id);
    const c = w.googleUsers?.["202"]?.connection;
    expect(c?.account).toBe("202@example.test");
    expect(w.googleUsers?.["101"]?.connection?.account).toBe(
      "101@example.test",
    );
    expect(w.plugins?.google?.google?.connection).toBeUndefined();
    expect(
      decrypt(key, `google-user:${w.id}:202:refresh`, c?.refreshToken ?? ""),
    ).toBe("refresh-202");
    expect(() =>
      decrypt(key, `google-user:${w.id}:101:refresh`, c?.refreshToken ?? ""),
    ).toThrow();
    await f.query("gmail", { resource: "messages" });
    expect(
      new Headers(f.requests.at(-1)?.init.headers).get("authorization"),
    ).toBe("Bearer access-202");
    await store.change(w.id, (current) => f.service.disconnect(current, "101"));
    await f.query("google-drive", { resource: "files" });
    expect(
      (await store.read(w.id)).plugins?.google?.google?.settings.enabled,
    ).toBe(true);
    expect(
      googleReadAllowed(
        await store.read(w.id),
        must((await store.read(w.id)).runs[0]),
      ),
    ).toBe(true);
  });
  test.each([undefined, 1995559])(
    "Telegram consent and confirmation stay in topic %s, need no panel session and bind the actual account once",
    async (topicId) => {
      const f = await fixture("202");
      await f.configure();
      const notices: string[] = [];
      const sent: Record<string, unknown>[] = [];
      const setup = new SetupService(store, key, origin, () => ({
        async call<T>(method: string, body: Record<string, unknown> = {}) {
          if (method === "answerCallbackQuery") notices.push(String(body.text));
          if (method === "sendMessage") {
            sent.push(body);
            return { message_id: sent.length } as T;
          }
          return {} as T;
        },
      }));
      const ingress = new Ingress(store, setup, undefined, f.service);
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES('202',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=$1",
        [f.w.id],
      );
      const event = message("/google", 202, 202, topicId);
      await ingress.accept(event);
      const w = await store.read(f.w.id);
      const url = new URL(w.deliveries.at(-1)?.buttons?.[0]?.[0]?.url ?? "");
      const state = url.searchParams.get("state") as string;
      expect(w.deliveries.at(-1)?.topicId).toBe(topicId ?? 0);
      expect(await ingress.accept(event)).toEqual({ duplicate: true });
      expect(
        (await store.read(w.id)).googleUsers?.["202"]?.flow?.stateHash,
      ).toBe(hash(state));
      const plugins = new PluginService(
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.service,
      );
      const app = createApp(store, setup, origin, plugins);
      const response = await app.request(
        `/api/admin/google/callback?state=${state}&code=202`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toContain("confirm your Google account");
      expect(
        (await store.read(w.id)).googleUsers?.["202"]?.connection,
      ).toBeUndefined();
      await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow(
        "google_not_connected",
      );
      const prompt = must((await store.read(w.id)).deliveries.at(-1));
      expect(prompt.topicId).toBe(topicId ?? 0);
      await new DeliveryWorker(store, setup).send(w.id, prompt.id);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.message_thread_id).toBe(topicId);
      expect(sent[0]?.chat_id).toBe("202");
      const data = prompt.buttons?.[0]?.[0]?.callback_data as string;
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      await ingress.accept(callback(data, 101));
      expect(
        (await store.read(w.id)).googleUsers?.["202"]?.connection,
      ).toBeUndefined();
      const other = await fixture("202");
      await store.pool.query(
        "UPDATE telegram_selections SET workspace_id=$1 WHERE actor='202'",
        [other.w.id],
      );
      const confirmation = callback(data, 202, topicId);
      await ingress.accept(confirmation);
      expect(
        (await store.read(w.id)).googleUsers?.["202"]?.connection?.account,
      ).toBe("202@example.test");
      expect((await store.read(other.w.id)).googleUsers).toBeUndefined();
      expect((await store.read(w.id)).deliveries.at(-1)?.topicId).toBe(
        topicId ?? 0,
      );
      await ingress.accept(confirmation);
      expect(notices.at(-1)).toContain("expired or is unavailable");
      expect(
        (await store.read(w.id)).audit.filter(
          (a) => a.action === "google.connected",
        ),
      ).toHaveLength(1);
      expect(
        (
          await app.request(
            `/api/admin/google/callback?state=${state}&code=202`,
          )
        ).status,
      ).toBe(409);
      await f.query("gmail", { resource: "messages" });
      const before = f.requests.length;
      await ingress.accept(message("/google connect", 202, -100100));
      expect(f.requests.length).toBe(before);
    },
  );
  test("polling passes Google services to the same Telegram account controls", async () => {
    const f = await fixture("202");
    await f.configure();
    await store.pool.query(
      "INSERT INTO telegram_selections(actor,workspace_id) VALUES('202',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=$1",
      [f.w.id],
    );
    const d = await store.deployment();
    d.credentials.bot = encrypt(key, "bot", "fixture-bot");
    await store.saveDeployment(store.pool, d);
    let sent = false;
    const setup = new SetupService(
      store,
      key,
      origin,
      () => ({
        async call<T>(method: string) {
          if (method === "getWebhookInfo") return { url: "" } as T;
          if (method === "getUpdates" && !sent) {
            sent = true;
            return [message("/google")] as T;
          }
          return [] as T;
        },
      }),
      "polling",
    );
    await new TelegramPoller(store, setup, undefined, f.service).pollOnce(
      new AbortController().signal,
    );
    expect((await store.read(f.w.id)).googleUsers?.["202"]?.flow).toBeDefined();
  });
  test("regular members read only their account; groups, schedules, unconnected members and stale revisions fail before provider reads", async () => {
    const f = await fixture("202");
    await f.connect();
    await f.query("google-docs", { documentId: "doc1" });
    const before = f.requests.length;
    for (const [actor, chat, scheduled] of [
      ["101", "101", false],
      ["202", "-100100", false],
      ["202", "202", true],
    ] as const) {
      const run = await store.change(f.w.id, (w) => {
        const r = createRun(w, actor, "Read Gmail", chat, 0, "gpt-4.1-mini");
        r.status = "running";
        if (scheduled) {
          const id = randomUUID();
          w.workflows.push({
            id,
            version: 1,
            owner: actor,
            status: "active",
            spec: { ...spec(w), chatId: chat },
            versions: [],
          });
          r.workflowId = id;
        }
        expect(runAllowed(w, r)).toBe(true);
        return r;
      });
      await expect(
        f.query("gmail", { resource: "messages" }, run.id),
      ).rejects.toThrow(
        actor === "101"
          ? "google_not_connected"
          : "google_private_request_required",
      );
    }
    await expect(
      f.service.query(f.w.id, f.run.id, 0, "gmail", { resource: "messages" }),
    ).rejects.toThrow();
    expect(f.requests.length).toBe(before);
  });
  test("missing scopes, offline tokens, verified identity and denied consent never create an account", async () => {
    for (const mode of ["scope", "refresh", "identity", "denied"] as const) {
      const f = await fixture("202");
      await f.configure();
      f.controls.scopes = mode !== "scope";
      f.controls.refreshToken = mode !== "refresh";
      f.controls.identityVerified = mode !== "identity";
      const consent = await f.begin();
      await expect(
        f.service.callback(
          consent.searchParams.get("state") as string,
          mode === "denied" ? undefined : "202",
        ),
      ).rejects.toThrow();
      expect(
        (await store.read(f.w.id)).googleUsers?.["202"]?.connection,
      ).toBeUndefined();
      expect(
        (await store.read(f.w.id)).googleUsers?.["202"]?.flow,
      ).toBeUndefined();
    }
  });
  test("state and confirmation expire, reject replay, and fence client, membership, domain and bot changes", async () => {
    for (const mode of [
      "expired",
      "client",
      "member",
      "bot",
      "domain",
    ] as const) {
      const f = await fixture("202");
      await f.configure();
      const url = await f.begin();
      const state = url.searchParams.get("state") as string;
      if (mode === "expired")
        await store.change(f.w.id, (w) => {
          must(must(w.googleUsers?.["202"]).flow).expiresAt = new Date(
            0,
          ).toISOString();
        });
      if (mode === "member")
        await store.change(f.w.id, (w) => {
          must(w.members.find((m) => m.id === "202")).active = false;
          revokeWork(w);
        });
      if (mode === "client")
        await f.service.save(admin, f.w.id, "google", {
          revision: 1,
          settings: { enabled: true },
          clientSecret: "replacement",
        });
      if (mode === "bot" || mode === "domain") {
        const d = await store.deployment();
        if (mode === "bot") must(d.bot).id = "998";
        else d.site = { domain: "changed.example.test", revision: 1 };
        await store.saveDeployment(store.pool, d);
      }
      await expect(f.service.callback(state, "202")).rejects.toThrow();
      if (mode === "bot" || mode === "domain") {
        const d = await store.deployment();
        must(d.bot).id = "999";
        delete d.site;
        await store.saveDeployment(store.pool, d);
      }
      expect(
        (await store.read(f.w.id)).googleUsers?.["202"]?.connection,
      ).toBeUndefined();
    }
    const f = await fixture("202");
    await f.configure();
    const url = await f.begin();
    const state = url.searchParams.get("state") as string;
    await f.service.callback(state, "202");
    await store.change(f.w.id, async (w) => {
      expect(
        await f.service.confirm(w, "202", "999", hash(state), false),
      ).toContain("rejected");
    });
    await expect(
      store.change(f.w.id, (w) =>
        f.service.confirm(w, "202", "999", hash(state), true),
      ),
    ).rejects.toThrow("google_authorization_expired");
  });
  test("refresh is serialized per account, revision-neutral, and discarded after disconnect", async () => {
    const f = await fixture("202");
    await f.connect();
    await store.change(f.w.id, (w) => {
      must(w.googleUsers?.["202"]?.connection).expiresAt = new Date(
        0,
      ).toISOString();
    });
    const revision = (await store.read(f.w.id)).plugins?.revision;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.controls.beforeToken = async () => {
      entered();
      await held;
    };
    const first = f.query("gmail", { resource: "messages" });
    await started;
    await expect(
      f.query("google-drive", { resource: "files" }),
    ).rejects.toThrow("google_refresh_pending");
    release();
    await first;
    expect((await store.read(f.w.id)).plugins?.revision).toBe(revision);
    f.controls.beforeToken = async () => {
      await store.change(f.w.id, (w) => f.service.disconnect(w, "202"));
    };
    await store.change(f.w.id, (w) => {
      must(w.googleUsers?.["202"]?.connection).expiresAt = new Date(
        0,
      ).toISOString();
    });
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow();
    expect((await store.read(f.w.id)).googleUsers?.["202"]).toBeUndefined();
  });
  test("refresh failure requires reconnect and suppressed upstream details", async () => {
    const f = await fixture("202");
    await f.connect();
    await store.change(f.w.id, (w) => {
      must(w.googleUsers?.["202"]?.connection).expiresAt = new Date(
        0,
      ).toISOString();
    });
    f.controls.refreshFailure = true;
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow(
      "google_reconnect_required",
    );
    expect(
      (await store.read(f.w.id)).googleUsers?.["202"]?.connection
        ?.reconnectRequired,
    ).toBe(true);
  });
  test("retained and derived evidence remains private to the same actor and is revoked during reads or after disconnect", async () => {
    const f = await fixture("202");
    await f.connect();
    await f.query("gmail", { resource: "messages" });
    const w = await store.read(f.w.id),
      original = must(w.runs[0]);
    expect(googleReadAllowed(w, original)).toBe(true);
    expect(googleReadAllowed(w, original, "998")).toBe(false);
    const source = {
      id: "derived-source",
      runId: original.id,
      role: "assistant" as const,
      chatId: "202",
      topicId: 0,
      author: "assistant",
      text: "private",
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      directed: true,
    };
    const derived = {
      ...original,
      id: randomUUID(),
      googleRead: undefined,
      sources: [source],
    };
    expect(googleReadAllowed(w, derived)).toBe(true);
    expect(
      googleReadAllowed(w, { ...derived, actor: "101", chatId: "101" }),
    ).toBe(false);
    f.controls.beforeRead = () =>
      store.change(w.id, (current) => f.service.disconnect(current, "202"));
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow();
    const current = await store.read(w.id);
    expect(googleReadAllowed(current, derived)).toBe(false);
    expect(runAllowed(current, must(current.runs[0]))).toBe(false);
    expect(current.runs[0]?.result).toBeUndefined();
  });
  test("admin APIs configure only the client, preserve blank secrets and enforce Origin, CSRF, operator, tenant and revision boundaries", async () => {
    const f = await fixture("202");
    await f.connect();
    const plugins = new PluginService(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.service,
    );
    const app = createApp(
      store,
      new SetupService(store, key, origin, () => ({
        async call<T>() {
          return {} as T;
        },
      })),
      origin,
      plugins,
    );
    const endpoint = `/api/admin/workspaces/${f.w.id}/plugins/google`;
    const headers = {
      cookie: `repodesk_session=${auth.raw}`,
      origin,
      "x-csrf-token": auth.csrf,
      "content-type": "application/json",
    };
    expect((await app.request(endpoint)).status).toBe(401);
    const data = await (await app.request(endpoint, { headers })).json();
    expect(data.clientSecretConfigured).toBe(true);
    for (const secret of [
      "clientSecret",
      "account",
      "accessToken",
      "refreshToken",
      "googleUsers",
    ])
      expect(data).not.toHaveProperty(secret);
    expect(JSON.stringify(data)).not.toContain("202@example.test");
    const body = JSON.stringify({ revision: 1, settings: { enabled: true } });
    expect(
      (
        await app.request(endpoint, {
          method: "PUT",
          headers: { ...headers, origin: "https://foreign.test" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(endpoint, {
          method: "PUT",
          headers: { ...headers, "x-csrf-token": "bad" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request(endpoint, { method: "PUT", headers, body })).status,
    ).toBe(200);
    expect(
      (await app.request(endpoint, { method: "PUT", headers, body })).status,
    ).toBe(409);
    expect(
      (await store.read(f.w.id)).googleUsers?.["202"]?.connection,
    ).toBeDefined();
    for (const path of [
      `${endpoint}/connect`,
      `${endpoint}/disconnect`,
      endpoint.replace("google", "search-console/properties"),
    ])
      expect(
        (await app.request(path, { method: "POST", headers, body: "{}" }))
          .status,
      ).toBeGreaterThanOrEqual(400);
    await expect(
      f.service.view({ ...admin, id: randomUUID() }, f.w.id),
    ).rejects.toThrow("access_denied");
    await expect(
      f.service.view({ ...admin, operator: false }, f.w.id),
    ).rejects.toThrow("operator_required");
    await f.service.save(admin, f.w.id, "google", {
      revision: 2,
      settings: { enabled: true },
      clientSecret: "replacement",
    });
    expect((await store.read(f.w.id)).googleUsers).toBeUndefined();
  });
  test("legacy clients can be reused but old shared tokens never authorize personal reads; migration erases them", async () => {
    const f = await fixture("202");
    await store.change(f.w.id, (w) => {
      w.plugins = {
        revision: 1,
        entries: [],
        google: {
          gmail: {
            settings: { enabled: true },
            clientId: "legacy.apps.googleusercontent.com",
            clientSecret: encrypt(
              key,
              `google:${w.id}:gmail:client:legacy.apps.googleusercontent.com`,
              "old-secret",
            ),
            connection: {
              id: "old",
              subject: "old",
              account: "old@example.test",
              accessToken: "old-access",
              refreshToken: "old-refresh",
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          },
        },
        searchConsole: {
          settings: { enabled: true, siteUrls: ["sc-domain:example.test"] },
          credential: "old-service-key",
        },
      };
    });
    expect((await f.service.view(admin, f.w.id)).legacy).toBe(true);
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow(
      "google_not_configured",
    );
    await store.pool.query(
      await readFile("migrations/020_google_personal_accounts.sql", "utf8"),
    );
    await store.pool.query(
      await readFile("migrations/020_google_personal_accounts.sql", "utf8"),
    );
    expect(
      (await store.read(f.w.id)).plugins?.google?.gmail?.connection,
    ).toBeUndefined();
    expect((await store.read(f.w.id)).plugins?.searchConsole).toBeUndefined();
    const page = await f.service.save(admin, f.w.id, "google", {
      revision: 1,
      settings: { enabled: true },
    });
    expect(page.clientId).toBe("legacy.apps.googleusercontent.com");
    expect(
      decrypt(
        key,
        `google:${f.w.id}:google:client:${page.clientId}`,
        must((await store.read(f.w.id)).plugins?.google?.google).clientSecret,
      ),
    ).toBe("old-secret");
    expect((await store.read(f.w.id)).googleUsers).toBeUndefined();
  });
  test("membership revocation and workspace purge erase personal tokens and pending flows", async () => {
    const f = await fixture("202");
    await f.connect();
    await f.begin();
    await store.change(f.w.id, (w) => {
      must(w.members.find((m) => m.id === "202")).active = false;
      revokeWork(w);
    });
    expect((await store.read(f.w.id)).googleUsers?.["202"]).toBeUndefined();
    await f.connect("101");
    await store.change(f.w.id, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "pending",
      };
      sweep(w);
    });
    expect((await store.read(f.w.id)).googleUsers).toBeUndefined();
  });
  test("bounded read tools handle tabs, ranges, filename escaping and Gmail MIME without arbitrary API access", async () => {
    const f = await fixture();
    await f.connect();
    expect(
      JSON.stringify(await f.query("google-docs", { documentId: "doc1" })),
    ).toContain("Table cell");
    expect(f.requests.at(-1)?.url.searchParams.get("includeTabsContent")).toBe(
      "true",
    );
    expect(
      await f.query("google-sheets", {
        resource: "values",
        spreadsheetId: "sheet1",
        range: "'Q1'!A1:B2",
      }),
    ).toMatchObject({ values: [["Revenue", "10"]] });
    expect(f.requests.at(-1)?.url.pathname).toContain("'Q1'!A1%3AB2");
    expect(
      JSON.stringify(
        await f.query("google-sheets", {
          resource: "spreadsheet",
          spreadsheetId: "sheet1",
        }),
      ),
    ).not.toContain("secret");
    expect(
      await f.query("google-drive", {
        resource: "files",
        query: "Bob's \\ plan",
        pageToken: "cursor",
      }),
    ).toMatchObject({
      nextPageToken: "next-page",
      incompleteSearch: true,
      files: [{ id: "file1", name: "Budget" }],
    });
    expect(f.requests.at(-1)?.url.searchParams.get("q")).toBe(
      "trashed = false and name contains 'Bob\\'s \\\\ plan'",
    );
    expect(f.requests.at(-1)?.url.searchParams.get("pageToken")).toBe("cursor");
    expect(
      await f.query("google-drive", { resource: "file", fileId: "file1" }),
    ).toEqual({
      id: "file1",
      name: "Budget",
      mimeType: "application/vnd.google-apps.spreadsheet",
    });
    expect(
      await f.query("gmail", {
        resource: "messages",
        query: "from:friend@example.test",
        pageToken: "cursor",
      }),
    ).toMatchObject({
      nextPageToken: "mail-next",
      messages: [{ id: "mail1", threadId: "thread1" }],
    });
    expect(
      await f.query("gmail", { resource: "message", messageId: "mail1" }),
    ).toMatchObject({
      text: "Message content",
      headers: [{ name: "Subject", value: "Hello" }],
      plainTextAvailable: true,
    });
    for (const args of [
      { resource: "message", messageId: "../other" },
      { resource: "message", messageId: "mail1", userId: "other" },
      { resource: "send", raw: "mail" },
    ])
      await expect(f.query("gmail", args)).rejects.toThrow();
    await expect(
      f.query("google-sheets", {
        resource: "values",
        spreadsheetId: "sheet1",
      }),
    ).rejects.toThrow();
  });
  test("Pi registers one Google plugin with four account tools and reuses a duplicate completed read", async () => {
    const f = await fixture();
    await f.connect();
    const revision = (await store.read(f.w.id)).plugins?.revision ?? 0;
    const input: AgentInput = {
      workspaceId: f.w.id,
      actor: "101",
      runId: f.run.id,
      model: selectedModel("gpt-4.1-mini"),
      apiKey: "fake",
      system: "",
      prompt: "",
      transcript: [],
      tools: [],
      signal: new AbortController().signal,
      guard: async () => {},
      reserve: async () => "attempt",
      checkpoint: async () => {},
    };
    input.extensionTool = extensionToolExecution(
      store,
      f.w.id,
      f.run.id,
      f.run.fence,
      input.signal,
    );
    const host = await ExtensionCatalog.fromSnapshot(
      [],
      [googleWorkspaceExtension(f.service, undefined, f.w.id, revision)],
    ).open(input);
    try {
      expect(host?.tools.map((t) => t.name).sort()).toEqual(
        googlePlugins.map((p) => googleDefinitions[p].tool).sort(),
      );
      const tool = host?.tools.find((t) => t.name === "query_gmail");
      if (!tool) throw Error("missing Gmail tool");
      const before = f.requests.length;
      const result = await tool.execute(
        "read-once",
        { resource: "messages" },
        input.signal,
      );
      expect(
        await tool.execute("read-once", { resource: "messages" }, input.signal),
      ).toEqual(result);
      expect(f.requests).toHaveLength(before + 1);
      await store.change(f.w.id, (w) => f.service.disconnect(w, "101"));
      await expect(
        tool.execute("read-once", { resource: "messages" }, input.signal),
      ).rejects.toThrow();
    } finally {
      await host?.close();
    }
  });
  test("queued connection prompts recheck flow, member, configuration and bot before mock delivery", async () => {
    let sends = 0;
    const setup = new SetupService(store, key, origin, () => ({
      async call<T>() {
        sends++;
        return { message_id: 700 } as T;
      },
    }));
    for (const mode of [
      "valid",
      "expired",
      "disconnected",
      "revision",
      "member",
      "bot",
    ] as const) {
      const f = await fixture("202");
      await f.configure();
      const url = await f.begin();
      await f.service.callback(url.searchParams.get("state") as string, "202");
      const id = (await store.read(f.w.id)).deliveries.at(-1)?.id ?? "";
      await store.change(f.w.id, (w) => {
        if (mode === "expired")
          must(must(w.googleUsers?.["202"]).flow).expiresAt = new Date(
            0,
          ).toISOString();
        if (mode === "disconnected") f.service.disconnect(w, "202");
        if (mode === "revision" && w.plugins) w.plugins.revision++;
        if (mode === "member") {
          must(w.members.find((m) => m.id === "202")).active = false;
          revokeWork(w);
        }
      });
      if (mode === "bot") {
        const d = await store.deployment();
        must(d.bot).id = "998";
        await store.saveDeployment(store.pool, d);
      }
      const before = sends;
      await new DeliveryWorker(store, setup).send(f.w.id, id);
      expect(sends - before).toBe(mode === "valid" ? 1 : 0);
      if (mode === "bot") {
        const d = await store.deployment();
        must(d.bot).id = "999";
        await store.saveDeployment(store.pool, d);
      }
    }
  });
  test("a site address change after browser consent invalidates Telegram confirmation", async () => {
    const f = await fixture("202");
    await f.configure();
    const url = await f.begin();
    const state = url.searchParams.get("state") as string;
    await f.service.callback(state, "202");
    const d = await store.deployment();
    d.site = { domain: "changed.example.test", revision: 1 };
    await store.saveDeployment(store.pool, d);
    try {
      await expect(
        store.change(f.w.id, (w) =>
          f.service.confirm(w, "202", "999", hash(state), true),
        ),
      ).rejects.toThrow("google_authorization_expired");
      expect(
        (await store.read(f.w.id)).googleUsers?.["202"]?.connection,
      ).toBeUndefined();
    } finally {
      delete d.site;
      await store.saveDeployment(store.pool, d);
    }
  });
  test("file grants are preserved and Google tool collisions are rejected in both directions", async () => {
    const f = await fixture();
    const legacy: PluginRecord = {
      id: "legacy-plugin",
      version: "1",
      path: "/fixture/not-loaded.ts",
      execution: "read-only",
      enabled: false,
      tools: ["query_gmail"],
      workspaces: [f.w.id],
    };
    await f.service.save(
      admin,
      f.w.id,
      "google",
      {
        revision: 0,
        settings: { enabled: true },
        clientId: "google.apps.googleusercontent.com",
        clientSecret: "fixture-secret",
      },
      [legacy],
    );
    const plugins = new PluginService(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.service,
    );
    expect((await store.read(f.w.id)).plugins?.entries).toEqual([legacy]);
    await expect(
      plugins.save(admin, f.w.id, {
        revision: 1,
        entries: [{ ...legacy, enabled: true }],
      }),
    ).rejects.toThrow("extension_tool_collision");
    await store.change(f.w.id, (w) => {
      const entry = w.plugins?.entries[0];
      if (entry) entry.enabled = true;
    });
    await expect(
      f.service.save(admin, f.w.id, "google", {
        revision: 1,
        settings: { enabled: true },
      }),
    ).rejects.toThrow("extension_tool_collision");
  });
});
