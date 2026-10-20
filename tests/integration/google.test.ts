import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  type GooglePlugin,
  googleDefinitions,
  googlePlugins,
} from "../../src/google/config.ts";
import { googleExtension } from "../../src/google/extension.ts";
import { googleReadAllowed } from "../../src/google/policy.ts";
import { GoogleService } from "../../src/google/service.ts";
import { sweep } from "../../src/privacy/service.ts";
import { decrypt, hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { retainedSource } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)("independent Google plugins", () => {
  const root = database(rootUrl ?? "postgres://unused@localhost/unused");
  const name = `repodesk_google_${randomUUID().replaceAll("-", "")}`;
  const key = "ab".repeat(32);
  let store: Store;
  let admin: Admin;
  let auth: { raw: string; csrf: string };
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(rootUrl ?? "");
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
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function fixture(actor = "101", chat = actor) {
    const w = workspace();
    w.operatorId = admin.id;
    const run = createRun(
      w,
      actor,
      "Read Google data",
      chat,
      0,
      "gpt-4.1-mini",
    );
    run.status = "running";
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, admin.id, JSON.stringify(w)],
    );
    const requests: { url: URL; init: RequestInit }[] = [];
    const controls = {
      scopes: true,
      refreshToken: true,
      refreshFailure: false,
      beforeRead: undefined as (() => Promise<void>) | undefined,
      beforeToken: undefined as (() => Promise<void>) | undefined,
    };
    const service = new GoogleService(
      store,
      key,
      "http://localhost:3000",
      async (rawUrl, init) => {
        const url = new URL(rawUrl);
        requests.push({ url, init });
        expect(init.redirect).toBe("error");
        if (url.hostname === "oauth2.googleapis.com") {
          const params = new URLSearchParams(String(init.body));
          const plugin = googlePlugins.find(
            (p) =>
              params.get("client_id") === `${p}.apps.googleusercontent.com`,
          ) as GooglePlugin;
          expect(plugin).toBeDefined();
          await controls.beforeToken?.();
          if (
            controls.refreshFailure &&
            params.get("grant_type") === "refresh_token"
          )
            return Response.json(
              {
                error: "invalid_grant",
                error_description: "private upstream detail",
              },
              { status: 400 },
            );
          return Response.json({
            access_token: `access-${plugin}`,
            ...(controls.refreshToken
              ? { refresh_token: `refresh-${plugin}` }
              : {}),
            expires_in: 3600,
            token_type: "Bearer",
            scope: controls.scopes
              ? `openid email ${googleDefinitions[plugin].scope}`
              : "openid email",
          });
        }
        if (url.hostname === "openidconnect.googleapis.com")
          return Response.json({
            sub: "fixture-account",
            email: "fixture@example.test",
            email_verified: true,
          });
        await controls.beforeRead?.();
        expect(init.method).toBe("GET");
        expect(new Headers(init.headers).get("authorization")).toStartWith(
          "Bearer access-",
        );
        if (url.hostname === "docs.googleapis.com")
          return Response.json({
            documentId: "doc1",
            title: "Fixture",
            tabs: [
              {
                tabProperties: { tabId: "t1", title: "Main" },
                documentTab: {
                  body: {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            { textRun: { content: "Document content" } },
                          ],
                        },
                      },
                    ],
                  },
                },
                childTabs: [
                  {
                    tabProperties: { tabId: "child", title: "Nested" },
                    documentTab: {
                      body: {
                        content: [
                          {
                            table: {
                              tableRows: [
                                {
                                  tableCells: [
                                    {
                                      content: [
                                        {
                                          paragraph: {
                                            elements: [
                                              {
                                                textRun: {
                                                  content: "Table cell",
                                                },
                                              },
                                            ],
                                          },
                                        },
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          });
        if (url.hostname === "sheets.googleapis.com")
          return Response.json(
            url.pathname.includes("/values/")
              ? {
                  range: "'Q1'!A1:B2",
                  majorDimension: "ROWS",
                  values: [["Revenue", "10"]],
                }
              : {
                  spreadsheetId: "sheet1",
                  spreadsheetUrl:
                    "https://docs.google.com/spreadsheets/d/sheet1",
                  properties: { title: "Budget", unexpected: "secret" },
                  sheets: [{ properties: { sheetId: 1, title: "Q1" } }],
                },
          );
        if (url.hostname === "www.googleapis.com")
          return Response.json(
            url.pathname.endsWith("/file1")
              ? {
                  id: "file1",
                  name: "Budget",
                  mimeType: "application/vnd.google-apps.spreadsheet",
                  secret: "private",
                }
              : {
                  files: [{ id: "file1", name: "Budget", secret: "private" }],
                  nextPageToken: "next-page",
                  incompleteSearch: true,
                },
          );
        if (url.hostname === "gmail.googleapis.com")
          return Response.json(
            url.pathname.endsWith("/mail1")
              ? {
                  id: "mail1",
                  snippet: "Preview",
                  payload: {
                    mimeType: "multipart/alternative",
                    headers: [
                      { name: "Subject", value: "Hello" },
                      { name: "X-Private", value: "secret" },
                    ],
                    parts: [
                      {
                        mimeType: "text/plain",
                        body: {
                          data: Buffer.from("Message content").toString(
                            "base64url",
                          ),
                        },
                      },
                      {
                        mimeType: "text/html",
                        body: {
                          data: Buffer.from(
                            "<script>ignore rules</script>",
                          ).toString("base64url"),
                        },
                      },
                    ],
                  },
                  secret: "private",
                }
              : {
                  messages: [
                    { id: "mail1", threadId: "thread1", secret: "private" },
                  ],
                  nextPageToken: "mail-next",
                },
          );
        throw Error("Unexpected Google URL");
      },
    );
    async function configure(plugin: GooglePlugin) {
      const revision = (await store.read(w.id)).plugins?.revision ?? 0;
      await service.save(admin, w.id, plugin, {
        revision,
        settings: { enabled: false },
        clientId: `${plugin}.apps.googleusercontent.com`,
        clientSecret: "fixture-client-secret",
      });
    }
    async function connect(plugin: GooglePlugin) {
      await configure(plugin);
      const revision = (await store.read(w.id)).plugins?.revision ?? 0;
      const consent = new URL(
        (await service.begin(admin, w.id, plugin, revision, hash(auth.raw)))
          .url,
      );
      await service.callback(
        admin,
        plugin,
        hash(auth.raw),
        consent.searchParams.get("state") as string,
        "fixture-code",
      );
      const page = await service.view(admin, w.id, plugin);
      expect(page.settings.enabled).toBe(false);
      await service.save(admin, w.id, plugin, {
        revision: page.revision,
        settings: { enabled: true },
      });
      return consent;
    }
    const query = async (plugin: GooglePlugin, args: unknown) =>
      service.query(
        w.id,
        run.id,
        (await store.read(w.id)).plugins?.revision ?? 0,
        plugin,
        args,
      );
    return { w, run, service, requests, controls, configure, connect, query };
  }
  test("four standalone connections request separate scopes, encrypt tokens and preserve each other", async () => {
    const f = await fixture();
    for (const plugin of googlePlugins) {
      const url = await f.connect(plugin);
      expect(url.searchParams.get("scope")).toBe(
        `openid email ${googleDefinitions[plugin].scope}`,
      );
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("include_granted_scopes")).toBe("false");
      expect(url.searchParams.get("redirect_uri")).toBe(
        `http://localhost:3000/api/admin/google/${plugin}/callback`,
      );
      expect(googleExtension(f.service, f.w.id, 1, plugin).tools).toEqual([
        googleDefinitions[plugin].tool,
      ]);
    }
    const saved = await store.read(f.w.id);
    expect(Object.keys(saved.plugins?.google ?? {})).toHaveLength(4);
    for (const plugin of googlePlugins) {
      const config = saved.plugins?.google?.[plugin];
      expect(config?.settings.enabled).toBe(true);
      expect(
        JSON.stringify(await f.service.view(admin, f.w.id, plugin)),
      ).not.toContain("fixture-client-secret");
      expect(config?.connection?.accessToken).not.toContain("access-");
      expect(
        decrypt(
          key,
          `google:${f.w.id}:${plugin}:access`,
          config?.connection?.accessToken ?? "",
        ),
      ).toBe(`access-${plugin}`);
      expect(() =>
        decrypt(
          key,
          `google:other-workspace:${plugin}:access`,
          config?.connection?.accessToken ?? "",
        ),
      ).toThrow();
    }
    await f.service.disconnect(
      admin,
      f.w.id,
      "gmail",
      saved.plugins?.revision ?? 0,
    );
    expect(
      (await store.read(f.w.id)).plugins?.google?.["google-docs"]?.settings
        .enabled,
    ).toBe(true);
    expect(
      (await store.read(f.w.id)).plugins?.google?.gmail?.connection,
    ).toBeUndefined();
  });
  test("bounded read tools handle tabs, ranges, filename escaping and Gmail MIME without arbitrary API access", async () => {
    const f = await fixture();
    for (const plugin of googlePlugins) await f.connect(plugin);
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
      f.query("google-sheets", { resource: "values", spreadsheetId: "sheet1" }),
    ).rejects.toThrow();
  });
  test("members, group chats, scheduled runs, disabled plugins and stale revisions cannot read", async () => {
    for (const [actor, chat, workflow] of [
      ["202", "202", false],
      ["101", "-100100", false],
      ["101", "101", true],
    ] as const) {
      const f = await fixture(actor, chat);
      await f.connect("gmail");
      if (workflow)
        await store.change(f.w.id, (w) => {
          const r = w.runs[0];
          if (r) r.workflowId = randomUUID();
        });
      const before = f.requests.length;
      await expect(
        f.query("gmail", { resource: "messages" }),
      ).rejects.toThrow();
      expect(f.requests).toHaveLength(before);
    }
    const f = await fixture();
    await f.connect("gmail");
    await expect(
      f.service.query(f.w.id, f.run.id, 1, "gmail", { resource: "messages" }),
    ).rejects.toThrow("extension_configuration_changed");
    const view = await f.service.view(admin, f.w.id, "gmail");
    await f.service.save(admin, f.w.id, "gmail", {
      revision: view.revision,
      settings: { enabled: false },
    });
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow(
      "google_not_connected",
    );
  });
  test("OAuth state is actor/session/plugin bound, one use, expiring and fenced by revision/disconnect", async () => {
    const f = await fixture();
    await f.configure("gmail");
    const begin = async () =>
      new URL(
        (
          await f.service.begin(
            admin,
            f.w.id,
            "gmail",
            (
              await f.service.view(admin, f.w.id, "gmail")
            ).revision,
            hash(auth.raw),
          )
        ).url,
      ).searchParams.get("state") as string;
    const state = await begin();
    const before = f.requests.length;
    await expect(
      f.service.callback(admin, "google-docs", hash(auth.raw), state, "code"),
    ).rejects.toThrow();
    await expect(
      f.service.callback(admin, "gmail", "other-session", state, "code"),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(before);
    await f.service.callback(admin, "gmail", hash(auth.raw), state, "code");
    await expect(
      f.service.callback(admin, "gmail", hash(auth.raw), state, "code"),
    ).rejects.toThrow("google_authorization_expired");
    const late = await begin();
    await f.service.disconnect(
      admin,
      f.w.id,
      "gmail",
      (await f.service.view(admin, f.w.id, "gmail")).revision,
    );
    await expect(
      f.service.callback(admin, "gmail", hash(auth.raw), late, "code"),
    ).rejects.toThrow("google_authorization_expired");
    const expired = await begin();
    await store.change(f.w.id, (w) => {
      const flow = w.plugins?.google?.gmail?.flow;
      if (flow) flow.expiresAt = new Date(0).toISOString();
    });
    await expect(
      f.service.callback(admin, "gmail", hash(auth.raw), expired, "code"),
    ).rejects.toThrow("google_authorization_expired");
  });
  test("missing product scope, absent offline token and denied consent fail closed", async () => {
    for (const mode of ["scopes", "refreshToken", "denied"] as const) {
      const f = await fixture();
      await f.configure("gmail");
      if (mode !== "denied") f.controls[mode] = false;
      const state = new URL(
        (await f.service.begin(admin, f.w.id, "gmail", 1, hash(auth.raw))).url,
      ).searchParams.get("state") as string;
      await expect(
        f.service.callback(
          admin,
          "gmail",
          hash(auth.raw),
          state,
          mode === "denied" ? undefined : "code",
        ),
      ).rejects.toThrow();
      expect(
        (await store.read(f.w.id)).plugins?.google?.gmail?.connection,
      ).toBeUndefined();
      expect(
        (await store.read(f.w.id)).plugins?.google?.gmail?.flow,
      ).toBeUndefined();
    }
  });
  test("replacing credentials disconnects one plugin, blank saves retain tokens and conflicts preserve saved state", async () => {
    const f = await fixture();
    await f.connect("gmail");
    await f.connect("google-docs");
    const old = await store.read(f.w.id);
    await f.service.save(admin, f.w.id, "gmail", {
      revision: old.plugins?.revision,
      settings: { enabled: true },
    });
    expect(
      (await store.read(f.w.id)).plugins?.google?.gmail?.connection,
    ).toEqual(old.plugins?.google?.gmail?.connection);
    await expect(
      f.service.save(admin, f.w.id, "gmail", {
        revision: old.plugins?.revision,
        settings: { enabled: false },
      }),
    ).rejects.toThrow("version_conflict");
    await f.service.save(admin, f.w.id, "gmail", {
      revision: (old.plugins?.revision ?? 0) + 1,
      settings: { enabled: true },
      clientSecret: "replacement-secret",
    });
    const updated = await store.read(f.w.id);
    expect(updated.plugins?.google?.gmail?.connection).toBeUndefined();
    expect(updated.plugins?.google?.gmail?.settings.enabled).toBe(false);
    expect(updated.plugins?.google?.["google-docs"]).toEqual(
      old.plugins?.google?.["google-docs"],
    );
  });
  test("refresh is durable, serialized, revision-neutral and discarded after disconnect", async () => {
    const f = await fixture();
    await f.connect("gmail");
    await store.change(f.w.id, (w) => {
      const c = w.plugins?.google?.gmail?.connection;
      if (c) c.expiresAt = new Date(0).toISOString();
    });
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.controls.beforeToken = async () => {
      started();
      await wait;
    };
    const revision = (await store.read(f.w.id)).plugins?.revision;
    const first = f.query("gmail", { resource: "messages" });
    await entered;
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow(
      "google_refresh_pending",
    );
    release();
    await first;
    expect((await store.read(f.w.id)).plugins?.revision).toBe(revision);
    expect(
      f.requests.filter(
        (r) =>
          new URLSearchParams(String(r.init.body)).get("grant_type") ===
          "refresh_token",
      ),
    ).toHaveLength(1);
    await store.change(f.w.id, (w) => {
      const c = w.plugins?.google?.gmail?.connection;
      if (c) c.expiresAt = new Date(0).toISOString();
    });
    f.controls.beforeToken = async () => {
      await f.service.disconnect(admin, f.w.id, "gmail", revision ?? 0);
    };
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow();
    expect(
      (await store.read(f.w.id)).plugins?.google?.gmail?.connection,
    ).toBeUndefined();
  });
  test("failed refresh requires reconnect and omits upstream errors", async () => {
    const f = await fixture();
    await f.connect("gmail");
    f.controls.refreshFailure = true;
    await store.change(f.w.id, (w) => {
      const c = w.plugins?.google?.gmail?.connection;
      if (c) c.expiresAt = new Date(0).toISOString();
    });
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow(
      "google_reconnect_required",
    );
    expect((await f.service.view(admin, f.w.id, "gmail")).status).toBe(
      "reconnect_required",
    );
  });
  test("revocation during provider reads suppresses evidence, delivery and derived sources", async () => {
    const f = await fixture();
    await f.connect("gmail");
    await f.query("gmail", { resource: "messages" });
    const current = await store.read(f.w.id);
    const readRun = current.runs[0];
    if (!readRun) throw Error("missing run");
    expect(googleReadAllowed(current, readRun)).toBe(true);
    const source = {
      id: randomUUID(),
      role: "assistant" as const,
      runId: readRun.id,
      actor: "101",
      chatId: "101",
      topicId: 0,
      text: "Mail result",
      author: "assistant",
      directed: true,
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const derived = {
      ...readRun,
      id: randomUUID(),
      sources: [source],
      googleRead: undefined,
    };
    current.runs.push(derived);
    expect(
      googleReadAllowed(current, { ...derived, actor: "202", chatId: "202" }),
    ).toBe(false);
    const config = current.plugins?.google?.gmail;
    if (config) config.settings.enabled = false;
    expect(runAllowed(current, readRun)).toBe(false);
    expect(googleReadAllowed(current, derived)).toBe(false);
    expect(retainedSource(current, source)).toBe(false);
    f.controls.beforeRead = async () => {
      await f.service.disconnect(
        admin,
        f.w.id,
        "gmail",
        (await f.service.view(admin, f.w.id, "gmail")).revision,
      );
    };
    await expect(f.query("gmail", { resource: "messages" })).rejects.toThrow();
  });
  test("admin routes enforce tenant/operator, Origin, CSRF, redaction and version checks", async () => {
    const f = await fixture();
    await f.configure("gmail");
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
      new SetupService(store, key, "http://localhost:3000"),
      "http://localhost:3000",
      plugins,
    );
    const endpoint = `/api/admin/workspaces/${f.w.id}/plugins/google/gmail`;
    const headers = {
      cookie: `repodesk_session=${auth.raw}`,
      origin: "http://localhost:3000",
      "x-csrf-token": auth.csrf,
      "content-type": "application/json",
    };
    expect((await app.request(endpoint)).status).toBe(401);
    const response = await app.request(endpoint, { headers });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.clientSecretConfigured).toBe(true);
    expect(data.clientSecret).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("fixture-client-secret");
    const body = JSON.stringify({ revision: 1, settings: { enabled: false } });
    expect(
      (
        await app.request(endpoint, {
          method: "PUT",
          headers: { ...headers, origin: "https://other.test" },
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
    await expect(
      f.service.view({ ...admin, id: randomUUID() }, f.w.id, "gmail"),
    ).rejects.toThrow("access_denied");
    await expect(
      f.service.view({ ...admin, operator: false }, f.w.id, "gmail"),
    ).rejects.toThrow("operator_required");
  });
  test("Pi registers four independent tools and reuses a duplicate completed read", async () => {
    const f = await fixture();
    for (const plugin of googlePlugins) await f.connect(plugin);
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
      googlePlugins.map((plugin) =>
        googleExtension(f.service, f.w.id, revision, plugin),
      ),
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
      await f.service.disconnect(admin, f.w.id, "gmail", revision);
      await expect(
        tool.execute("read-once", { resource: "messages" }, input.signal),
      ).rejects.toThrow();
    } finally {
      await host?.close();
    }
  });
  test("Google saves preserve legacy file grants and tool collisions are rejected in both directions", async () => {
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
      "gmail",
      {
        revision: 0,
        settings: { enabled: false },
        clientId: "gmail.apps.googleusercontent.com",
        clientSecret: "fixture-secret",
      },
      [legacy],
    );
    await f.connect("gmail");
    const plugins = new PluginService(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.service,
    );
    const before = await store.read(f.w.id);
    expect(before.plugins?.entries).toEqual([legacy]);
    await expect(
      plugins.save(admin, f.w.id, {
        revision: before.plugins?.revision,
        entries: [{ ...legacy, enabled: true }],
      }),
    ).rejects.toThrow("extension_tool_collision");
    await store.change(f.w.id, (w) => {
      if (w.plugins?.entries[0]) w.plugins.entries[0].enabled = true;
    });
    await expect(
      f.service.save(admin, f.w.id, "gmail", {
        revision: before.plugins?.revision,
        settings: { enabled: true },
      }),
    ).rejects.toThrow("extension_tool_collision");
  });
  test("workspace deletion purges Google credentials with the plugin registry", async () => {
    const f = await fixture();
    await f.connect("gmail");
    const current = await store.read(f.w.id);
    current.deletion = { requestedAt: new Date().toISOString() } as NonNullable<
      typeof current.deletion
    >;
    sweep(current);
    expect(current.plugins).toBeUndefined();
  });
});
