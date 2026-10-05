import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim, login } from "../../src/admin/auth.ts";
import { SiteService } from "../../src/admin/site.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { GitHubService } from "../../src/github/service.ts";
import { encrypt, hash, passwordHash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("admin site domain", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `site_test_${randomUUID().replaceAll("-", "")}`;
  const fallback = "http://localhost:3000",
    custom = "https://admin.example.com",
    key = "ab".repeat(32);
  const endpoint = "/api/admin/operator/site";
  let store: Store,
    setup: SetupService,
    app: ReturnType<typeof createApp>,
    admin: Admin;
  let auth: { raw: string; csrf: string },
    member: { raw: string; csrf: string };
  let registeredUrl = "";
  let setWebhookCalls = 0;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    auth = await claim(store.pool, "siteoperator", "site test password");
    admin = {
      id: (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='siteoperator'",
        )
      ).rows[0].id,
      username: "siteoperator",
      operator: true,
    };
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'sitemember',$2,false)",
      [randomUUID(), await passwordHash("member test password")],
    );
    member = await login(store.pool, "sitemember", "member test password");
    setup = new SetupService(store, key, fallback, () => ({
      async call<T>(method: string, params?: Record<string, unknown>) {
        if (method === "setWebhook") {
          setWebhookCalls++;
          registeredUrl = String(params?.url);
        }
        return { url: registeredUrl } as T;
      },
    }));
    app = createApp(store, setup, fallback);
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        cookie: `repodesk_session=${auth.raw}`,
        origin: fallback,
        "x-csrf-token": auth.csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  test("only deployment operators can read or write; forged origins and CSRF fail", async () => {
    expect(
      (await request(endpoint, "GET", undefined, { cookie: "" })).status,
    ).toBe(401);
    expect(
      (
        await request(endpoint, "GET", undefined, {
          cookie: `repodesk_session=${member.raw}`,
        })
      ).status,
    ).toBe(403);
    const input = { revision: 0, domain: "admin.example.com" };
    for (const headers of [
      { origin: custom },
      { origin: "https://evil.example" },
      { origin: "" },
      { "x-csrf-token": "wrong" },
      { cookie: `repodesk_session=${member.raw}`, "x-csrf-token": member.csrf },
    ])
      expect((await request(endpoint, "PUT", input, headers)).status).toBe(403);
    for (const domain of [
      "https://admin.example.com/path",
      "admin.example.com:443",
      "localhost",
    ]) {
      expect(
        (await request(endpoint, "PUT", { ...input, domain })).status,
      ).toBe(400);
    }
    expect((await store.deployment()).site).toBeUndefined();
  });
  test("changes persist, are audited once, invalidate callbacks, and enforce optimistic revisions", async () => {
    const w = workspace();
    w.operatorId = admin.id;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, admin.id, JSON.stringify(w)],
    );
    const github = new GitHubService(store, key, fallback);
    await github.register(admin, w.id, hash(auth.raw), {
      owner: "personal",
      name: "RepoDesk",
      public: false,
    });
    const d = await store.deployment();
    d.webhookReady = true;
    d.credentials.bot = encrypt(key, "bot", "test-token");
    d.credentials.webhook = encrypt(key, "webhook", "test-secret");
    await store.saveDeployment(store.pool, d);
    const result = await request(endpoint, "PUT", {
      revision: 0,
      domain: " ADMIN.Example.COM ",
    });
    expect(result.status).toBe(200);
    const site = await result.json();
    expect(site).toMatchObject({
      revision: 1,
      domain: "admin.example.com",
      origin: custom,
      fallbackOrigin: fallback,
      webhookReady: false,
    });
    expect(
      (await store.pool.query("SELECT * FROM github_app_flows")).rowCount,
    ).toBe(0);
    expect((await store.deployment()).version).toBe(d.version + 1);
    const restarted = new SiteService(new Store(store.pool), fallback);
    expect((await restarted.view(admin, "webhook")).origin).toBe(custom);
    expect(
      (
        await request(endpoint, "PUT", {
          revision: 0,
          domain: "other.example.com",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          endpoint,
          "PUT",
          { revision: 1, domain: "admin.example.com" },
          { origin: custom },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await store.pool.query(
          "SELECT * FROM operator_audit WHERE action='site.domain_changed'",
        )
      ).rowCount,
    ).toBe(1);
    const next = await github.register(admin, w.id, hash(auth.raw), {
      owner: "personal",
      name: "RepoDesk",
      public: false,
    });
    expect(next.manifest).toMatchObject({
      url: custom,
      callback_urls: [site.githubCallbackUrl],
      redirect_url: site.githubSetupUrl,
    });
    const configured = new GitHubService(
      store,
      key,
      fallback,
      new GitHubApp(githubFixtureConfig, githubTransport()),
    );
    const connection = await configured.begin(admin, w.id, hash(auth.raw));
    expect(new URL(connection.url).searchParams.get("redirect_uri")).toBe(
      site.githubCallbackUrl,
    );
    w.github = {
      revision: 1,
      installationId: 13,
      account: "example",
      repositories: [],
    };
    const telegramConnection = await configured.users.begin(
      store.pool,
      w,
      "101",
      "999",
    );
    expect(new URL(telegramConnection).searchParams.get("redirect_uri")).toBe(
      site.githubCallbackUrl,
    );
    // No external write is performed merely by saving the address.
    expect(setWebhookCalls).toBe(0);
    const webhook = await request(
      "/api/setup/webhook",
      "POST",
      {},
      { origin: custom },
    );
    expect(webhook.status).toBe(200);
    expect(registeredUrl).toBe(site.telegramWebhookUrl);
    expect((await store.deployment()).webhookReady).toBe(true);
    const signIn = await request(
      "/api/admin/auth/login",
      "POST",
      { username: "siteoperator", password: "site test password" },
      { origin: custom, cookie: "" },
    );
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("set-cookie")).toContain("Secure");
  });
  test("removal restores recovery address and rejects the removed origin", async () => {
    expect(
      (await request(endpoint, "PUT", { revision: 1, domain: null })).status,
    ).toBe(200);
    expect((await (await request(endpoint)).json()).origin).toBe(fallback);
    expect(
      (
        await request(
          endpoint,
          "PUT",
          { revision: 2, domain: "admin.example.com" },
          { origin: custom },
        )
      ).status,
    ).toBe(403);
    expect((await store.deployment()).webhookReady).toBe(false);
  });
});
