import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { PluginError } from "../../src/plugins/contract.ts";
import type { PluginSandbox } from "../../src/plugins/docker-sandbox.ts";
import { GitHubPluginSource } from "../../src/plugins/github-source.ts";
import {
  createToolContext,
  validateDefinition,
} from "../../src/plugins/invocation.ts";
import { PluginPackages } from "../../src/plugins/package-service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { pluginRepository } from "../fixtures/plugin-packages.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "GitHub package management (isolated PostgreSQL)",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `plugin_packages_${randomUUID().replaceAll("-", "")}`;
    const origin = "http://localhost:3000";
    const key = "ab".repeat(32);
    let store: Store;
    let admin: Admin;
    let credentials: { raw: string; csrf: string };
    let directory: string;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const target = new URL(url ?? "");
      target.pathname = `/${name}`;
      const pool = database(target.toString());
      await migrate(pool);
      store = new Store(pool);
      credentials = await claim(
        pool,
        "packageoperator",
        "package operator password",
      );
      admin = {
        id: (
          await pool.query(
            "SELECT id FROM admins WHERE username='packageoperator'",
          )
        ).rows[0].id,
        username: "packageoperator",
        operator: true,
      };
      directory = await mkdtemp(
        join(tmpdir(), "repodesk-package-integration-"),
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function fixture() {
      const w = workspace();
      w.operatorId = admin.id;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      const repo = await pluginRepository();
      let sandboxCalls = 0;
      const sandbox: PluginSandbox = {
        async invoke(input) {
          sandboxCalls++;
          await input.guard();
          const encoded = `data:text/javascript;base64,${input.bundle.toString("base64")}`;
          const definition = validateDefinition(
            input.manifest,
            (await import(encoded)).default,
          );
          const context = createToolContext({
            ...input,
            invocation: {
              id: randomUUID(),
              deadline: new Date(Date.now() + 30000).toISOString(),
            },
          });
          const handler = definition.tools[input.tool];
          if (!handler) throw new PluginError("plugin_package_invalid");
          return handler(input.arguments, context);
        },
      };
      const options = {
        directory,
        sandbox,
        source: new GitHubPluginSource(repo.transport),
        encryptionKey: key,
      };
      const plugins = new PluginService(
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        options,
      );
      const service = plugins.packages;
      const app = createApp(
        store,
        new SetupService(store, key, origin),
        origin,
        plugins,
      );
      const request = (
        path = "",
        method = "GET",
        body?: unknown,
        headers = {},
      ) =>
        app.request(`/api/admin/workspaces/${w.id}/plugin-packages${path}`, {
          method,
          headers: {
            origin,
            cookie: `repodesk_session=${credentials.raw}`,
            "x-csrf-token": credentials.csrf,
            "content-type": "application/json",
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const preview = (
        revision = 0,
        intent = "install",
        ref = "v0.1.0",
        requestId = randomUUID(),
      ) =>
        service.preview(admin, w.id, {
          url: repo.manifest.repository,
          ref,
          revision,
          intent,
          requestId,
        });
      return {
        w,
        repo,
        service,
        plugins,
        request,
        preview,
        calls: () => sandboxCalls,
        options,
      };
    }
    test("only the current workspace operator can install, with origin and CSRF checks", async () => {
      const f = await fixture();
      expect((await f.request()).status).toBe(200);
      expect(
        (await f.request("", "GET", undefined, { cookie: "" })).status,
      ).toBe(401);
      expect(
        (await f.request("/previews", "POST", {}, { "x-csrf-token": "wrong" }))
          .status,
      ).toBe(403);
      expect(
        (
          await f.request(
            "/previews",
            "POST",
            {},
            { origin: "https://wrong.test" },
          )
        ).status,
      ).toBe(403);
      await expect(
        f.service.view({ ...admin, id: randomUUID() }, f.w.id),
      ).rejects.toThrow("access_denied");
      await expect(
        f.service.view(
          { ...admin, operator: false, telegramId: "303" },
          f.w.id,
        ),
      ).rejects.toThrow("operator_required");
      expect(f.repo.calls).toHaveLength(0);
    });
    test("preview and disabled install survive service restart and are idempotent under concurrency", async () => {
      const f = await fixture();
      const requestId = randomUUID();
      const [a, b] = await Promise.all([
        f.preview(0, "install", "v0.1.0", requestId),
        f.preview(0, "install", "v0.1.0", requestId),
      ]);
      expect(a.id).toBe(b.id);
      expect((await f.service.view(admin, f.w.id)).revision).toBe(0);
      const restarted = new PluginPackages(store, f.options);
      const input = { previewId: a.id, revision: 0 };
      await Promise.all([
        restarted.apply(admin, f.w.id, input),
        restarted.apply(admin, f.w.id, input),
      ]);
      const installed = await restarted.view(admin, f.w.id);
      expect(installed.revision).toBe(1);
      expect(installed.entries).toHaveLength(1);
      expect(installed.entries[0]?.enabled).toBe(false);
      expect(f.calls()).toBe(0);
      await restarted.apply(admin, f.w.id, input);
      expect((await restarted.view(admin, f.w.id)).revision).toBe(1);
      expect(
        (await store.read(f.w.id)).audit.filter(
          (a) => a.action === "plugins.package_install",
        ),
      ).toHaveLength(1);
    });
    test("stale previews and moved tags cannot replace an approved artifact", async () => {
      const f = await fixture();
      const candidate = await f.preview();
      const next = f.repo.add("0.2.0");
      f.repo.tags.set("v0.1.0", next);
      await expect(
        f.service.apply(admin, f.w.id, {
          previewId: candidate.id,
          revision: 0,
        }),
      ).rejects.toThrow("plugin_package_invalid");
      expect((await f.service.view(admin, f.w.id)).entries).toHaveLength(0);
      f.repo.tags.set("v0.1.0", f.repo.commit);
      await store.change(f.w.id, (w) => {
        w.plugins = { entries: [], revision: 1 };
      });
      await expect(
        f.service.apply(admin, f.w.id, {
          previewId: candidate.id,
          revision: 0,
        }),
      ).rejects.toThrow("version_conflict");
    });
    test("workspace artifact isolation prevents replaying another workspace preview", async () => {
      const a = await fixture();
      const b = await fixture();
      const preview = await a.preview();
      await expect(
        b.service.apply(admin, b.w.id, { previewId: preview.id, revision: 0 }),
      ).rejects.toThrow("plugin_preview_expired");
      await expect(
        b.service.artifacts?.get(b.w.id, preview.digest),
      ).rejects.toThrow("plugin_package_invalid");
    });
    test("updates require a new version and rollback creates a disabled current-policy installation", async () => {
      const f = await fixture();
      const first = await f.preview();
      await f.service.apply(admin, f.w.id, {
        previewId: first.id,
        revision: 0,
      });
      await f.service.update(admin, f.w.id, 777, {
        revision: 1,
        enabled: true,
        settings: {},
        grants: [],
      });
      f.repo.add("0.2.0");
      const update = await f.preview(2, "update", "v0.2.0");
      await f.service.apply(admin, f.w.id, {
        previewId: update.id,
        revision: 2,
      });
      const current = (await f.service.view(admin, f.w.id)).entries[0];
      expect(current?.manifest.version).toBe("0.2.0");
      expect(current?.enabled).toBe(false);
      expect(current?.history[0]?.digest).toBe(first.digest);
      const rollback = await f.preview(3, "rollback", first.source.commit);
      const restored = await f.service.apply(admin, f.w.id, {
        previewId: rollback.id,
        revision: 3,
      });
      expect(restored.entries[0]?.digest).toBe(first.digest);
      expect(restored.entries[0]?.enabled).toBe(false);
      expect(restored.entries[0]?.generation).toBeGreaterThan(
        current?.generation ?? 0,
      );
      await expect(
        f.service.update(admin, f.w.id, 777, {
          revision: 4,
          enabled: true,
          settings: {},
          grants: ["http.read"],
        }),
      ).rejects.toThrow("plugin_capability_denied");
    });
    test("production Pi factory is static and package execution is bound to the actor and durable run", async () => {
      const f = await fixture();
      const preview = await f.preview();
      await f.service.apply(admin, f.w.id, {
        previewId: preview.id,
        revision: 0,
      });
      await f.service.update(admin, f.w.id, 777, {
        revision: 1,
        enabled: true,
        settings: {},
        grants: [],
      });
      const run = await store.change(f.w.id, (w) => {
        const run = createRun(
          w,
          "101",
          "Count three words",
          "101",
          0,
          "gpt-4.1-mini",
        );
        run.status = "running";
        return run;
      });
      const w = await store.read(f.w.id);
      const extensions = f.service.extensions(w);
      expect(f.calls()).toBe(0);
      const tools: {
        name: string;
        execute: (id: string, args: { text: string }) => Promise<unknown>;
      }[] = [];
      const input = {
        workspaceId: f.w.id,
        actor: "101",
        runId: run.id,
        signal: new AbortController().signal,
        guard: async () => {},
      };
      const factory = extensions[0]?.factory(
        input as Parameters<NonNullable<(typeof extensions)[0]>["factory"]>[0],
      );
      await factory?.({
        registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
      } as unknown as Parameters<NonNullable<typeof factory>>[0]);
      expect(f.calls()).toBe(0);
      expect(tools[0]?.name).toBe("rdp_777_count_words");
      expect(
        await tools[0]?.execute("call-1", { text: "one two three" }),
      ).toMatchObject({ details: { count: 3 } });
      expect(f.calls()).toBe(1);
      const saved = (await store.read(f.w.id)).runs.find(
        (r) => r.id === run.id,
      );
      expect(saved?.packageRead?.installations["777"]?.digest).toBe(
        preview.digest,
      );
      await f.service.update(admin, f.w.id, 777, {
        revision: 2,
        enabled: false,
        settings: {},
        grants: [],
      });
      const disabled = await store.read(f.w.id);
      expect(saved && runAllowed(disabled, saved)).toBe(false);
      await expect(
        tools[0]?.execute("call-2", { text: "one" }),
      ).rejects.toThrow("tool_policy_denied");
      expect(f.calls()).toBe(1);
    });
  },
);
