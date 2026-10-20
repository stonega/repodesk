import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { extensionToolExecution } from "../../src/agent/extension-execution.ts";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { searchConsoleExtension } from "../../src/search-console/extension.ts";
import { SearchConsoleService } from "../../src/search-console/service.ts";
import { decrypt, hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { account, siteUrl } from "../search-console-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Google Search Console workspace integration",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `gsc_${randomUUID().replaceAll("-", "")}`;
    const key = "ab".repeat(32);
    let store: Store;
    let admin: Admin;
    let auth: { raw: string; csrf: string };
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url as string);
      parsed.pathname = `/${name}`;
      store = new Store(database(parsed.toString()));
      await migrate(store.pool);
      auth = await claim(
        store.pool,
        "searchoperator",
        "search console fixture password",
      );
      admin = {
        id: (
          await store.pool.query(
            "SELECT id FROM admins WHERE username='searchoperator'",
          )
        ).rows[0].id,
        username: "searchoperator",
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
    async function fixture(actor = "202", chatId = actor) {
      const w = workspace();
      w.operatorId = admin.id;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      const requests: { url: string; init: RequestInit }[] = [];
      const control: { onRead?: () => Promise<void>; denied?: boolean } = {};
      const service = new SearchConsoleService(
        store,
        key,
        async (url, init) => {
          requests.push({ url, init });
          if (url === "https://oauth2.googleapis.com/token")
            return Response.json({
              access_token: "ephemeral-token",
              token_type: "Bearer",
            });
          expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer ephemeral-token",
          );
          await control.onRead?.();
          if (control.denied)
            return Response.json(
              { error: "private upstream details" },
              { status: 403 },
            );
          if (url.endsWith("/sites"))
            return Response.json({
              siteEntry: [
                { siteUrl, permissionLevel: "siteOwner", secret: "excluded" },
                {
                  siteUrl: "sc-domain:unverified.test",
                  permissionLevel: "siteUnverifiedUser",
                },
              ],
            });
          if (url.endsWith("/searchAnalytics/query"))
            return Response.json({
              rows: [
                {
                  keys: ["example query"],
                  clicks: 10,
                  impressions: 100,
                  ctr: 0.1,
                  position: 3,
                  secret: "excluded",
                },
              ],
              secret: "excluded",
            });
          if (url.endsWith("/sitemaps"))
            return Response.json({
              sitemap: [
                {
                  path: "https://example.com/sitemap.xml",
                  errors: "0",
                  secret: "excluded",
                },
              ],
            });
          if (url.endsWith("index:inspect"))
            return Response.json({
              inspectionResult: {
                indexStatusResult: {
                  verdict: "PASS",
                  googleCanonical: "https://example.com/",
                  secret: "excluded",
                },
                secret: "excluded",
              },
            });
          return Response.json({
            siteUrl: decodeURIComponent(url.split("/sites/")[1] as string),
            permissionLevel: "siteOwner",
          });
        },
      );
      await service.save(admin, w.id, {
        revision: 0,
        settings: { enabled: false, siteUrls: [] },
        serviceAccount: JSON.stringify(account),
      });
      await service.save(admin, w.id, {
        revision: 1,
        settings: { enabled: true, siteUrls: [siteUrl] },
      });
      const run = await store.change(w.id, (current) =>
        createRun(
          current,
          actor,
          "Inspect search performance",
          chatId,
          0,
          "gpt-4.1-mini",
        ),
      );
      requests.length = 0;
      return { w, run, service, requests, control };
    }
    test("saves encrypted tenant-bound keys, redacts views, preserves other plugins and rejects stale/foreign operators", async () => {
      const f = await fixture();
      const saved = await store.read(f.w.id);
      const credential = saved.plugins?.searchConsole?.credential as string;
      expect(credential).not.toContain("PRIVATE KEY");
      expect(
        JSON.parse(decrypt(key, `search-console:${f.w.id}`, credential)),
      ).toEqual(account);
      expect(() =>
        decrypt(key, `search-console:${randomUUID()}`, credential),
      ).toThrow();
      expect(JSON.stringify(await f.service.view(admin, f.w.id))).not.toContain(
        "private_key",
      );
      await expect(
        f.service.view({ ...admin, id: randomUUID() }, f.w.id),
      ).rejects.toThrow("access_denied");
      await expect(
        f.service.view({ ...admin, operator: false }, f.w.id),
      ).rejects.toThrow("operator_required");
      await expect(
        f.service.save(admin, f.w.id, {
          revision: 0,
          settings: { enabled: false, siteUrls: [] },
        }),
      ).rejects.toThrow("version_conflict");
      await store.change(f.w.id, (w) => {
        if (w.plugins)
          w.plugins.codeTruth = { enabled: false, repositories: [] };
      });
      await f.service.save(admin, f.w.id, {
        revision: 2,
        settings: { enabled: false, siteUrls: [siteUrl] },
      });
      expect((await store.read(f.w.id)).plugins?.codeTruth).toEqual({
        enabled: false,
        repositories: [],
      });
      expect(f.requests).toHaveLength(0);
    });
    test("properties require a current operator session and discovery never selects unverified properties", async () => {
      const f = await fixture();
      expect(
        await f.service.properties(admin, f.w.id, hash(auth.raw), {
          revision: 2,
        }),
      ).toEqual({ items: [{ siteUrl, permissionLevel: "siteOwner" }] });
      await expect(
        f.service.properties(admin, f.w.id, "wrong", { revision: 2 }),
      ).rejects.toThrow("access_denied");
      f.control.onRead = async () => {
        await store.change(f.w.id, (w) => {
          if (w.plugins) w.plugins.revision++;
        });
      };
      await expect(
        f.service.properties(admin, f.w.id, hash(auth.raw), { revision: 2 }),
      ).rejects.toThrow("version_conflict");
    });
    test("members query selected properties with bounded read-only API requests and projected results", async () => {
      const f = await fixture();
      for (const resource of [
        "analytics",
        "sitemaps",
        "inspect_url",
      ] as const) {
        const result = await f.service.query(f.w.id, f.run.id, 2, {
          resource,
          siteUrl,
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          dimensions: ["query"],
          inspectionUrl: "https://example.com/",
        });
        expect(JSON.stringify(result)).not.toContain("excluded");
        expect(JSON.stringify(result)).not.toContain("ephemeral-token");
      }
      const analytics = f.requests.find((r) =>
        r.url.endsWith("/searchAnalytics/query"),
      );
      expect(analytics?.url).toContain(
        "sites/sc-domain%3Aexample.com/searchAnalytics/query",
      );
      expect(JSON.parse(String(analytics?.init.body))).toMatchObject({
        dataState: "final",
        rowLimit: 25,
        startRow: 0,
        type: "web",
      });
      expect(
        f.requests.every(
          (r) =>
            ["GET", "POST"].includes(r.init.method as string) &&
            r.init.redirect === "error",
        ),
      ).toBe(true);
      expect(
        (await store.read(f.w.id)).runs.find((r) => r.id === f.run.id)
          ?.searchConsoleRead,
      ).toEqual({ revision: 2 });
    });
    test("denies group, workflow, inactive member, cancelled run, foreign run and unselected property before provider access", async () => {
      const f = await fixture("202", "-100100");
      await expect(
        f.service.query(f.w.id, f.run.id, 2, { resource: "properties" }),
      ).rejects.toThrow("search_console_private_request_required");
      await store.change(f.w.id, (w) => {
        const run = w.runs[0];
        if (run) {
          run.chatId = run.actor;
          run.workflowId = "missing";
        }
      });
      await expect(
        f.service.query(f.w.id, f.run.id, 2, { resource: "properties" }),
      ).rejects.toThrow("run_revoked");
      await store.change(f.w.id, (w) => {
        const run = w.runs[0];
        if (run) delete run.workflowId;
        const member = w.members.find((m) => m.id === "202");
        if (member) member.active = false;
      });
      await expect(
        f.service.query(f.w.id, f.run.id, 2, { resource: "properties" }),
      ).rejects.toThrow("run_revoked");
      const fresh = await fixture();
      await expect(
        fresh.service.query(fresh.w.id, f.run.id, 2, {
          resource: "properties",
        }),
      ).rejects.toThrow("run_revoked");
      await expect(
        fresh.service.query(fresh.w.id, fresh.run.id, 2, {
          resource: "sitemaps",
          siteUrl: "sc-domain:other.test",
        }),
      ).rejects.toThrow("search_console_property_denied");
      await expect(
        fresh.service.query(fresh.w.id, fresh.run.id, 2, {
          resource: "inspect_url",
          siteUrl,
          inspectionUrl: "https://example.com.evil.test/",
        }),
      ).rejects.toThrow("search_console_property_denied");
      expect(f.requests).toHaveLength(0);
      expect(fresh.requests).toHaveLength(0);
      await store.change(fresh.w.id, (w) => {
        const run = w.runs.find((r) => r.id === fresh.run.id);
        if (run) run.cancelled = true;
      });
      await expect(
        fresh.service.query(fresh.w.id, fresh.run.id, 2, {
          resource: "properties",
        }),
      ).rejects.toThrow("run_revoked");
    });
    test("revocation during a Google response blocks data and pending delivery; provider failures preserve saved settings", async () => {
      const f = await fixture();
      await store.change(f.w.id, (w) => {
        w.deliveries.push({
          id: "search-console-result",
          actor: f.run.actor,
          chatId: f.run.actor,
          topicId: 0,
          runId: f.run.id,
          text: "private search data",
          state: "pending",
          at: new Date().toISOString(),
          attempts: 0,
        });
      });
      f.control.denied = true;
      await expect(
        f.service.query(f.w.id, f.run.id, 2, { resource: "sitemaps", siteUrl }),
      ).rejects.toThrow("search_console_access_denied");
      expect((await f.service.view(admin, f.w.id)).settings.enabled).toBe(true);
      f.control.denied = false;
      f.control.onRead = async () => {
        await f.service.save(admin, f.w.id, {
          revision: 2,
          settings: { enabled: false, siteUrls: [siteUrl] },
        });
      };
      await expect(
        f.service.query(f.w.id, f.run.id, 2, { resource: "sitemaps", siteUrl }),
      ).rejects.toThrow("run_revoked");
      const w = await store.read(f.w.id);
      expect(runAllowed(w, w.runs[0] as typeof f.run)).toBe(false);
      expect(
        w.deliveries.find((d) => d.id === "search-console-result")?.state,
      ).toBe("cancelled");
    });
    test("credential rotation disables tools and clears properties; removal clears the local key", async () => {
      const f = await fixture();
      const rotated = await f.service.save(admin, f.w.id, {
        revision: 2,
        settings: { enabled: true, siteUrls: [siteUrl] },
        serviceAccount: JSON.stringify(account),
      });
      expect(rotated.settings).toEqual({ enabled: false, siteUrls: [] });
      expect(
        (
          await f.service.save(admin, f.w.id, {
            revision: 3,
            settings: rotated.settings,
            removeCredential: true,
          })
        ).credentialConfigured,
      ).toBe(false);
      expect(
        (await store.read(f.w.id)).plugins?.searchConsole?.credential,
      ).toBeUndefined();
    });
    test("API enforces session, CSRF, origin and tenant ownership for configuration and discovery", async () => {
      const f = await fixture();
      const plugins = new PluginService(
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        f.service,
      );
      const origin = "http://localhost:3000";
      const app = createApp(
        store,
        new SetupService(store, key, origin),
        origin,
        plugins,
      );
      const endpoint = `/api/admin/workspaces/${f.w.id}/plugins/search-console`;
      const headers = {
        cookie: `deepx_session=${auth.raw}`,
        origin,
        "x-csrf-token": auth.csrf,
        "content-type": "application/json",
      };
      expect((await app.request(endpoint)).status).toBe(401);
      const response = await app.request(endpoint, { headers });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("private_key");
      for (const bad of [
        { "x-csrf-token": "wrong" },
        { origin: "http://wrong.example" },
      ])
        expect(
          (
            await app.request(`${endpoint}/properties`, {
              method: "POST",
              headers: { ...headers, ...bad },
              body: JSON.stringify({ revision: 2 }),
            })
          ).status,
        ).toBe(403);
      expect(
        (
          await app.request(`${endpoint}/properties`, {
            method: "POST",
            headers,
            body: JSON.stringify({ revision: 2 }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(endpoint, {
            method: "PUT",
            headers,
            body: JSON.stringify({
              revision: 2,
              settings: { enabled: false, siteUrls: [siteUrl] },
            }),
          })
        ).status,
      ).toBe(200);
    });
    test("Pi loads the scoped tool and replays duplicate calls without another provider request", async () => {
      const f = await fixture();
      await store.change(f.w.id, (w) => {
        const run = w.runs.find((r) => r.id === f.run.id);
        if (run) run.status = "running";
      });
      const input: AgentInput = {
        workspaceId: f.w.id,
        actor: f.run.actor,
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
        [searchConsoleExtension(f.service, f.w.id, 2)],
      ).open(input);
      try {
        expect(host?.tools.map((tool) => tool.name)).toEqual([
          "query_search_console",
        ]);
        const result = await host?.tools[0]?.execute(
          "call",
          { resource: "properties" },
          input.signal,
        );
        expect(JSON.stringify(result)).toContain(siteUrl);
        expect(f.requests).toHaveLength(0);
        const first = await host?.tools[0]?.execute(
          "sitemaps",
          { resource: "sitemaps", siteUrl },
          input.signal,
        );
        const replay = await host?.tools[0]?.execute(
          "sitemaps",
          { resource: "sitemaps", siteUrl },
          input.signal,
        );
        expect(replay).toEqual(first);
        expect(f.requests).toHaveLength(2);
        await f.service.save(admin, f.w.id, {
          revision: 2,
          settings: { enabled: false, siteUrls: [siteUrl] },
        });
        await expect(
          host?.tools[0]?.execute(
            "sitemaps",
            { resource: "sitemaps", siteUrl },
            input.signal,
          ),
        ).rejects.toThrow("tool_policy_denied");
      } finally {
        await host?.close();
      }
    });
  },
);
