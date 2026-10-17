import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claim } from "../../src/admin/auth.ts";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import type { CloudflareTransport } from "../../src/cloudflare/client.ts";
import { cloudflareExtension } from "../../src/cloudflare/extension.ts";
import { CloudflareService } from "../../src/cloudflare/service.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { type Admin, requireThat } from "../../src/domain.ts";
import { sweep } from "../../src/privacy/service.ts";
import { decrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { decide } from "../../src/workflows/service.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Cloudflare scoped plugin and approved writes",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `repodesk_cf_${randomUUID().replaceAll("-", "")}`;
    const key = "ab".repeat(32);
    const apiToken = "fixture-cloudflare-token-12345";
    const accountId = "a".repeat(32);
    const zoneId = "b".repeat(32);
    const recordId = "c".repeat(32);
    const settings = { enabled: true, accountId, zoneIds: [zoneId] };
    const record = {
      id: recordId,
      type: "A",
      name: "www.example.com",
      content: "192.0.2.1",
      ttl: 1,
      proxied: false,
    };
    const action = {
      action: "create_dns_record",
      zoneId,
      record: {
        type: "A",
        name: "www.example.com",
        content: "192.0.2.2",
        ttl: 1,
        proxied: false,
      },
    };
    let store: Store;
    let admin: Admin;
    let auth: { raw: string; csrf: string };
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url ?? "");
      parsed.pathname = `/${name}`;
      store = new Store(database(parsed.toString()));
      await migrate(store.pool);
      auth = await claim(
        store.pool,
        "cloudflareoperator",
        "cloudflare test password",
      );
      admin = {
        id: (
          await store.pool.query(
            "SELECT id FROM admins WHERE username='cloudflareoperator'",
          )
        ).rows[0].id,
        username: "cloudflareoperator",
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
    function provider() {
      const requests: { url: string; init: RequestInit }[] = [];
      let onRead: (() => Promise<void>) | undefined;
      let onWrite: (() => Promise<Response>) | undefined;
      let zoneAccount = accountId;
      let currentRecord = { ...record };
      const transport: CloudflareTransport = async (url, init) => {
        requests.push({ url, init });
        expect(new URL(url).origin).toBe("https://api.cloudflare.com");
        expect(new Headers(init.headers).get("authorization")).toBe(
          `Bearer ${apiToken}`,
        );
        expect(init.redirect).toBe("error");
        if (init.method !== "GET")
          return onWrite
            ? onWrite()
            : Response.json({ success: true, result: { id: recordId } });
        await onRead?.();
        return Response.json({
          success: true,
          result: url.endsWith(`/zones/${zoneId}`)
            ? {
                id: zoneId,
                name: "example.com",
                account: { id: zoneAccount },
                status: "active",
              }
            : url.includes(`/dns_records/${recordId}`)
              ? currentRecord
              : url.includes("dns_records")
                ? [currentRecord]
                : [
                    {
                      id: "deployment",
                      name: "site",
                      env_vars: { SECRET: { value: "private-value" } },
                      deployment_configs: {
                        production: { env_vars: { secret: "private" } },
                      },
                      latest_deployment: {
                        id: "latest",
                        env_vars: { TOKEN: "secret" },
                        latest_stage: {
                          name: "deploy",
                          status: "success",
                          unexpected: "secret",
                        },
                      },
                    },
                  ],
          result_info: { page: 1, per_page: 20, total_pages: 2 },
        });
      };
      return {
        service: new CloudflareService(store, key, transport),
        requests,
        read: (f?: () => Promise<void>) => {
          onRead = f;
        },
        write: (f: () => Promise<Response>) => {
          onWrite = f;
        },
        account: (id: string) => {
          zoneAccount = id;
        },
        record: (next: typeof record) => {
          currentRecord = next;
        },
      };
    }
    async function fixture(actor = "101", chatId = actor) {
      const w = workspace();
      w.operatorId = admin.id;
      const run = createRun(
        w,
        actor,
        "Inspect Cloudflare",
        chatId,
        0,
        "gpt-4.1-mini",
      );
      run.status = "running";
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      const p = provider();
      await p.service.save(admin, w.id, { revision: 0, settings, apiToken });
      return { ...p, w, run };
    }
    const proposal = async (
      f: Awaited<ReturnType<typeof fixture>>,
      input: unknown = action,
    ) => f.service.propose(f.w.id, f.run.id, f.run.actor, "call1", 1, input);

    test("operator-only tenant settings encrypt, preserve, replace and remove write-only credentials", async () => {
      const f = await fixture();
      const page = await f.service.view(admin, f.w.id);
      expect(page.tokenConfigured).toBe(true);
      expect(JSON.stringify(page)).not.toContain(apiToken);
      const encrypted =
        (await store.read(f.w.id)).plugins?.cloudflare?.credential ?? "";
      expect(encrypted).not.toContain(apiToken);
      expect(decrypt(key, `cloudflare:${f.w.id}`, encrypted)).toBe(apiToken);
      expect(() =>
        decrypt(key, `cloudflare:${randomUUID()}`, encrypted),
      ).toThrow();
      await expect(
        f.service.view({ ...admin, operator: false }, f.w.id),
      ).rejects.toThrow("operator_required");
      await expect(
        f.service.view({ ...admin, id: randomUUID() }, f.w.id),
      ).rejects.toThrow("access_denied");
      await expect(
        f.service.save(admin, f.w.id, { revision: 0, settings }),
      ).rejects.toThrow("version_conflict");
      await f.service.save(admin, f.w.id, { revision: 1, settings });
      expect((await store.read(f.w.id)).plugins?.cloudflare?.credential).toBe(
        encrypted,
      );
      await f.service.save(admin, f.w.id, {
        revision: 2,
        settings,
        apiToken: `${apiToken}-new`,
      });
      expect(
        (await store.read(f.w.id)).plugins?.cloudflare?.credential,
      ).not.toBe(encrypted);
      await f.service.save(admin, f.w.id, {
        revision: 3,
        settings: { ...settings, enabled: false },
        removeToken: true,
      });
      expect((await f.service.view(admin, f.w.id)).tokenConfigured).toBe(false);
      await expect(
        f.service.save(admin, f.w.id, { revision: 4, settings }),
      ).rejects.toThrow("cloudflare_token_and_account_required");
    });
    test("API routes enforce operator, tenant, Origin and CSRF; token never appears in responses", async () => {
      const f = await fixture();
      const plugins = new PluginService(
        store,
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
      const endpoint = `/api/admin/workspaces/${f.w.id}/plugins/cloudflare`;
      const headers = {
        cookie: `deepx_session=${auth.raw}`,
        origin: "http://localhost:3000",
        "x-csrf-token": auth.csrf,
        "content-type": "application/json",
      };
      expect((await app.request(endpoint)).status).toBe(401);
      const get = await app.request(endpoint, { headers });
      expect(get.status).toBe(200);
      expect(await get.text()).not.toContain(apiToken);
      const body = JSON.stringify({ revision: 1, settings });
      expect(
        (
          await app.request(endpoint, {
            method: "PUT",
            headers: { ...headers, "x-csrf-token": "wrong" },
            body,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(endpoint, {
            method: "PUT",
            headers: { ...headers, origin: "http://elsewhere" },
            body,
          })
        ).status,
      ).toBe(403);
      expect(
        (await app.request(endpoint, { method: "PUT", headers, body })).status,
      ).toBe(200);
    });
    test("Pi factory registers the catalog tools and companion instructions; proposal is local and deduplicated", async () => {
      const f = await fixture();
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
      const host = await ExtensionCatalog.fromSnapshot(
        [],
        [cloudflareExtension(f.service, f.w.id, 1)],
      ).open(input);
      try {
        expect(host?.tools.map((t) => t.name)).toEqual([
          "query_cloudflare",
          "propose_cloudflare_action",
        ]);
        const tool = host?.tools.find(
          (t) => t.name === "propose_cloudflare_action",
        );
        requireThat(tool, "missing fixture tool");
        await tool.execute("call1", action, input.signal);
        await tool.execute("call1", action, input.signal);
        const current = await store.read(f.w.id);
        expect(current.approvals).toHaveLength(1);
        expect(current.deliveries).toHaveLength(1);
        expect(current.deliveries[0]?.text).toContain("192.0.2.2");
        expect(current.deliveries[0]?.buttons?.[0]).toHaveLength(2);
        expect(f.requests.every((r) => r.init.method === "GET")).toBe(true);
      } finally {
        await host?.close();
      }
    });
    test("members query one page, Pages output excludes secrets, and selected zones are explicit", async () => {
      const f = await fixture("202");
      const zones = await f.service.query(f.w.id, f.run.id, 1, {
        resource: "zones",
      });
      expect(zones.result).toEqual([
        { id: zoneId, name: "example.com", status: "active" },
      ]);
      const dns = await f.service.query(f.w.id, f.run.id, 1, {
        resource: "dns_records",
        zoneId,
        page: 2,
      });
      expect(dns.result).toEqual([record]);
      expect(f.requests.at(-1)?.url).toContain("page=2&per_page=20");
      for (const resource of ["pages_projects", "pages_deployments"]) {
        const result = await f.service.query(f.w.id, f.run.id, 1, {
          resource,
          ...(resource === "pages_deployments" ? { projectName: "site" } : {}),
        });
        expect(JSON.stringify(result)).not.toMatch(
          /env_vars|deployment_configs|private-value|TOKEN|unexpected/,
        );
      }
      await expect(proposal(f)).rejects.toThrow("access_denied");
    });
    test("queries and proposals reject foreign zones, wrong accounts, group destinations, workflows and inactive actors", async () => {
      const f = await fixture();
      await expect(
        f.service.query(f.w.id, f.run.id, 1, {
          resource: "dns_records",
          zoneId: "d".repeat(32),
        }),
      ).rejects.toThrow("cloudflare_zone_denied");
      expect(f.requests).toHaveLength(0);
      await expect(
        proposal(f, {
          ...action,
          record: { ...action.record, name: "elsewhere.com" },
        }),
      ).rejects.toThrow("cloudflare_zone_denied");
      f.account("e".repeat(32));
      await expect(proposal(f)).rejects.toThrow("cloudflare_zone_denied");
      const group = await fixture("101", "-100100");
      await expect(
        group.service.query(group.w.id, group.run.id, 1, { resource: "zones" }),
      ).rejects.toThrow("cloudflare_private_request_required");
      expect(group.requests).toHaveLength(0);
      await store.change(f.w.id, (w) => {
        const run = w.runs[0];
        if (run) run.workflowId = "unapproved";
      });
      await expect(proposal(f)).rejects.toThrow();
      const inactive = await fixture();
      await store.change(inactive.w.id, (w) => {
        const m = w.members[0];
        if (m) m.active = false;
      });
      await expect(proposal(inactive)).rejects.toThrow("run_revoked");
    });
    test("revocation during a network read blocks the result and old evidence cannot be delivered", async () => {
      const f = await fixture();
      f.read(async () => {
        f.read();
        await store.change(f.w.id, (w) => {
          if (w.plugins) w.plugins.revision++;
        });
      });
      await expect(
        f.service.query(f.w.id, f.run.id, 1, { resource: "pages_projects" }),
      ).rejects.toThrow();
      const w = await store.read(f.w.id);
      expect(runAllowed(w, w.runs[0] ?? f.run)).toBe(false);
    });
    test("exact actor approval is required; changed payloads, expired decisions and revoked scopes fail", async () => {
      const f = await fixture();
      const a = await proposal(f);
      await f.service.send(f.w.id, a.approvalId);
      expect(f.requests.filter((r) => r.init.method !== "GET")).toHaveLength(0);
      await expect(
        store.change(f.w.id, (w) => decide(w, "303", a.approvalId, true)),
      ).rejects.toThrow("approval_denied");
      await expect(
        store.change(f.w.id, (w) => {
          requireThat(w.approvals[0], "missing approval");
          w.approvals[0].payload = {};
          decide(w, "101", a.approvalId, true);
        }),
      ).rejects.toThrow("approval_changed");
      await expect(
        store.change(f.w.id, (w) => {
          requireThat(w.approvals[0], "missing approval");
          w.approvals[0].expiresAt = new Date(0).toISOString();
          decide(w, "101", a.approvalId, true);
        }),
      ).rejects.toThrow("approval_expired");
      await store.change(f.w.id, (w) => {
        if (w.plugins) w.plugins.revision++;
      });
      await expect(
        store.change(f.w.id, (w) => decide(w, "101", a.approvalId, true)),
      ).rejects.toThrow();
    });
    test("concurrent workers execute an approved action once and reject replay", async () => {
      const f = await fixture();
      const a = await proposal(f);
      await store.change(f.w.id, (w) => decide(w, "101", a.approvalId, true));
      await Promise.all([
        f.service.send(f.w.id, a.approvalId),
        f.service.send(f.w.id, a.approvalId),
      ]);
      await f.service.send(f.w.id, a.approvalId);
      const writes = f.requests.filter((r) => r.init.method !== "GET");
      expect(writes).toHaveLength(1);
      expect(JSON.parse(String(writes[0]?.init.body))).toEqual(action.record);
      const current = await store.read(f.w.id);
      expect(current.approvals[0]?.cloudflare?.state).toBe("completed");
      expect(current.deliveries.at(-1)?.text).toContain("completed");
    });
    test("update/delete previews pin current DNS contents and reject changed targets before writing", async () => {
      for (const verb of ["update_dns_record", "delete_dns_record"]) {
        const f = await fixture();
        const input = {
          action: verb,
          zoneId,
          recordId,
          ...(verb === "update_dns_record" ? { record: action.record } : {}),
        };
        const a = await proposal(f, input);
        expect((await store.read(f.w.id)).deliveries[0]?.text).toContain(
          "192.0.2.1",
        );
        await store.change(f.w.id, (w) => decide(w, "101", a.approvalId, true));
        f.record({ ...record, content: "192.0.2.100" });
        await f.service.send(f.w.id, a.approvalId);
        expect(f.requests.filter((r) => r.init.method !== "GET")).toHaveLength(
          0,
        );
        expect((await store.read(f.w.id)).approvals[0]?.cloudflare?.error).toBe(
          "cloudflare_record_changed",
        );
      }
    });
    test("cache purges stay within the zone and require an exact reviewed scope", async () => {
      const f = await fixture();
      await expect(
        proposal(f, {
          action: "purge_cache",
          zoneId,
          files: ["https://elsewhere.com/a"],
        }),
      ).rejects.toThrow("cloudflare_zone_denied");
      const a = await proposal(f, {
        action: "purge_cache",
        zoneId,
        files: ["https://www.example.com/a"],
      });
      await store.change(f.w.id, (w) => decide(w, "101", a.approvalId, true));
      await f.service.send(f.w.id, a.approvalId);
      const write = f.requests.find((r) => r.init.method === "POST");
      expect(write?.url).toEndWith("/purge_cache");
      expect(JSON.parse(String(write?.init.body))).toEqual({
        files: ["https://www.example.com/a"],
      });
    });
    test("ambiguous requests and interrupted reservations become unknown without retry", async () => {
      const f = await fixture();
      const a = await proposal(f);
      await store.change(f.w.id, (w) => decide(w, "101", a.approvalId, true));
      f.write(async () => {
        throw new Error("secret upstream failure");
      });
      await f.service.send(f.w.id, a.approvalId);
      await f.service.send(f.w.id, a.approvalId);
      expect(f.requests.filter((r) => r.init.method !== "GET")).toHaveLength(1);
      expect((await store.read(f.w.id)).approvals[0]?.cloudflare?.state).toBe(
        "unknown",
      );
      const interrupted = await fixture();
      const b = await proposal(interrupted);
      await store.change(interrupted.w.id, (w) => {
        decide(w, "101", b.approvalId, true);
        requireThat(w.approvals[0], "missing approval");
        w.approvals[0].cloudflare = {
          state: "sending",
          startedAt: new Date(0).toISOString(),
        };
      });
      interrupted.requests.length = 0;
      await interrupted.service.send(interrupted.w.id, b.approvalId);
      expect(interrupted.requests).toHaveLength(0);
      expect(
        (await store.read(interrupted.w.id)).approvals[0]?.cloudflare?.state,
      ).toBe("unknown");
    });
    test("role revocation, deployment pause and credential deletion stop approved writes", async () => {
      for (const mode of ["role", "pause", "credential"]) {
        const f = await fixture();
        const a = await proposal(f);
        await store.change(f.w.id, (w) => decide(w, "101", a.approvalId, true));
        if (mode === "pause")
          await store.pool.query(
            "UPDATE deployment SET data=jsonb_set(data,'{paused}','true')",
          );
        else
          await store.change(f.w.id, (w) => {
            requireThat(w.members[0], "missing member");
            if (mode === "role") w.members[0].role = "member";
            else if (w.plugins?.cloudflare)
              delete w.plugins.cloudflare.credential;
          });
        await f.service.send(f.w.id, a.approvalId);
        expect(f.requests.filter((r) => r.init.method !== "GET")).toHaveLength(
          0,
        );
        expect((await store.read(f.w.id)).approvals[0]?.cloudflare?.state).toBe(
          "failed",
        );
        await store.pool.query(
          "UPDATE deployment SET data=jsonb_set(data,'{paused}','false')",
        );
      }
    });
    test("plugin tool collisions are rejected and workspace deletion purges credentials", async () => {
      const f = await fixture();
      await store.change(f.w.id, (w) => {
        if (w.plugins)
          w.plugins.entries = [
            {
              id: "collision",
              enabled: true,
              tools: ["query_cloudflare"],
              workspaces: [w.id],
              path: "/missing.ts",
              execution: "read-only",
              version: "1",
            },
          ];
      });
      await expect(
        f.service.save(admin, f.w.id, { revision: 1, settings }),
      ).rejects.toThrow("extension_tool_collision");
      await store.change(f.w.id, (w) => {
        w.deletion = {
          requestedAt: new Date().toISOString(),
          providerState: "fixture",
        };
        sweep(w);
      });
      expect((await store.read(f.w.id)).plugins).toBeUndefined();
    });
    test("saving Cloudflare preserves manifest plugins, other built-ins and sibling workspace scope", async () => {
      const f = await fixture();
      const sibling = await fixture();
      await store.change(f.w.id, (w) => {
        delete w.plugins;
      });
      const dir = await mkdtemp(join(tmpdir(), "repodesk-cf-manifest-"));
      try {
        const path = join(dir, "plugins.json");
        await writeFile(
          path,
          JSON.stringify([
            {
              id: "word-count",
              version: "1",
              path: resolve("examples/pi-extension.ts"),
              tools: ["count_words"],
              execution: "read-only",
              enabled: true,
              workspaces: [f.w.id],
            },
          ]),
        );
        const plugins = new PluginService(
          store,
          path,
          undefined,
          undefined,
          f.service,
        );
        await plugins.saveCloudflare(admin, f.w.id, {
          revision: 0,
          settings,
          apiToken,
        });
        expect((await plugins.view(admin, f.w.id)).entries[0]?.id).toBe(
          "word-count",
        );
        const encrypted = (await store.read(f.w.id)).plugins?.cloudflare
          ?.credential;
        await plugins.saveCodeTruth(admin, f.w.id, {
          revision: 1,
          settings: { enabled: false, repositories: [] },
        });
        expect((await store.read(f.w.id)).plugins?.cloudflare?.credential).toBe(
          encrypted,
        );
        await plugins.saveCloudflare(admin, f.w.id, {
          revision: 2,
          settings: { ...settings, enabled: false },
        });
        expect(
          (
            await sibling.service.query(sibling.w.id, sibling.run.id, 1, {
              resource: "zones",
            })
          ).result,
        ).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    test("approved DNS updates, deletions and whole-zone purges use their exact API contracts", async () => {
      for (const input of [
        {
          action: "update_dns_record",
          zoneId,
          recordId,
          record: action.record,
        },
        { action: "delete_dns_record", zoneId, recordId },
        { action: "purge_cache", zoneId, purgeEverything: true },
      ]) {
        const f = await fixture();
        const a = await proposal(f, input);
        await store.change(f.w.id, (w) => decide(w, "101", a.approvalId, true));
        await f.service.send(f.w.id, a.approvalId);
        const writes = f.requests.filter((r) => r.init.method !== "GET");
        expect(writes).toHaveLength(1);
        const write = writes[0];
        requireThat(write, "missing request");
        expect(write.init.method).toBe(
          input.action === "update_dns_record"
            ? "PATCH"
            : input.action === "delete_dns_record"
              ? "DELETE"
              : "POST",
        );
        if (input.action === "purge_cache")
          expect(JSON.parse(String(write.init.body))).toEqual({
            purge_everything: true,
          });
        if (input.action === "delete_dns_record")
          expect(write.init.body).toBeUndefined();
        expect((await store.read(f.w.id)).approvals[0]?.cloudflare?.state).toBe(
          "completed",
        );
      }
    });
    test("definitive Cloudflare denials fail once without leaking response text", async () => {
      const f = await fixture();
      const a = await proposal(f);
      await store.change(f.w.id, (w) => decide(w, "101", a.approvalId, true));
      f.write(async () =>
        Response.json(
          { success: false, errors: [{ message: "secret provider body" }] },
          { status: 403 },
        ),
      );
      await f.service.send(f.w.id, a.approvalId);
      await f.service.send(f.w.id, a.approvalId);
      const current = await store.read(f.w.id);
      expect(current.approvals[0]?.cloudflare).toMatchObject({
        state: "failed",
        error: "cloudflare_access_denied",
      });
      expect(JSON.stringify(current)).not.toContain("secret provider body");
      expect(f.requests.filter((r) => r.init.method !== "GET")).toHaveLength(1);
    });
  },
);
