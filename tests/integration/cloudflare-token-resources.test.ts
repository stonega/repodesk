import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import { CloudflareService } from "../../src/cloudflare/service.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { decrypt, hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Cloudflare direct token discovery", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `repodesk_cftoken_${randomUUID().replaceAll("-", "")}`;
  const key = "ab".repeat(32),
    apiToken = "cfat_fixture-token-for-cloudflare-12345",
    accountId = "a".repeat(32),
    zoneId = "b".repeat(32);
  let store: Store, admin: Admin, auth: { raw: string; csrf: string };
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    auth = await claim(store.pool, "cftoken", "cloudflare token password");
    admin = {
      id: (
        await store.pool.query("SELECT id FROM admins WHERE username='cftoken'")
      ).rows[0].id,
      username: "cftoken",
      operator: true,
    };
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function fixture() {
    const w = workspace();
    w.operatorId = admin.id;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, admin.id, JSON.stringify(w)],
    );
    const calls: string[] = [];
    const controls = {
      onRead: async () => {},
      fail: false,
      zoneAccount: accountId,
    };
    const service = new CloudflareService(store, key, async (url, init) => {
      calls.push(url);
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${apiToken}`,
      );
      expect(init.method).toBe("GET");
      await controls.onRead();
      if (controls.fail)
        return Response.json(
          { success: false, errors: [{ message: "private-provider-error" }] },
          { status: 403 },
        );
      const path = new URL(url).pathname;
      return Response.json({
        success: true,
        result: path.endsWith("/accounts")
          ? [{ id: accountId, name: "Token account", secret: "hidden" }]
          : path.endsWith("/zones")
            ? [
                {
                  id: zoneId,
                  name: "example.com",
                  account: { id: controls.zoneAccount },
                  private: "hidden",
                },
              ]
            : path.endsWith(`/accounts/${accountId}`)
              ? { id: accountId, name: "Token account" }
              : {
                  id: zoneId,
                  name: "example.com",
                  account: { id: controls.zoneAccount },
                },
        result_info: { total_count: 1 },
      });
    });
    const page = await service.view(admin, w.id);
    expect(page.settings.authMethod).toBe("api_token");
    await service.save(admin, w.id, {
      revision: 0,
      settings: page.settings,
      apiToken,
    });
    const endpoint = `/api/admin/workspaces/${w.id}/plugins/cloudflare`;
    const app = createApp(
      store,
      new SetupService(store, key, "http://localhost:3000"),
      "http://localhost:3000",
      new PluginService(store, undefined, undefined, undefined, service),
    );
    const request = (
      path: string,
      value: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(`http://localhost:3000${endpoint}${path}`, {
        method: "POST",
        headers: {
          cookie: `repodesk_session=${auth.raw}`,
          origin: "http://localhost:3000",
          "x-csrf-token": auth.csrf,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(value),
      });
    return { w, service, calls, controls, request };
  }
  test("tokens stay write-only and disabled until named selections are saved; discovered inventory grants no tool scope", async () => {
    const f = await fixture();
    const list = await f.request("/resources", {
      revision: 1,
      resource: "accounts",
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      items: [{ id: accountId, name: "Token account" }],
      page: 1,
      hasMore: false,
    });
    expect((await f.service.view(admin, f.w.id)).settings).toMatchObject({
      enabled: false,
      accountId: "",
      zoneIds: [],
    });
    const zones = await f.request("/resources", {
      revision: 1,
      resource: "zones",
      accountId,
    });
    expect(await zones.json()).toEqual({
      items: [{ id: zoneId, name: "example.com" }],
      page: 1,
      hasMore: false,
    });
    const page = await f.service.save(
      admin,
      f.w.id,
      {
        revision: 1,
        settings: {
          enabled: true,
          authMethod: "api_token",
          accountId,
          zoneIds: [zoneId],
        },
        verifyResources: true,
      },
      [],
      hash(auth.raw),
    );
    expect(page.resources).toEqual({
      account: { id: accountId, name: "Token account" },
      zones: [{ id: zoneId, name: "example.com" }],
    });
    expect(JSON.stringify(page)).not.toContain(apiToken);
    const saved = (await store.read(f.w.id)).plugins?.cloudflare;
    expect(saved?.credential).not.toBe(apiToken);
    expect(decrypt(key, `cloudflare:${f.w.id}`, saved?.credential ?? "")).toBe(
      apiToken,
    );
  });
  test("discovery requires operator, tenant, current revision, session, Origin and CSRF", async () => {
    const f = await fixture();
    await expect(
      f.service.resources(
        { ...admin, operator: false },
        f.w.id,
        hash(auth.raw),
        { revision: 1, resource: "accounts" },
      ),
    ).rejects.toThrow("operator_required");
    await expect(
      f.service.resources(
        { ...admin, id: randomUUID() },
        f.w.id,
        hash(auth.raw),
        { revision: 1, resource: "accounts" },
      ),
    ).rejects.toThrow("access_denied");
    const invalidHeaders: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "x-csrf-token": "wrong" },
    ];
    for (const headers of invalidHeaders)
      expect(
        (
          await f.request(
            "/resources",
            { revision: 1, resource: "accounts" },
            headers,
          )
        ).status,
      ).toBe(403);
    expect(
      (await f.request("/resources", { revision: 0, resource: "accounts" }))
        .status,
    ).toBe(409);
    expect(
      (
        await f.request("/resources", {
          revision: 1,
          resource: "accounts",
          page: 0,
        })
      ).status,
    ).toBe(400);
    await expect(
      f.service.resources(admin, f.w.id, "expired-session", {
        revision: 1,
        resource: "accounts",
      }),
    ).rejects.toThrow("access_denied");
    expect(f.calls).toHaveLength(0);
  });
  test("provider errors and cross-account domains preserve saved settings without leaking upstream details", async () => {
    const f = await fixture();
    f.controls.fail = true;
    const denied = await f.request("/resources", {
      revision: 1,
      resource: "accounts",
    });
    expect(await denied.json()).toEqual({ error: "cloudflare_access_denied" });
    f.controls.fail = false;
    f.controls.zoneAccount = "c".repeat(32);
    await expect(
      f.service.save(admin, f.w.id, {
        revision: 1,
        settings: {
          enabled: true,
          authMethod: "api_token",
          accountId,
          zoneIds: [zoneId],
        },
        verifyResources: true,
      }),
    ).rejects.toThrow("cloudflare_zone_denied");
    expect((await f.service.view(admin, f.w.id)).revision).toBe(1);
    expect((await f.service.view(admin, f.w.id)).settings.enabled).toBe(false);
  });
  test("in-flight token replacement, tenant deletion, role revocation and expired sessions invalidate inventory", async () => {
    for (const change of ["revision", "deletion", "role", "session"] as const) {
      const f = await fixture();
      const otherAuth = await claimSession();
      f.controls.onRead = async () => {
        if (change === "session")
          await store.pool.query("DELETE FROM sessions WHERE token_hash=$1", [
            hash(otherAuth),
          ]);
        else if (change === "role")
          await store.pool.query(
            "UPDATE admins SET operator=false WHERE id=$1",
            [admin.id],
          );
        else if (change === "revision")
          await f.service.save(admin, f.w.id, {
            revision: 1,
            settings: {
              enabled: false,
              authMethod: "api_token",
              accountId: "",
              zoneIds: [],
            },
            apiToken: "fixture-replaced-cloudflare-token",
          });
        else
          await store.change(f.w.id, (w) => {
            w.deletion = {
              requestedAt: new Date().toISOString(),
              providerState: "pending",
            };
          });
      };
      await expect(
        f.service.resources(admin, f.w.id, hash(otherAuth), {
          revision: 1,
          resource: "accounts",
        }),
      ).rejects.toThrow(
        change === "revision" ? "version_conflict" : "access_denied",
      );
      if (change === "role")
        await store.pool.query("UPDATE admins SET operator=true WHERE id=$1", [
          admin.id,
        ]);
    }
  });
  async function claimSession() {
    const raw = randomUUID();
    // Match the existing admin session layout without touching the shared session.
    await store.pool.query(
      "INSERT INTO sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [hash(raw), admin.id, randomUUID()],
    );
    return raw;
  }
  test("an explicit token replacement clears local OAuth credentials, pending consent and stale resource names", async () => {
    const f = await fixture();
    const state = `cf_${f.w.id}_${"x".repeat(43)}`;
    await store.change(f.w.id, (w) => {
      if (!w.plugins?.cloudflare) return;
      w.plugins.cloudflare.settings.authMethod = "oauth";
      w.plugins.cloudflare.oauth = {
        clientId: "old-client",
        clientSecret: "old-sealed-secret",
        scopes: ["account.read"],
        flow: {
          stateHash: hash(state),
          sessionHash: hash(auth.raw),
          adminId: admin.id,
          revision: 1,
          redirectUri: "http://localhost:3000/api/admin/cloudflare/callback",
          verifier: "old-encrypted-verifier",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
        connection: {
          id: randomUUID(),
          accessToken: "old-token",
          expiresAt: "2030-01-01T00:00:00Z",
        },
      };
    });
    const page = await f.service.save(admin, f.w.id, {
      revision: 1,
      settings: {
        enabled: false,
        authMethod: "api_token",
        accountId: "",
        zoneIds: [],
      },
      apiToken,
    });
    expect(page.settings.authMethod).toBe("api_token");
    expect(
      (await store.read(f.w.id)).plugins?.cloudflare?.oauth,
    ).toBeUndefined();
    await expect(
      f.service.oauth.callback(admin, hash(auth.raw), state, "late-code"),
    ).rejects.toThrow("cloudflare_authorization_expired");
    await f.service.save(admin, f.w.id, {
      revision: 2,
      settings: page.settings,
      removeToken: true,
    });
    await expect(
      f.service.resources(admin, f.w.id, hash(auth.raw), {
        revision: 3,
        resource: "accounts",
      }),
    ).rejects.toThrow("cloudflare_token_required");
  });
});
