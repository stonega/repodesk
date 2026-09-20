import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID, verify } from "node:crypto";
import { claim, issueClaim, login } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import { CodeTruthClient } from "../../src/code-truth/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { GitHubService } from "../../src/github/service.ts";
import { hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixture, githubPublicKey } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("GitHub App workspace connection", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `deepx_github_${randomUUID().replaceAll("-", "")}`;
  const origin = "http://localhost:3000",
    key = "ab".repeat(32);
  let store: Store,
    service: GitHubService,
    app: ReturnType<typeof createApp>,
    auth: { raw: string; csrf: string },
    admin: Admin,
    id: string,
    otherId: string;
  const provider = githubFixture();
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    const pool = database(parsed.toString());
    await migrate(pool);
    store = new Store(pool);
    auth = await claim(
      pool,
      await issueClaim(pool),
      "githubadmin",
      "test github password",
    );
    admin = {
      id: (
        await pool.query("SELECT id FROM admins WHERE username='githubadmin'")
      ).rows[0].id,
      username: "githubadmin",
      operator: true,
    };
    for (let n = 0; n < 2; n++) {
      const w = workspace();
      w.operatorId = admin.id;
      w.plugins = {
        revision: 1,
        entries: [],
        codeTruth: {
          enabled: true,
          repositories: [
            {
              id: "frontend",
              repositoryUrl: "https://github.com/example/workspace",
              networks: { devnet: "main" },
              workspaces: [w.id],
            },
          ],
        },
      };
      await pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      if (n === 0) id = w.id;
      else otherId = w.id;
    }
    service = new GitHubService(store, key, origin, provider);
    app = createApp(
      store,
      new SetupService(store, key, origin),
      origin,
      undefined,
      service,
    );
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
    credentials = auth,
    headers = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        cookie: `deepx_session=${credentials.raw}`,
        origin,
        "x-csrf-token": credentials.csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const base = () => `/api/admin/workspaces/${id}/github`;
  async function authorize() {
    const start = await request(`${base()}/connect`, "POST", {});
    expect(start.status).toBe(200);
    expect(start.headers.get("set-cookie")).toContain("SameSite=Lax");
    const target = new URL((await start.json()).url);
    expect(target.origin).toBe("https://github.com");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    const state = target.searchParams.get("state") ?? "";
    const callback = await request(
      `/api/admin/github/callback?state=${state}&code=fixture-code`,
    );
    expect(callback.headers.get("location")).toBe(
      `/admin/plugins?workspace=${id}&github=authorized`,
    );
    return state;
  }
  test("OAuth is session-bound, one-use and encrypted; forged installations and repositories are rejected", async () => {
    expect(
      (await request(base(), "GET", undefined, { raw: "", csrf: "" })).status,
    ).toBe(401);
    expect(
      (
        await request(`${base()}/connect`, "POST", {}, auth, {
          "x-csrf-token": "bad",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`${base()}/connect`, "POST", {}, auth, {
          origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    const start = await service.begin(admin, id, hash(auth.raw));
    const state = new URL(start.url).searchParams.get("state") ?? "";
    const second = await login(
      store.pool,
      "githubadmin",
      "test github password",
    );
    await expect(
      service.callbackResult(admin, hash(second.raw), state, "fixture-code"),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
    await service.callbackResult(admin, hash(auth.raw), state, "fixture-code");
    await expect(
      service.callbackResult(admin, hash(auth.raw), state, "fixture-code"),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
    const flow = (
      await store.pool.query("SELECT user_token,verifier FROM github_flows")
    ).rows[0];
    expect(flow.user_token).not.toContain("ghu_fixture_secret");
    expect(flow.verifier).toBe("");
    const page = await (await request(base())).json();
    expect(page.installations).toEqual([{ id: 501, account: "example" }]);
    expect(JSON.stringify(page)).not.toContain("secret");
    expect(
      (await request(`${base()}/installations/999/repositories`)).status,
    ).toBe(403);
    expect(
      (
        await request(base(), "PUT", {
          revision: 0,
          installationId: 501,
          repositoryIds: [9999],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/admin/workspaces/${otherId}/github`, "PUT", {
          revision: 0,
          installationId: 501,
          repositoryIds: [7001],
        })
      ).status,
    ).toBe(409);
    const saved = await request(base(), "PUT", {
      revision: 0,
      installationId: 501,
      repositoryIds: [7001],
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).connection.repositories).toEqual([
      { id: 7001, full_name: "example/workspace" },
    ]);
    expect((await store.read(otherId)).github).toBeUndefined();
    expect((await store.read(id)).plugins?.revision).toBe(2);
    expect(
      (await store.pool.query("SELECT count(*) FROM github_flows")).rows[0]
        .count,
    ).toBe("0");
    expect(JSON.stringify((await store.read(id)).audit)).not.toContain(
      "secret",
    );
  });
  test("expired state and cancelled authorization fail without a connection; disconnect is versioned", async () => {
    const start = await service.begin(admin, id, hash(auth.raw));
    await store.pool.query(
      "UPDATE github_flows SET expires_at=now()-interval '1 second'",
    );
    await expect(
      service.callbackResult(
        admin,
        hash(auth.raw),
        new URL(start.url).searchParams.get("state") ?? "",
        "fixture-code",
      ),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
    const next = await service.begin(admin, id, hash(auth.raw));
    await expect(
      service.callbackResult(
        admin,
        hash(auth.raw),
        new URL(next.url).searchParams.get("state") ?? "",
      ),
    ).rejects.toMatchObject({ code: "github_authorization_cancelled" });
    expect((await request(base(), "DELETE", { revision: 0 })).status).toBe(409);
    expect((await request(base(), "DELETE", { revision: 1 })).status).toBe(200);
    expect((await store.read(id)).github).toEqual({
      revision: 2,
      repositories: [],
    });
    expect((await store.read(id)).plugins?.revision).toBe(3);
    await authorize();
    expect(
      (
        await request(base(), "PUT", {
          revision: 2,
          installationId: 501,
          repositoryIds: [7001],
        })
      ).status,
    ).toBe(200);
  });
  test("installation tokens are read-only and limited to repositories; runtime never exposes credentials", async () => {
    let issued = 0;
    const signing = githubFixture((url, init) => {
      if (!url.endsWith("/access_tokens")) return;
      issued++;
      expect(JSON.parse(String(init.body))).toEqual({
        repository_ids: [7001],
        permissions: { contents: "read" },
      });
      const jwt =
        new Headers(init.headers).get("authorization")?.slice(7) ?? "";
      const [header, payload, signature] = jwt.split(".");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          githubPublicKey,
          Buffer.from(signature ?? "", "base64url"),
        ),
      ).toBe(true);
      const claims = JSON.parse(
        Buffer.from(payload ?? "", "base64url").toString(),
      );
      expect(claims.iss).toBe("Iv1.fixture");
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    });
    const calls: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        calls.push(await req.json());
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
        signing,
      );
      expect(
        JSON.stringify(await plugins.codeTruthStatus(admin, id)),
      ).not.toContain("secret");
      expect(issued).toBe(1);
      expect(calls[0]).toMatchObject({
        github: {
          token: "ghs_fixture_installation_secret",
          identity: "app:123:501:3",
        },
      });
      await request(base(), "DELETE", { revision: 3 });
      await plugins.codeTruthStatus(admin, id);
      expect(calls[1]).toMatchObject({
        github: { token: null, identity: "disconnected:4" },
      });
      expect(issued).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
  test("revoked workspace ownership cannot complete authorization", async () => {
    const start = await service.begin(admin, id, hash(auth.raw));
    await store.change(id, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "pending",
      };
    });
    await expect(
      service.callbackResult(
        admin,
        hash(auth.raw),
        new URL(start.url).searchParams.get("state") ?? "",
        "fixture-code",
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect((await request(base())).status).toBe(403);
  });
});
