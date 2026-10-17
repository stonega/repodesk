import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim, login } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import { cloudflareClientSecretAAD } from "../../src/cloudflare/oauth.ts";
import { CloudflareService } from "../../src/cloudflare/service.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { type Admin, requireThat } from "../../src/domain.ts";
import { decrypt, hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { decide } from "../../src/workflows/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Cloudflare browser OAuth and durable refresh",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `repodesk_cf_oauth_${randomUUID().replaceAll("-", "")}`;
    const key = "ab".repeat(32),
      accountId = "a".repeat(32),
      zoneId = "b".repeat(32);
    const clientId = "fixture-client",
      clientSecret = "fixture-secret-kept-on-server";
    const settings = {
      enabled: false,
      accountId,
      zoneIds: [zoneId],
      authMethod: "oauth" as const,
    };
    let store: Store, admin: Admin, auth: { raw: string; csrf: string };
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url ?? "");
      parsed.pathname = `/${name}`;
      store = new Store(database(parsed.toString()));
      await migrate(store.pool);
      auth = await claim(store.pool, "cfoauth", "cloudflare oauth password");
      admin = {
        id: (
          await store.pool.query(
            "SELECT id FROM admins WHERE username='cfoauth'",
          )
        ).rows[0].id,
        username: "cfoauth",
        operator: true,
      };
      await store.pool.query(
        "UPDATE deployment SET data=jsonb_set(data,'{active}','true')",
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function fixture() {
      const w = workspace();
      w.operatorId = admin.id;
      const run = createRun(
        w,
        "101",
        "Query Cloudflare",
        "101",
        0,
        "gpt-4.1-mini",
      );
      run.status = "running";
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      const calls: { url: string; init: RequestInit }[] = [];
      const controls = {
        hold: Promise.resolve(),
        failRefresh: false,
        failRevoke: false,
        account: accountId,
        refresh: true,
        onRefresh: async () => {},
      };
      let active = "fixture-oauth-access-initial";
      let refreshes = 0;
      const service = new CloudflareService(store, key, async (url, init) => {
        calls.push({ url, init });
        expect(init.redirect).toBe("error");
        if (url.startsWith("https://dash.cloudflare.com/oauth2/")) {
          expect(
            Buffer.from(
              new Headers(init.headers).get("authorization")?.slice(6) ?? "",
              "base64",
            ).toString(),
          ).toBe(`${clientId}:${clientSecret}`);
          const form = new URLSearchParams(String(init.body));
          if (url.endsWith("/revoke")) {
            if (controls.failRevoke) throw Error("private revoke failure");
            return new Response(null, { status: 200 });
          }
          if (form.get("grant_type") === "refresh_token") {
            refreshes++;
            await controls.onRefresh();
            await controls.hold;
            if (controls.failRefresh) throw Error("private refresh failure");
            active = `fixture-oauth-access-refreshed-${refreshes}`;
          }
          return Response.json({
            access_token: active,
            refresh_token: controls.refresh
              ? `fixture-refresh-${refreshes}`
              : undefined,
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        expect(new URL(url).origin).toBe("https://api.cloudflare.com");
        expect(new Headers(init.headers).get("authorization")).toBe(
          `Bearer ${active}`,
        );
        return Response.json({
          success: true,
          result: url.endsWith(`/accounts/${accountId}`)
            ? { id: controls.account, name: "Fixture" }
            : url.endsWith(`/zones/${zoneId}`)
              ? { id: zoneId, name: "example.com", account: { id: accountId } }
              : [],
          result_info: { page: 1 },
        });
      });
      await service.save(admin, w.id, {
        revision: 0,
        settings,
        oauthClient: { clientId, clientSecret, scopes: ["account.read"] },
      });
      const plugins = new PluginService(
        store,
        undefined,
        undefined,
        undefined,
        service,
      );
      const app = createApp(
        store,
        new SetupService(store, key, "http://localhost:3000"),
        "http://localhost:3000",
        plugins,
      );
      return {
        w,
        run,
        service,
        calls,
        controls,
        app,
        refreshes: () => refreshes,
      };
    }
    async function begin(f: Awaited<ReturnType<typeof fixture>>) {
      const result = await f.service.oauth.begin(
        admin,
        f.w.id,
        hash(auth.raw),
        1,
      );
      return new URL(result.url);
    }
    async function connected() {
      const f = await fixture();
      const started = await begin(f);
      await f.service.oauth.callback(
        admin,
        hash(auth.raw),
        started.searchParams.get("state") ?? "",
        "code",
      );
      return f;
    }
    async function expire(f: Awaited<ReturnType<typeof fixture>>) {
      await store.change(f.w.id, (w) => {
        const c = w.plugins?.cloudflare?.oauth?.connection;
        requireThat(c, "missing connection");
        c.expiresAt = new Date(0).toISOString();
      });
    }
    test("configuration is write-only, starts disabled and authorization uses state and S256 PKCE", async () => {
      const f = await fixture();
      const page = await f.service.view(admin, f.w.id);
      expect(page.oauth).toMatchObject({
        clientId,
        clientSecretConfigured: true,
        status: "not_connected",
      });
      expect(page.settings.enabled).toBe(false);
      expect(JSON.stringify(page)).not.toContain(clientSecret);
      const saved = (await store.read(f.w.id)).plugins?.cloudflare?.oauth;
      requireThat(saved, "missing client");
      expect(
        decrypt(
          key,
          cloudflareClientSecretAAD(f.w.id, clientId),
          saved.clientSecret,
        ),
      ).toBe(clientSecret);
      const started = await begin(f);
      expect(started.origin).toBe("https://dash.cloudflare.com");
      expect(started.pathname).toBe("/oauth2/auth");
      expect(started.searchParams.get("scope")).toBe(
        "account.read offline_access",
      );
      expect(started.searchParams.get("code_challenge_method")).toBe("S256");
      expect(started.searchParams.get("redirect_uri")).toBe(
        page.oauth.redirectUri,
      );
      expect(started.toString()).not.toContain(clientSecret);
      const flow = (await store.read(f.w.id)).plugins?.cloudflare?.oauth?.flow;
      requireThat(flow, "missing flow");
      expect(flow.stateHash).toBe(
        hash(started.searchParams.get("state") ?? ""),
      );
      const verifier = decrypt(
        key,
        `cloudflare:${f.w.id}:oauth:${flow.stateHash}`,
        flow.verifier,
      );
      expect(started.searchParams.get("code_challenge")).toBe(
        Buffer.from(hash(verifier), "hex").toString("base64url"),
      );
    });
    test("callback exchanges once, verifies the account, encrypts tokens and enables existing queries/actions", async () => {
      const f = await fixture();
      const started = await begin(f),
        state = started.searchParams.get("state") ?? "";
      await f.service.oauth.callback(admin, hash(auth.raw), state, "code");
      await expect(
        f.service.oauth.callback(admin, hash(auth.raw), state, "code"),
      ).rejects.toThrow("cloudflare_authorization_expired");
      expect(f.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
      const current = await store.read(f.w.id);
      expect(JSON.stringify(current)).not.toMatch(
        /fixture-oauth-access|fixture-refresh-/,
      );
      const page = await f.service.view(admin, f.w.id);
      expect(page.revision).toBe(2);
      expect(page.settings.enabled).toBe(true);
      expect(page.oauth?.status).toBe("connected");
      await f.service.query(f.w.id, f.run.id, 2, {
        resource: "pages_projects",
      });
      const proposal = await f.service.propose(
        f.w.id,
        f.run.id,
        "101",
        "action",
        2,
        { action: "purge_cache", zoneId, purgeEverything: true },
      );
      await store.change(f.w.id, (w) =>
        decide(w, "101", proposal.approvalId, true),
      );
      await f.service.send(f.w.id, proposal.approvalId);
      expect((await store.read(f.w.id)).approvals[0]?.cloudflare?.state).toBe(
        "completed",
      );
      expect(
        f.calls.filter((c) => c.url.endsWith("/purge_cache")),
      ).toHaveLength(1);
    });
    test("callback is bound to session, tenant, revision, expiry and current callback origin", async () => {
      for (const mode of [
        "session",
        "tenant",
        "revision",
        "expiry",
        "origin",
      ]) {
        const f = await fixture();
        const started = await begin(f);
        let state = started.searchParams.get("state") ?? "";
        if (mode === "tenant")
          state = state.replace(f.w.id, (await fixture()).w.id);
        if (mode === "revision" || mode === "expiry")
          await store.change(f.w.id, (w) => {
            requireThat(w.plugins?.cloudflare?.oauth?.flow, "missing flow");
            if (mode === "revision") w.plugins.revision++;
            else
              w.plugins.cloudflare.oauth.flow.expiresAt = new Date(
                0,
              ).toISOString();
          });
        if (mode === "origin")
          await store.pool.query(
            'UPDATE deployment SET data=jsonb_set(data,\'{site}\',\'{"domain":"other.example","revision":1}\')',
          );
        await expect(
          f.service.oauth.callback(
            admin,
            mode === "session" ? hash("wrong-session") : hash(auth.raw),
            state,
            "code",
          ),
        ).rejects.toThrow("cloudflare_authorization_expired");
        expect(f.calls).toHaveLength(0);
        await store.pool.query("UPDATE deployment SET data=data-'site'");
      }
    });
    test("cancelled consent and account mismatch do not create a connection or expose upstream secrets", async () => {
      const cancelled = await fixture();
      const started = await begin(cancelled);
      await expect(
        cancelled.service.oauth.callback(
          admin,
          hash(auth.raw),
          started.searchParams.get("state") ?? "",
        ),
      ).rejects.toThrow("cloudflare_authorization_cancelled");
      expect(cancelled.calls).toHaveLength(0);
      const f = await fixture();
      f.controls.account = "c".repeat(32);
      const url = await begin(f);
      await expect(
        f.service.oauth.callback(
          admin,
          hash(auth.raw),
          url.searchParams.get("state") ?? "",
          "code",
        ),
      ).rejects.toThrow("cloudflare_oauth_account_denied");
      expect((await f.service.view(admin, f.w.id)).oauth?.status).toBe(
        "not_connected",
      );
      expect(f.calls.filter((c) => c.url.endsWith("/revoke"))).toHaveLength(2);
    });
    test("logged-out sessions and concurrent callback replay cannot acquire credentials", async () => {
      const f = await fixture();
      const started = await begin(f);
      const state = started.searchParams.get("state") ?? "";
      const results = await Promise.allSettled([
        f.service.oauth.callback(admin, hash(auth.raw), state, "code"),
        f.service.oauth.callback(admin, hash(auth.raw), state, "code"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(f.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
      const fresh = await login(
        store.pool,
        "cfoauth",
        "cloudflare oauth password",
      );
      const g = await fixture();
      const u = new URL(
        (await g.service.oauth.begin(admin, g.w.id, hash(fresh.raw), 1)).url,
      );
      await store.pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        hash(fresh.raw),
      ]);
      await expect(
        g.service.oauth.callback(
          admin,
          hash(fresh.raw),
          u.searchParams.get("state") ?? "",
          "code",
        ),
      ).rejects.toThrow("cloudflare_authorization_expired");
      expect(g.calls).toHaveLength(0);
    });
    test("two workers rotate once and persist the new token without changing the plugin revision", async () => {
      const f = await connected();
      await expire(f);
      await Promise.all([
        f.service.query(f.w.id, f.run.id, 2, { resource: "pages_projects" }),
        f.service.query(f.w.id, f.run.id, 2, { resource: "pages_projects" }),
      ]);
      expect(f.refreshes()).toBe(1);
      const page = await f.service.view(admin, f.w.id);
      expect(page.revision).toBe(2);
      expect(page.oauth?.status).toBe("connected");
      const restarted = new CloudflareService(
        store,
        key,
        async (_url, init) => {
          expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer fixture-oauth-access-refreshed-1",
          );
          return Response.json({ success: true, result: [] });
        },
      );
      await restarted.query(f.w.id, f.run.id, 2, {
        resource: "pages_projects",
      });
    });
    test("refresh ambiguity and interrupted claims require reconnect and never reuse a refresh token", async () => {
      for (const interrupted of [false, true]) {
        const f = await connected();
        await expire(f);
        f.controls.failRefresh = true;
        if (interrupted)
          await store.change(f.w.id, (w) => {
            const c = w.plugins?.cloudflare?.oauth?.connection;
            requireThat(c, "missing connection");
            c.refresh = { id: "old-attempt", at: new Date(0).toISOString() };
          });
        await expect(
          f.service.query(f.w.id, f.run.id, 2, { resource: "pages_projects" }),
        ).rejects.toThrow();
        await expect(
          f.service.query(f.w.id, f.run.id, 2, { resource: "pages_projects" }),
        ).rejects.toThrow();
        expect(f.refreshes()).toBe(interrupted ? 0 : 1);
        expect((await f.service.view(admin, f.w.id)).oauth?.status).toBe(
          "reconnect_required",
        );
      }
    });
    test("disconnect invalidates access immediately, fences late refresh and attempts provider revocation", async () => {
      const f = await connected();
      await expire(f);
      let release = () => {};
      let started = () => {};
      const inFlight = new Promise<void>((resolve) => {
        started = resolve;
      });
      f.controls.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.controls.onRefresh = async () => {
        started();
      };
      const refresh = f.service.query(f.w.id, f.run.id, 2, {
        resource: "pages_projects",
      });
      const rejected = refresh.then(
        () => undefined,
        (error: unknown) => error,
      );
      await inFlight;
      expect(await f.service.oauth.disconnect(admin, f.w.id, 2)).toBe(true);
      release();
      expect(await rejected).toBeInstanceOf(Error);
      const page = await f.service.view(admin, f.w.id);
      expect(page.settings.enabled).toBe(false);
      expect(page.oauth?.status).toBe("not_connected");
      expect(
        (await store.read(f.w.id)).plugins?.cloudflare?.oauth?.connection,
      ).toBeUndefined();
      expect(
        f.calls.filter((c) => c.url.endsWith("/revoke")).length,
      ).toBeGreaterThanOrEqual(2);
    });
    test("a late response cannot revive a refresh claim beyond its recovery deadline", async () => {
      const f = await connected();
      await expire(f);
      f.controls.onRefresh = async () => {
        await store.change(f.w.id, (w) => {
          const c = w.plugins?.cloudflare?.oauth?.connection;
          requireThat(c?.refresh, "missing refresh claim");
          c.refresh.at = new Date(0).toISOString();
        });
      };
      await expect(
        f.service.query(f.w.id, f.run.id, 2, { resource: "pages_projects" }),
      ).rejects.toThrow();
      expect(f.refreshes()).toBe(1);
      expect((await f.service.view(admin, f.w.id)).oauth?.status).toBe(
        "reconnect_required",
      );
      await expect(
        f.service.query(f.w.id, f.run.id, 2, { resource: "pages_projects" }),
      ).rejects.toThrow();
      expect(f.refreshes()).toBe(1);
    });
    test("revocation failure still removes local authority and reports the uncertainty", async () => {
      const f = await connected();
      f.controls.failRevoke = true;
      expect(await f.service.oauth.disconnect(admin, f.w.id, 2)).toBe(false);
      expect((await f.service.view(admin, f.w.id)).oauth?.status).toBe(
        "not_connected",
      );
      expect(
        (await store.read(f.w.id)).plugins?.cloudflare?.oauth?.connection,
      ).toBeUndefined();
    });
    test("HTTP connect/disconnect require Origin and CSRF; callback redirects without leaking tokens", async () => {
      const f = await fixture();
      const path = `/api/admin/workspaces/${f.w.id}/plugins/cloudflare/oauth`;
      const headers = {
        cookie: `deepx_session=${auth.raw}`,
        origin: "http://localhost:3000",
        "x-csrf-token": auth.csrf,
        "content-type": "application/json",
      };
      expect(
        (
          await f.app.request(`${path}/connect`, {
            method: "POST",
            headers: { ...headers, "x-csrf-token": "bad" },
            body: JSON.stringify({ revision: 1 }),
          })
        ).status,
      ).toBe(403);
      const response = await f.app.request(`${path}/connect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: 1 }),
      });
      expect(response.status).toBe(200);
      const started = new URL(((await response.json()) as { url: string }).url);
      const callback = await f.app.request(
        `/api/admin/cloudflare/callback?state=${started.searchParams.get("state")}&code=code`,
        { headers },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(
        `/admin/plugins/cloudflare?workspace=${f.w.id}&cloudflare=connected`,
      );
      expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
      expect(callback.headers.get("cache-control")).toBe("no-store");
      expect(await callback.text()).not.toContain("fixture-oauth-access");
      const disconnected = await f.app.request(`${path}/disconnect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: 2 }),
      });
      expect(disconnected.status).toBe(200);
      expect(await disconnected.json()).toMatchObject({
        revocationConfirmed: true,
        settings: { enabled: false },
        oauth: { status: "not_connected" },
      });
    });
    test("consent cannot enable Cloudflare over a conflicting file plugin", async () => {
      const f = await fixture();
      await store.change(f.w.id, (w) => {
        requireThat(w.plugins, "missing plugins");
        w.plugins.entries = [
          {
            id: "conflict",
            version: "1",
            path: "plugins/conflict.ts",
            workspaces: [f.w.id],
            enabled: true,
            execution: "read-only",
            tools: ["query_cloudflare"],
          },
        ];
      });
      const url = await begin(f);
      await expect(
        f.service.oauth.callback(
          admin,
          hash(auth.raw),
          url.searchParams.get("state") ?? "",
          "code",
        ),
      ).rejects.toThrow("extension_tool_collision");
      const page = await f.service.view(admin, f.w.id);
      expect(page.settings.enabled).toBe(false);
      expect(page.oauth?.status).toBe("not_connected");
      expect(f.calls.filter((c) => c.url.endsWith("/revoke"))).toHaveLength(2);
    });
    test("client changes and authentication changes require disconnect while secret rotation preserves the grant", async () => {
      const f = await connected();
      await expect(
        f.service.save(admin, f.w.id, {
          revision: 2,
          settings: { ...settings, authMethod: "api_token" },
        }),
      ).rejects.toThrow("cloudflare_disconnect_before_client_change");
      await expect(
        f.service.save(admin, f.w.id, {
          revision: 2,
          settings,
          oauthClient: {
            clientId: "other",
            clientSecret,
            scopes: ["account.read"],
          },
        }),
      ).rejects.toThrow("cloudflare_disconnect_before_client_change");
      const before = (await store.read(f.w.id)).plugins?.cloudflare?.oauth
        ?.connection?.id;
      await f.service.save(admin, f.w.id, {
        revision: 2,
        settings: { ...settings, enabled: true },
        oauthClient: { clientId, clientSecret, scopes: ["account.read"] },
      });
      expect(
        (await store.read(f.w.id)).plugins?.cloudflare?.oauth?.connection?.id,
      ).toBe(before);
      await f.service.oauth.disconnect(admin, f.w.id, 3);
      await f.service.save(admin, f.w.id, {
        revision: 4,
        settings: { ...settings, authMethod: "api_token" },
        apiToken: "fixture-manual-token-12345",
      });
      expect((await f.service.view(admin, f.w.id)).tokenConfigured).toBe(true);
    });
    test("an operator role revoked during consent cannot exchange a code", async () => {
      const f = await fixture();
      const url = await begin(f);
      await store.pool.query("UPDATE admins SET operator=false WHERE id=$1", [
        admin.id,
      ]);
      try {
        await expect(
          f.service.oauth.callback(
            admin,
            hash(auth.raw),
            url.searchParams.get("state") ?? "",
            "code",
          ),
        ).rejects.toThrow("cloudflare_authorization_expired");
        expect(f.calls).toHaveLength(0);
      } finally {
        await store.pool.query("UPDATE admins SET operator=true WHERE id=$1", [
          admin.id,
        ]);
      }
    });
  },
);
