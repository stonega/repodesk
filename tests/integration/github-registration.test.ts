import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { claim, login } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import { CodeTruthClient } from "../../src/code-truth/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { GitHubService } from "../../src/github/service.ts";
import { ReviewService } from "../../src/review-bot/service.ts";
import { hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";
import {
  githubFixture,
  githubFixtureConfig,
  githubFixtureWebhookSecret,
  githubTransport,
} from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("GitHub App manifest registration", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `deepx_manifest_${randomUUID().replaceAll("-", "")}`;
  const key = "cd".repeat(32),
    origin = "http://localhost:3000";
  const input = {
    owner: "organization",
    organization: "example",
    name: "DeepX Test",
    public: false,
  };
  let store: Store,
    apps: GitHubApps,
    service: GitHubService,
    app: ReturnType<typeof createApp>;
  let admin: Admin,
    auth: { raw: string; csrf: string },
    id: string,
    sibling: string;
  let conversions = 0;
  let exchangeRedirect = "";
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    const pool = database(parsed.toString());
    await migrate(pool);
    store = new Store(pool);
    auth = await claim(
      pool,

      "manifestadmin",
      "manifest test password",
    );
    admin = {
      id: (
        await pool.query("SELECT id FROM admins WHERE username='manifestadmin'")
      ).rows[0].id,
      username: "manifestadmin",
      operator: true,
    };
    apps = new GitHubApps(
      store,
      key,
      undefined,
      githubTransport((u, init) => {
        if (u.includes("/conversions")) conversions++;
        if (u === "https://github.com/login/oauth/access_token")
          exchangeRedirect = JSON.parse(String(init.body)).redirect_uri;
      }),
    );
    service = new GitHubService(store, key, origin, apps);
    app = createApp(
      store,
      new SetupService(store, key, origin),
      origin,
      undefined,
      service,
    );
  });
  beforeEach(async () => {
    await store.pool.query("DELETE FROM github_apps");
    await store.pool.query("DELETE FROM github_app_flows");
    await store.pool.query("DELETE FROM auth_limits");
    conversions = 0;
    exchangeRedirect = "";
    for (let i = 0; i < 2; i++) {
      const w = workspace();
      w.operatorId = admin.id;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      if (i === 0) id = w.id;
      else sibling = w.id;
    }
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  const endpoint = () => `/api/admin/workspaces/${id}/github`;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        cookie: `deepx_session=${auth.raw}`,
        origin,
        "x-csrf-token": auth.csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const stateOf = (result: { url: string }) =>
    new URL(result.url).searchParams.get("state") ?? "";
  const start = () => service.register(admin, id, hash(auth.raw), input);

  test("builds safe personal/organization manifests and enforces owner, Origin and CSRF", async () => {
    expect((await service.view(admin, id, hash(auth.raw))).canRegister).toBe(
      true,
    );
    expect(
      (await request(`${endpoint()}/register`, "POST", input, { cookie: "" }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(`${endpoint()}/register`, "POST", input, {
          origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`${endpoint()}/register`, "POST", input, {
          "x-csrf-token": "bad",
        })
      ).status,
    ).toBe(403);
    await expect(
      service.register(
        { ...admin, operator: false },
        id,
        hash(auth.raw),
        input,
      ),
    ).rejects.toMatchObject({ code: "operator_required" });
    await expect(
      service.register(
        { ...admin, id: randomUUID() },
        id,
        hash(auth.raw),
        input,
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(
      (
        await request(`${endpoint()}/register`, "POST", {
          ...input,
          organization: "../evil",
        })
      ).status,
    ).toBe(400);
    const response = await request(`${endpoint()}/register`, "POST", input);
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("repodesk_session=");
    const result = await response.json();
    expect(new URL(result.url).pathname).toBe(
      "/organizations/example/settings/apps/new",
    );
    expect(result.manifest).toMatchObject({
      public: false,
      default_permissions: {
        contents: "write",
        metadata: "read",
        issues: "write",
        pull_requests: "write",
      },
      default_events: [
        "pull_request",
        "issue_comment",
        "pull_request_review_comment",
      ],
      hook_attributes: {
        url: "https://example.com/github/webhook",
        active: false,
      },
      callback_urls: [`${origin}/api/admin/github/callback`],
      redirect_url: `${origin}/api/admin/github/app/callback`,
    });
    expect(result.manifest.default_permissions).toEqual({
      contents: "write",
      metadata: "read",
      issues: "write",
      pull_requests: "write",
      members: "read",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    const personal = await service.register(admin, id, hash(auth.raw), {
      owner: "personal",
      name: "Personal App",
      public: true,
    });
    expect(new URL(personal.url).pathname).toBe("/settings/apps/new");
    expect(personal.manifest.public).toBe(true);
    expect(personal.manifest.default_permissions).toEqual(
      result.manifest.default_permissions,
    );
    expect(personal.manifest.hook_attributes).toEqual({
      url: "https://example.com/github/webhook",
      active: false,
    });
    expect(personal.manifest.callback_urls).toEqual([
      `${origin}/api/admin/github/callback`,
    ]);
    await expect(
      service.registrationResult(
        admin,
        hash(auth.raw),
        stateOf(result),
        "fixture-manifest-code",
      ),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
    expect(conversions).toBe(0);
  });
  test("new HTTPS Apps default to repodesk and the operator's active Review Bot webhook", async () => {
    const hostedOrigin = "https://repodesk.example";
    const hosted = new GitHubService(store, key, hostedOrigin, apps);
    const personal = await hosted.register(admin, id, hash(auth.raw), {
      owner: "personal",
      public: false,
      source: "setup",
    });
    expect(personal.manifest).toMatchObject({
      name: "repodesk",
      hook_attributes: {
        url: `${hostedOrigin}/github/webhook/${admin.id}`,
        active: true,
      },
      default_events: [
        "pull_request",
        "issue_comment",
        "pull_request_review_comment",
      ],
    });
    const organization = await hosted.register(admin, sibling, hash(auth.raw), {
      owner: "organization",
      organization: "example",
      public: false,
    });
    expect(organization.manifest.name).toBe("repodesk");
    expect(organization.manifest.hook_attributes).toEqual(
      personal.manifest.hook_attributes,
    );
    const custom = await hosted.register(admin, id, hash(auth.raw), input);
    expect(custom.manifest.name).toBe(input.name);
  });
  test("origins without a public HTTPS domain keep webhook delivery inactive", async () => {
    for (const localOrigin of [
      "http://repodesk.example",
      "https://localhost",
      "https://127.0.0.1",
      "https://repodesk.local",
    ]) {
      const local = new GitHubService(store, key, localOrigin, apps);
      const result = await local.register(admin, id, hash(auth.raw), input);
      expect(result.manifest.hook_attributes).toEqual({
        url: "https://example.com/github/webhook",
        active: false,
      });
      expect(result.manifest.default_events).toContain("issue_comment");
    }
  });
  test("manifest registration retains the generated secret for signed webhook intake after restart", async () => {
    await service.registrationResult(
      admin,
      hash(auth.raw),
      stateOf(await start()),
      "fixture-manifest-code",
    );
    const stored = (
      await store.pool.query(
        "SELECT credentials FROM github_apps WHERE operator_id=$1",
        [admin.id],
      )
    ).rows[0].credentials;
    expect(stored).not.toContain(githubFixtureWebhookSecret);
    expect(
      (await store.pool.query("SELECT count(*) FROM review_bot_hooks")).rows[0]
        .count,
    ).toBe("0");
    const restarted = new GitHubApps(store, key, undefined, githubTransport());
    const review = new ReviewService(store, restarted, key, origin);
    const view = await review.view(admin, id);
    expect(view.webhookConfigured).toBe(true);
    expect(view.settings.enabled).toBe(false);
    expect(JSON.stringify(view)).not.toContain(githubFixtureWebhookSecret);
    expect(await review.hookSecret(randomUUID())).toBeUndefined();
    const receiver = createApp(
      store,
      new SetupService(store, key, origin),
      origin,
      undefined,
      service,
      key,
      undefined,
      review,
    );
    const body = JSON.stringify({ zen: "Fixture webhook." });
    const send = (secret: string) =>
      receiver.request(`/github/webhook/${admin.id}`, {
        method: "POST",
        headers: {
          "x-github-event": "ping",
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      });
    expect((await send("incorrect-secret")).status).toBe(401);
    const accepted = await send(githubFixtureWebhookSecret);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });
    expect((await store.read(id)).reviewTasks).toBeUndefined();
  });
  test("callback is session-bound and one-use; credentials are encrypted and operator-scoped", async () => {
    const pending = await start(),
      state = stateOf(pending);
    const second = await login(
      store.pool,
      "manifestadmin",
      "manifest test password",
    );
    await expect(
      service.registrationResult(
        admin,
        hash(second.raw),
        state,
        "fixture-manifest-code",
      ),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
    const callback = await request(
      `/api/admin/github/app/callback?state=${state}&code=fixture-manifest-code`,
    );
    expect(callback.headers.get("location")).toBe(
      `/admin/plugins?workspace=${id}&github=app-created`,
    );
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    await expect(
      service.registrationResult(
        admin,
        hash(auth.raw),
        state,
        "fixture-manifest-code",
      ),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
    expect(conversions).toBe(1);
    const saved = (
      await store.pool.query("SELECT credentials FROM github_apps")
    ).rows[0].credentials;
    expect(saved).not.toContain(githubFixtureConfig.clientSecret);
    expect(saved).not.toContain("PRIVATE KEY");
    const publicPage = await service.view(admin, id, hash(auth.raw));
    expect(publicPage).toMatchObject({
      configured: true,
      canRegister: false,
      appSlug: "deepx-fixture",
    });
    expect(JSON.stringify(publicPage)).not.toContain("secret");
    expect(JSON.stringify((await store.read(id)).audit)).not.toContain(
      "secret",
    );
    expect(
      (await service.view(admin, sibling, hash(auth.raw))).configured,
    ).toBe(true);
    expect((await store.read(sibling)).github).toBeUndefined();
    expect(await apps.get(randomUUID())).toBeUndefined();
    const restarted = new GitHubApps(store, key, undefined, githubTransport());
    expect((await restarted.get(admin.id))?.config.id).toBe(123);
    await expect(start()).rejects.toMatchObject({
      code: "github_app_already_configured",
    });
    expect(
      (await store.pool.query("SELECT count(*) FROM github_app_flows")).rows[0]
        .count,
    ).toBe("0");
  });
  test("setup GitHub callbacks return to the wizard", async () => {
    const registration = await request(`${endpoint()}/register`, "POST", {
      ...input,
      source: "setup",
    });
    expect(registration.status).toBe(200);
    const result = await registration.json();
    expect(result.manifest.redirect_url).toBe(
      `${origin}/api/admin/github/app/callback`,
    );
    expect(stateOf(result).startsWith("setup_")).toBe(true);
    const created = await request(
      `/api/admin/github/app/callback?state=${stateOf(result)}&code=fixture-manifest-code`,
    );
    expect(created.headers.get("location")).toBe(
      `/setup?step=github&workspace=${id}&github=app-created`,
    );
    const authorization = await request(`${endpoint()}/connect`, "POST", {
      source: "setup",
    });
    expect(authorization.status).toBe(200);
    const oauth = await authorization.json();
    expect(new URL(oauth.url).searchParams.get("redirect_uri")).toBe(
      `${origin}/api/admin/github/callback`,
    );
    expect(stateOf(oauth).startsWith("setup_")).toBe(true);
    const authorized = await request(
      `/api/admin/github/callback?state=${stateOf(oauth)}&code=fixture-code`,
    );
    expect(authorized.headers.get("location")).toBe(
      `/setup?step=github&workspace=${id}&github=authorized`,
    );
    expect(exchangeRedirect).toBe(`${origin}/api/admin/github/callback`);
    expect((await service.view(admin, id, hash(auth.raw))).pending).toBe(true);
  });
  test("expired, cancelled, logged-out and deleted-workspace callbacks never exchange credentials", async () => {
    let state = stateOf(await start());
    await store.pool.query(
      "UPDATE github_app_flows SET expires_at=now()-interval '1 second'",
    );
    await expect(
      service.registrationResult(
        admin,
        hash(auth.raw),
        state,
        "fixture-manifest-code",
      ),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
    state = stateOf(await start());
    await expect(
      service.registrationResult(admin, hash(auth.raw), state),
    ).rejects.toMatchObject({ code: "github_registration_cancelled" });
    const second = await login(
      store.pool,
      "manifestadmin",
      "manifest test password",
    );
    state = stateOf(await service.register(admin, id, hash(second.raw), input));
    await store.pool.query("DELETE FROM sessions WHERE token_hash=$1", [
      hash(second.raw),
    ]);
    await expect(
      service.registrationResult(
        admin,
        hash(second.raw),
        state,
        "fixture-manifest-code",
      ),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
    state = stateOf(await start());
    await store.change(id, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "pending",
      };
    });
    await expect(
      service.registrationResult(
        admin,
        hash(auth.raw),
        state,
        "fixture-manifest-code",
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(conversions).toBe(0);
    expect(await apps.get(admin.id)).toBeUndefined();
  });
  test("conversion failures are redacted and concurrent registrations cannot overwrite an App", async () => {
    const bad = await start();
    const result = await request(
      `/api/admin/github/app/callback?state=${stateOf(bad)}&code=invalid-code`,
    );
    expect(result.headers.get("location")).toBe(
      "/admin/plugins?github=registration-failed",
    );
    expect(await apps.get(admin.id)).toBeUndefined();
    const second = await login(
      store.pool,
      "manifestadmin",
      "manifest test password",
    );
    const a = await start(),
      b = await service.register(admin, sibling, hash(second.raw), input);
    const completed = await Promise.allSettled([
      service.registrationResult(
        admin,
        hash(auth.raw),
        stateOf(a),
        "fixture-manifest-code",
      ),
      service.registrationResult(
        admin,
        hash(second.raw),
        stateOf(b),
        "fixture-manifest-code",
      ),
    ]);
    expect(completed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await store.pool.query("SELECT count(*) FROM github_apps")).rows[0]
        .count,
    ).toBe("1");
    const fallback = new GitHubService(store, key, origin, githubFixture());
    expect((await fallback.view(admin, id, hash(auth.raw))).canRegister).toBe(
      false,
    );
  });
  test("invalid permission/owner/key/webhook-secret responses are rejected without persisting secrets", async () => {
    const upstream = githubTransport();
    const permissions = {
      contents: "write",
      metadata: "read",
      issues: "write",
      pull_requests: "write",
      members: "read",
    };
    for (const override of [
      { permissions: { contents: "write" } },
      { permissions: { contents: "read", metadata: "read", issues: "write" } },
      { permissions: { ...permissions, contents: "read" } },
      { permissions: { ...permissions, pull_requests: "read" } },
      { permissions: { ...permissions, metadata: "write" } },
      { permissions: { ...permissions, actions: "write" } },
      { permissions: { ...permissions, workflows: "write" } },
      { permissions: { ...permissions, members: "write" } },
      { owner: { login: "wrong-org" } },
      { pem: "not-a-private-key" },
      { webhook_secret: undefined },
      { webhook_secret: null },
      { webhook_secret: "" },
    ]) {
      const registry = new GitHubApps(store, key, undefined, (async (
        url,
        init,
      ) => {
        const res = await upstream(url, init);
        return Response.json({ ...(await res.json()), ...override });
      }) as typeof fetch);
      await expect(
        registry.convert("fixture-manifest-code", "example"),
      ).rejects.toMatchObject({ code: "github_registration_failed" });
    }
    expect(await apps.get(admin.id)).toBeUndefined();
  });
  test("registered credentials power subsequent OAuth and worker Code Truth without restart", async () => {
    await service.registrationResult(
      admin,
      hash(auth.raw),
      stateOf(await start()),
      "fixture-manifest-code",
    );
    const authStart = await service.begin(admin, id, hash(auth.raw));
    await service.callbackResult(
      admin,
      hash(auth.raw),
      stateOf(authStart),
      "fixture-code",
    );
    await service.connect(admin, id, hash(auth.raw), {
      revision: 0,
      installationId: 501,
      repositoryIds: [7001],
    });
    await store.change(id, (w) => {
      w.plugins = {
        revision: 1,
        entries: [],
        codeTruth: {
          enabled: true,
          repositories: [
            {
              id: "web",
              repositoryUrl: "https://github.com/example/workspace",
              networks: { devnet: "main" },
              workspaces: [id],
            },
          ],
        },
      };
    });
    let tokenReceived = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        tokenReceived = (await req.json()).github.token;
        return Response.json({
          namespace: "a".repeat(64),
          syncing: false,
          targets: [],
        });
      },
    });
    try {
      const plugins = new PluginService(
        store,
        undefined,
        new CodeTruthClient(
          `http://127.0.0.1:${server.port}`,
          "service-secret",
        ),
        new GitHubApps(store, key, undefined, githubTransport()),
      );
      await plugins.codeTruthStatus(admin, id);
      expect(tokenReceived).toBe("ghs_fixture_installation_secret");
      expect((await store.read(sibling)).github).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
