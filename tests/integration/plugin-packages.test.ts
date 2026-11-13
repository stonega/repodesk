import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim } from "../../src/admin/auth.ts";
import { extensionToolExecution } from "../../src/agent/extension-execution.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import type { AgentInput } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { PluginError } from "../../src/plugins/contract.ts";
import type { PluginSandbox } from "../../src/plugins/docker-sandbox.ts";
import { DockerPluginSandbox } from "../../src/plugins/docker-sandbox.ts";
import { GitHubPluginSource } from "../../src/plugins/github-source.ts";
import { PluginHttpReader } from "../../src/plugins/http-reader.ts";
import {
  createToolContext,
  validateDefinition,
} from "../../src/plugins/invocation.ts";
import { PluginPackages } from "../../src/plugins/package-service.ts";
import { PluginRunnerClient } from "../../src/plugins/runner-client.ts";
import { pluginRunnerApp } from "../../src/plugins/runner-service.ts";
import { encrypt } from "../../src/setup/credentials.ts";
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
      const image = process.env.PLUGIN_TEST_IMAGE;
      const runnerApp = image
        ? pluginRunnerApp(
            new DockerPluginSandbox(image),
            "synthetic-private-integration-token-12345",
          )
        : undefined;
      const remote = runnerApp
        ? new PluginRunnerClient(
            "http://private.invalid",
            "synthetic-private-integration-token-12345",
            ((url: string | URL | Request, init?: RequestInit) =>
              runnerApp.request(String(url), init)) as typeof fetch,
          )
        : undefined;
      const sandbox: PluginSandbox = {
        async invoke(input) {
          sandboxCalls++;
          if (remote) return remote.invoke(input);
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
      let httpReads = 0;
      const options = {
        directory,
        http: new PluginHttpReader(
          async () => [{ address: "93.184.216.34", family: 4 }],
          async (_url, _address, bearer) => {
            expect(bearer).toBe("synthetic-plugin-service-token");
            httpReads++;
            return {
              status: 200,
              body: [Buffer.from('{"count":2}')],
              cancel() {},
            };
          },
        ),
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
        httpReads: () => httpReads,
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

    test("production Pi and Executor persist package results and do not dispatch after revocation", async () => {
      const f = await fixture();
      const p = await f.preview();
      await f.service.apply(admin, f.w.id, { previewId: p.id, revision: 0 });
      await f.service.update(admin, f.w.id, 777, {
        revision: 1,
        enabled: true,
        settings: {},
        grants: [],
      });
      let modelCalls = 0;
      let revoke = false;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const body = (await request.json()) as {
            tools?: { function: { name: string } }[];
          };
          expect(
            body.tools?.some((t) => t.function.name === "rdp_777_count_words"),
          ).toBe(true);
          modelCalls++;
          if (revoke) {
            const current = await f.service.view(admin, f.w.id);
            await f.service.update(admin, f.w.id, 777, {
              revision: current.revision,
              enabled: false,
              settings: {},
              grants: [],
            });
          }
          const tool = modelCalls % 2 === 1;
          const chunk = {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4.1-mini",
            choices: [
              {
                index: 0,
                delta: tool
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `package-${modelCalls}`,
                          type: "function",
                          function: {
                            name: "rdp_777_count_words",
                            arguments: JSON.stringify({ text: "two words" }),
                          },
                        },
                      ],
                    }
                  : { role: "assistant", content: "Counted two words." },
                finish_reason: tool ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          };
          return new Response(
            `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      try {
        const deployment = await store.deployment();
        deployment.active = true;
        deployment.modelBaseUrl = `http://127.0.0.1:${server.port}/v1`;
        deployment.credentials.model = encrypt(key, "model", "fake-local-key");
        await store.saveDeployment(store.pool, deployment);
        const executor = new Executor(
          store,
          new SetupService(store, key, origin),
          (d, id) => f.plugins.runner(d, id),
        );
        const run = await store.change(f.w.id, (w) =>
          createRun(w, "101", "Count two words", "101", 0, "gpt-4.1-mini"),
        );
        await executor.execute(f.w.id, run.id);
        const saved = (await store.read(f.w.id)).runs.find(
          (r) => r.id === run.id,
        );
        expect(saved?.status).toBe("succeeded");
        expect(saved?.tools["package-1"]?.state).toBe("done");
        expect(saved?.packageRead?.installations["777"]?.digest).toBe(p.digest);
        expect(f.calls()).toBe(1);
        revoke = true;
        const next = await store.change(f.w.id, (w) =>
          createRun(w, "101", "Count again", "101", 0, "gpt-4.1-mini"),
        );
        await executor.execute(f.w.id, next.id);
        const stopped = (await store.read(f.w.id)).runs.find(
          (r) => r.id === next.id,
        );
        expect(["failed", "cancelled"]).toContain(stopped?.status ?? "");
        expect(f.calls()).toBe(1);
      } finally {
        await server.stop(true);
      }
    });
    test("durable receipts reuse a completed package result, refuse uncertain calls and recheck revocation", async () => {
      const f = await fixture();
      const p = await f.preview();
      await f.service.apply(admin, f.w.id, { previewId: p.id, revision: 0 });
      await f.service.update(admin, f.w.id, 777, {
        revision: 1,
        enabled: true,
        settings: {},
        grants: [],
      });
      const run = await store.change(f.w.id, (w) => {
        const r = createRun(w, "101", "Count", "101", 0, "gpt-4.1-mini");
        r.status = "running";
        r.fence = 1;
        return r;
      });
      const tool = await registered(f.plugins, f.w.id, run.id);
      const ledger = extensionToolExecution(
        store,
        f.w.id,
        run.id,
        1,
        new AbortController().signal,
      );
      const execute = () => tool.execute("call", { text: "one two" });
      await ledger(tool.name, "call", execute);
      await ledger(tool.name, "call", execute);
      expect(f.calls()).toBe(1);
      await store.change(f.w.id, (w) => {
        const r = w.runs.find((r) => r.id === run.id);
        if (r) r.tools.uncertain = { name: tool.name, state: "started" };
      });
      await expect(ledger(tool.name, "uncertain", execute)).rejects.toThrow(
        "extension_tool_outcome_unknown",
      );
      await f.service.update(admin, f.w.id, 777, {
        revision: 2,
        enabled: false,
        settings: {},
        grants: [],
      });
      await expect(ledger(tool.name, "call", execute)).rejects.toThrow(
        "tool_policy_denied",
      );
      expect(f.calls()).toBe(1);
    });
    async function registered(
      plugins: PluginService,
      workspaceId: string,
      runId: string,
      actor = "101",
    ) {
      const extensions = plugins.packages.extensions(
        await store.read(workspaceId),
      );
      type Tool = {
        name: string;
        execute: (
          id: string,
          args: { text: string },
        ) => Promise<{
          content: { type: "text"; text: string }[];
          details: unknown;
        }>;
      };
      const tools: Tool[] = [];
      const factory = extensions[0]?.factory({
        workspaceId,
        runId,
        actor,
        signal: new AbortController().signal,
        guard: async () => {},
      } as AgentInput);
      await factory?.({
        registerTool: (tool: Tool) => tools.push(tool),
      } as unknown as Parameters<NonNullable<typeof factory>>[0]);
      const tool = tools.find((t) => t.name.endsWith("count_words"));
      if (!tool) throw new Error("fixture missing package tool");
      return tool;
    }
    test("workspace HTTP credentials are encrypted, scoped to members and revoked before reuse", async () => {
      const f = await fixture();
      const original = f.repo.manifest.tools[0];
      if (!original) throw new Error("missing fixture");
      f.repo.add(
        "0.2.0",
        {
          capabilities: ["http.read"],
          connections: [
            {
              id: "service",
              name: "Service",
              scope: "workspace",
              auth: { type: "bearer" },
              requests: [
                {
                  origin: "https://service.example",
                  paths: ["/count"],
                  queryKeys: [],
                },
              ],
            },
          ],
          tools: [{ ...original, effect: "read", capabilities: ["http.read"] }],
        },
        `export default {tools:{async count_words(input, context){const r=await context.http.request('service',{path:'/count'});return {content:[{type:'text',text:'count'}],structuredContent:r.data}}}};`,
      );
      const p = await f.preview(0, "install", "v0.2.0");
      await f.service.apply(admin, f.w.id, { previewId: p.id, revision: 0 });
      await f.service.update(admin, f.w.id, 777, {
        revision: 1,
        enabled: true,
        settings: {},
        grants: ["http.read"],
      });
      const secret = "synthetic-plugin-service-token";
      await f.service.connect(admin, f.w.id, 777, {
        revision: 2,
        id: "service",
        token: secret,
        members: ["101"],
        chats: [],
        privateOnly: true,
      });
      const saved = await store.read(f.w.id);
      expect(JSON.stringify(saved)).not.toContain(secret);
      expect(
        saved.plugins?.packages?.[0]?.connections[0]?.encrypted,
      ).toBeTruthy();
      expect(JSON.stringify(await f.service.view(admin, f.w.id))).not.toContain(
        "encrypted",
      );
      const other = { ...admin, operator: false, telegramId: "202" };
      await expect(
        f.service.connect(other, f.w.id, 777, {
          revision: 3,
          id: "service",
          members: ["202"],
          chats: [],
          privateOnly: true,
        }),
      ).rejects.toThrow("operator_required");
      const privateRun = await store.change(f.w.id, (w) => {
        const r = createRun(w, "101", "read", "101", 0, "gpt-4.1-mini");
        r.status = "running";
        return r;
      });
      const privateTool = await registered(f.plugins, f.w.id, privateRun.id);
      expect(await privateTool.execute("read", { text: "x" })).toMatchObject({
        details: { count: 2 },
      });
      expect(f.httpReads()).toBe(1);
      const run = await store.change(f.w.id, (w) => {
        const r = createRun(w, "101", "read", "-100100", 0, "gpt-4.1-mini");
        r.status = "running";
        return r;
      });
      const tool = await registered(f.plugins, f.w.id, run.id);
      await expect(tool.execute("denied-group", { text: "x" })).rejects.toThrow(
        "plugin_permission_denied",
      );
      await f.service.connect(admin, f.w.id, 777, {
        revision: 3,
        id: "service",
        disconnect: true,
        members: [],
        chats: [],
        privateOnly: true,
      });
      const current = await store.read(f.w.id);
      expect(current.plugins?.packages?.[0]?.connections).toEqual([]);
      const priorRun = current.runs.find((r) => r.id === run.id);
      expect(priorRun && runAllowed(current, priorRun)).toBe(false);
    });

    test("personal connections require a verified self identity and cannot bind a group", async () => {
      const f = await fixture();
      const original = f.repo.manifest.tools[0];
      if (!original) throw new Error("missing fixture");
      f.repo.add("0.2.0", {
        capabilities: ["http.read"],
        connections: [
          {
            id: "personal",
            name: "Personal",
            scope: "member",
            auth: { type: "bearer" },
            requests: [
              {
                origin: "https://service.example",
                paths: ["/count"],
                queryKeys: [],
              },
            ],
          },
        ],
        tools: [{ ...original, effect: "read", capabilities: ["http.read"] }],
      });
      const p = await f.preview(0, "install", "v0.2.0");
      await f.service.apply(admin, f.w.id, { previewId: p.id, revision: 0 });
      const binding = {
        revision: 1,
        id: "personal",
        token: "synthetic-plugin-service-token",
        members: [],
        chats: [],
        privateOnly: true,
      };
      await expect(
        f.service.connect(admin, f.w.id, 777, binding),
      ).rejects.toThrow("access_denied");
      const member: Admin = {
        id: randomUUID(),
        username: "linkedmember",
        operator: false,
        telegramId: "101",
      };
      await expect(
        f.service.connect(member, f.w.id, 777, {
          ...binding,
          members: ["202"],
        }),
      ).rejects.toThrow("access_denied");
      await expect(
        f.service.connect(member, f.w.id, 777, {
          ...binding,
          chats: ["-100100"],
          privateOnly: false,
        }),
      ).rejects.toThrow("access_denied");
      await f.service.connect(member, f.w.id, 777, binding);
      const saved = (await store.read(f.w.id)).plugins?.packages?.[0]
        ?.connections[0];
      expect(saved?.actor).toBe("101");
      expect(saved?.privateOnly).toBe(true);
      expect(saved?.members).toEqual([]);
      await expect(
        f.service.connect({ ...member, telegramId: "999999" }, f.w.id, 777, {
          ...binding,
          revision: 2,
        }),
      ).rejects.toThrow("access_denied");
    });
  },
);
