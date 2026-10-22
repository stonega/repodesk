import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { claim } from "../../src/admin/auth.ts";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { obsidianExtension } from "../../src/obsidian/extension.ts";
import { ObsidianService } from "../../src/obsidian/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { spec, workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Obsidian organization vault (isolated PostgreSQL)",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `repodesk_obsidian_${randomUUID().replaceAll("-", "")}`;
    const origin = "http://localhost:3000";
    let store: Store;
    let service: ObsidianService;
    let plugins: PluginService;
    let app: ReturnType<typeof createApp>;
    let admin: Admin;
    let auth: { raw: string; csrf: string };
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const target = new URL(url ?? "");
      target.pathname = `/${name}`;
      store = new Store(database(target.toString()));
      await migrate(store.pool);
      auth = await claim(store.pool, "vaultoperator", "vault test password");
      const row = (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='vaultoperator'",
        )
      ).rows[0];
      admin = { id: row.id, username: "vaultoperator", operator: true };
      service = new ObsidianService(store);
      plugins = new PluginService(store);
      app = createApp(
        store,
        new SetupService(store, "ab".repeat(32), origin),
        origin,
        plugins,
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function fresh() {
      const w = workspace();
      w.operatorId = admin.id;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      return w;
    }
    async function running(id: string, actor = "101") {
      return store.change(id, (w) => {
        const run = createRun(
          w,
          actor,
          "Manage organization notes",
          actor,
          0,
          "gpt-4.1-mini",
        );
        run.status = "running";
        run.fence = 1;
        return run;
      });
    }
    const request = (
      id: string,
      suffix = "",
      method = "GET",
      body?: unknown,
      headers = {},
    ) =>
      app.request(`/api/admin/workspaces/${id}/plugins/obsidian${suffix}`, {
        method,
        headers: {
          cookie: `deepx_session=${auth.raw}`,
          origin,
          "content-type": "application/json",
          "x-csrf-token": auth.csrf,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    test("default-enabled catalog and API work before linking, with auth/CSRF/Origin checks", async () => {
      const w = await fresh();
      const result = await (await request(w.id)).json();
      expect(result.settings.enabled).toBe(true);
      expect(result.total).toBe(5);
      expect(
        (await plugins.runner(await store.deployment(), w.id)).extensionVersion,
      ).toBeDefined();
      expect(
        (await request(w.id, "", "GET", undefined, { cookie: "" })).status,
      ).toBe(401);
      for (const headers of [
        { "x-csrf-token": "bad" },
        { origin: "https://other.test" },
      ])
        expect(
          (
            await request(
              w.id,
              "/files",
              "POST",
              { action: "save", revision: 0, path: "Note.md", content: "No" },
              headers,
            )
          ).status,
        ).toBe(403);
      await expect(
        service.view({ ...admin, id: randomUUID() }, w.id),
      ).rejects.toMatchObject({ code: "access_denied" });
      await expect(
        service.view({ ...admin, operator: false }, w.id),
      ).rejects.toMatchObject({ code: "operator_required" });
    });
    test("writes, read, filtering, export and conflicts persist within the selected tenant", async () => {
      const w = await fresh();
      const sibling = await fresh();
      const body = {
        action: "save",
        revision: 0,
        path: "Projects/Launch.md",
        content:
          "---\ntags: [project]\nstatus: open\n---\n# Launch\n- [ ] Ship",
      };
      expect((await request(w.id, "/files", "POST", body)).status).toBe(200);
      expect((await request(w.id, "/files", "POST", body)).status).toBe(409);
      expect(
        (await (await request(w.id, "?tag=project&tasks=open")).json()).total,
      ).toBe(1);
      expect(
        (await (await request(w.id, "/file?path=Projects%2FLaunch.md")).json())
          .content,
      ).toBe(body.content);
      expect((await (await request(sibling.id)).json()).total).toBe(5);
      const exported = await request(w.id, "/export");
      expect(exported.headers.get("cache-control")).toBe("no-store");
      expect(
        unzipSync(new Uint8Array(await exported.arrayBuffer()))[
          "Projects/Launch.md"
        ],
      ).toBeDefined();
    });
    test("concurrent writers serialize and a malformed import rolls back the whole request", async () => {
      const w = await fresh();
      const results = await Promise.all(
        ["A", "B"].map((path) =>
          service
            .mutate(admin, w.id, {
              action: "save",
              revision: 0,
              path: `${path}.md`,
              content: path,
            })
            .then(
              () => true,
              () => false,
            ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      await expect(
        service.mutate(admin, w.id, {
          action: "import",
          revision: 1,
          files: [
            { path: "Good.md", content: "Good" },
            { path: "Bad.canvas", content: "{}" },
          ],
        }),
      ).rejects.toMatchObject({ code: "obsidian_invalid_canvas" });
      expect(
        (await service.view(admin, w.id, { query: "Good.md" })).total,
      ).toBe(0);
      expect((await service.view(admin, w.id)).vaultRevision).toBe(1);
    });
    test("members read, owner/admin manage; spoofed actors, tenants and execution fences fail", async () => {
      const w = await fresh();
      const sibling = await fresh();
      const run = await running(w.id, "202");
      expect(
        await service.tool(w.id, run.id, "202", 0, 1, "query", {}, "read"),
      ).toMatchObject({ total: 5 });
      const write = {
        action: "save",
        revision: 0,
        path: "Denied.md",
        content: "Denied",
      };
      for (const [id, actor, fence] of [
        [w.id, "202", 1],
        [w.id, "101", 1],
        [sibling.id, "202", 1],
        [w.id, "202", 0],
      ] as const)
        await expect(
          service.tool(id, run.id, actor, 0, fence, "write", write, "denied"),
        ).rejects.toMatchObject({ code: "access_denied" });
      const adminRun = await running(w.id, "303");
      await service.tool(
        w.id,
        adminRun.id,
        "303",
        0,
        1,
        "write",
        write,
        "saved",
      );
      expect(
        (await service.view(admin, w.id, { query: "Denied.md" })).total,
      ).toBe(1);
    });
    test("duplicate tool delivery doesn't append twice, even across service instances", async () => {
      const w = await fresh();
      const run = await running(w.id);
      const input = {
        action: "daily",
        date: "2026-10-22",
        content: "Unique update",
        revision: 0,
      };
      const result = await service.tool(
        w.id,
        run.id,
        "101",
        0,
        1,
        "write",
        input,
        "same-call",
      );
      expect(
        await new ObsidianService(store).tool(
          w.id,
          run.id,
          "101",
          0,
          1,
          "write",
          input,
          "same-call",
        ),
      ).toEqual(result);
      expect(
        (await service.read(admin, w.id, "Daily/2026-10-22.md")).content.match(
          /Unique update/g,
        ),
      ).toHaveLength(1);
    });
    test("active scheduled workflows can read shared knowledge but cannot write notes", async () => {
      const w = await fresh();
      const run = await store.change(w.id, (current) => {
        current.workflows.push({
          id: "scheduled",
          version: 1,
          owner: "101",
          status: "active",
          spec: spec(current),
          skillVersion: 1,
          versions: [],
        });
        const result = createRun(
          current,
          "101",
          "Summarize organization notes",
          "-100100",
          0,
          "gpt-4.1-mini",
          { workflowId: "scheduled" },
        );
        result.status = "running";
        result.fence = 1;
        return result;
      });
      expect(
        await service.tool(w.id, run.id, "101", 0, 1, "query", {}, "read"),
      ).toMatchObject({ total: 5 });
      await expect(
        service.tool(
          w.id,
          run.id,
          "101",
          0,
          1,
          "write",
          { action: "daily", date: "2026-10-22", revision: 0 },
          "write",
        ),
      ).rejects.toMatchObject({ code: "access_denied" });
    });
    test("deactivation, cancellation, scheduled writes and plugin disable/re-enable deny stale tools", async () => {
      for (const change of [
        "member",
        "cancel",
        "schedule",
        "disable",
        "reclaim",
        "delete",
      ]) {
        const w = await fresh();
        const run = await running(w.id);
        await store.change(w.id, (current) => {
          const saved = current.runs.find((r) => r.id === run.id);
          if (!saved) throw Error("missing run");
          if (change === "member") {
            const member = current.members.find((m) => m.id === "101");
            if (member) member.active = false;
          }
          if (change === "cancel") saved.cancelled = true;
          if (change === "schedule") saved.workflowId = "schedule";
          if (change === "reclaim") saved.fence++;
          if (change === "delete")
            current.deletion = {
              requestedAt: new Date().toISOString(),
              providerState: "pending",
            };
        });
        if (change === "disable") {
          await service.configure(admin, w.id, { revision: 0, enabled: false });
          await service.configure(admin, w.id, { revision: 1, enabled: true });
        }
        await expect(
          service.tool(
            w.id,
            run.id,
            "101",
            0,
            1,
            "write",
            { action: "save", path: "Denied.md", content: "No", revision: 0 },
            "write",
          ),
        ).rejects.toMatchObject({ code: "access_denied" });
      }
    });
    test("real Pi extension loader exposes native tools/instructions and applies revocation", async () => {
      const w = await fresh();
      const run = await running(w.id);
      const input: AgentInput = {
        workspaceId: w.id,
        actor: "101",
        runId: run.id,
        model: selectedModel("gpt-4.1-mini"),
        apiKey: "fake",
        system: "Policy",
        prompt: "Save a note",
        transcript: [],
        tools: [],
        signal: new AbortController().signal,
        guard: async () => {},
        reserve: async () => "unused",
        checkpoint: async () => {},
      };
      const host = await ExtensionCatalog.fromSnapshot(
        [],
        [obsidianExtension(service, w.id, 0)],
      ).open(input);
      if (!host) throw Error("missing host");
      try {
        expect(await host.start()).toContain("# RepoDesk Obsidian");
        expect(host.tools.map((t) => t.name)).toEqual([
          "obsidian_query",
          "obsidian_read",
          "obsidian_write",
        ]);
        const write = host.tools.find((t) => t.name === "obsidian_write");
        if (!write) throw Error("missing tool");
        await write.execute("call", {
          action: "save",
          path: "Saved.md",
          content: "# Saved",
          revision: 0,
        });
        expect((await service.read(admin, w.id, "Saved.md")).content).toBe(
          "# Saved",
        );
        await service.configure(admin, w.id, { revision: 0, enabled: false });
        await expect(
          write.execute("stale", {
            action: "save",
            path: "Denied.md",
            content: "No",
            revision: 1,
          }),
        ).rejects.toMatchObject({ code: "access_denied" });
        expect(
          (await plugins.runner(await store.deployment(), w.id))
            .extensionVersion,
        ).toBeUndefined();
      } finally {
        await host.close();
      }
    });
  },
);
