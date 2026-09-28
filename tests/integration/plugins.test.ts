import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, login } from "../../src/admin/auth.ts";
import type { PluginPage, PluginSpec } from "../../src/agent/plugin-config.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "plugin management (isolated PostgreSQL)",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `deepx_plugins_${randomUUID().replaceAll("-", "")}`;
    const origin = "http://localhost:3000";
    const key = "ab".repeat(32);
    let store: Store;
    let service: PluginService;
    let setup: SetupService;
    let app: ReturnType<typeof createApp>;
    let auth: { raw: string; csrf: string };
    let admin: Admin;
    let workspaceId: string;
    let otherWorkspaceId: string;
    let siblingWorkspaceId: string;
    let otherAuth: typeof auth;
    let dir: string;
    let entry: PluginSpec;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url ?? "");
      parsed.pathname = `/${name}`;
      const pool = database(parsed.toString());
      await migrate(pool);
      store = new Store(pool);
      setup = new SetupService(store, key, origin);
      service = new PluginService(store);
      app = createApp(store, setup, origin, service);
      auth = await claim(
        pool,

        "pluginoperator",
        "plugin test password",
      );
      const id = (
        await pool.query(
          "SELECT id FROM admins WHERE username='pluginoperator'",
        )
      ).rows[0].id;
      admin = { id, username: "pluginoperator", operator: true };
      const otherId = randomUUID();
      await pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) SELECT $1,'secondoperator',password_hash,true FROM admins WHERE id=$2",
        [otherId, id],
      );
      otherAuth = await login(pool, "secondoperator", "plugin test password");
      for (const owner of [id, otherId]) {
        const w = workspace();
        w.operatorId = owner;
        await pool.query(
          "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
          [w.id, owner, JSON.stringify(w)],
        );
        if (owner === id) workspaceId = w.id;
        else otherWorkspaceId = w.id;
      }
      const sibling = workspace();
      sibling.operatorId = id;
      siblingWorkspaceId = sibling.id;
      await pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [sibling.id, id, JSON.stringify(sibling)],
      );
      dir = await mkdtemp(join(tmpdir(), "deepx-plugin-api-"));
      await writeFile(
        join(dir, "plugin.ts"),
        await readFile("examples/pi-extension.ts", "utf8"),
      );
      entry = {
        id: "word-count",
        version: "1",
        path: join(dir, "plugin.ts"),
        workspaces: [workspaceId],
        tools: ["count_words"],
        execution: "read-only",
        enabled: true,
      };
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
      if (dir) await rm(dir, { recursive: true, force: true });
    });
    const request = (
      method = "GET",
      body?: unknown,
      credentials = auth,
      headers = {},
    ) =>
      app.request(
        `/api/admin/workspaces/${credentials === otherAuth ? otherWorkspaceId : workspaceId}/plugins`,
        {
          method,
          headers: {
            cookie: credentials ? `deepx_session=${credentials.raw}` : "",
            origin,
            "content-type": "application/json",
            "x-csrf-token": credentials?.csrf ?? "",
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
    const get = async () => (await request()).json() as Promise<PluginPage>;

    test("operator-only, CSRF-protected and tenant-scoped before Telegram linking", async () => {
      expect(
        (await request("GET", undefined, { raw: "", csrf: "" })).status,
      ).toBe(401);
      const result = await get();
      expect(result.workspaces.map((w) => w.id)).toEqual([workspaceId]);
      expect(result.revision).toBe(0);
      expect(
        (
          await request("PUT", { revision: 0, entries: [entry] }, auth, {
            "x-csrf-token": "bad",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request("PUT", { revision: 0, entries: [entry] }, auth, {
            origin: "https://other.test",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request("PUT", {
            revision: 0,
            entries: [{ ...entry, workspaces: [otherWorkspaceId] }],
          })
        ).status,
      ).toBe(403);
      await store.pool.query(
        "UPDATE admins SET operator=false WHERE username='secondoperator'",
      );
      expect((await request("GET", undefined, otherAuth)).status).toBe(403);
      await store.pool.query(
        "UPDATE admins SET operator=true WHERE username='secondoperator'",
      );
    });
    test("saves immutable file hashes, audits atomically, rejects stale edits and isolates operators", async () => {
      const saved = await request("PUT", { revision: 0, entries: [entry] });
      expect(saved.status).toBe(200);
      const data: PluginPage = await saved.json();
      expect(data.revision).toBe(1);
      expect(data.source).toBe("panel");
      expect(data.entries[0]?.fileStatus).toBe("ready");
      expect(data.audit).toHaveLength(1);
      expect((await request("PUT", { revision: 0, entries: [] })).status).toBe(
        409,
      );
      expect((await get()).entries).toHaveLength(1);
      const other = await (await request("GET", undefined, otherAuth)).json();
      expect(other.entries).toHaveLength(0);
      expect(other.audit).toHaveLength(0);
      expect(JSON.stringify(other)).not.toContain(entry.path);
      const persisted = (await store.read(workspaceId)).plugins;
      expect(persisted?.entries[0]?.hash).toHaveLength(64);
      expect(
        (await new PluginService(store).view(admin, workspaceId)).revision,
      ).toBe(1);
    });
    test("rejects collisions and invalid paths; saving never executes extension code", async () => {
      expect(
        (
          await request("PUT", {
            revision: 1,
            entries: [{ ...entry, tools: ["read_chat_context"] }],
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request("PUT", {
            revision: 1,
            entries: [{ ...entry, path: "npm:evil" }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request("PUT", {
            revision: 1,
            entries: [{ ...entry, path: join(dir, "missing.ts") }],
          })
        ).status,
      ).toBe(409);
      const second = join(dir, "throwing.ts");
      await writeFile(
        second,
        'throw Error("must not execute on API server"); export default () => {};',
      );
      expect(
        (
          await request("PUT", {
            revision: 1,
            entries: [{ ...entry, path: second }],
          })
        ).status,
      ).toBe(200);
      expect((await get()).entries[0]?.fileStatus).toBe("ready");
      expect(
        (await request("PUT", { revision: 2, entries: [entry] })).status,
      ).toBe(200);
    });
    test("workers consume saved plugins and changes stop active runs before further dispatch", async () => {
      let calls = 0;
      let changeDuringCall = false;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const body = (await request.json()) as {
            tools?: { function: { name: string } }[];
          };
          expect(
            body.tools?.some((tool) => tool.function.name === "count_words"),
          ).toBe(true);
          calls++;
          if (!changeDuringCall) {
            // Same operator, different workspace: saves must not revoke this run.
            const other = await service.view(admin, siblingWorkspaceId);
            await service.save(admin, siblingWorkspaceId, {
              revision: other.revision,
              entries: [
                {
                  ...entry,
                  workspaces: [siblingWorkspaceId],
                  version: String(calls),
                },
              ],
            });
          }
          if (changeDuringCall) {
            const data = await get();
            expect(
              (await requestSave(data.revision, [{ ...entry, enabled: false }]))
                .status,
            ).toBe(200);
          }
          const tool = calls % 2 === 1;
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
                          id: `count-${calls}`,
                          type: "function",
                          function: {
                            name: "count_words",
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
      const requestSave = (revision: number, entries: PluginSpec[]) =>
        request("PUT", { revision, entries });
      try {
        const d = await store.deployment();
        d.active = true;
        d.modelBaseUrl = `http://127.0.0.1:${server.port}/v1`;
        d.credentials.model = encrypt(key, "model", "fake-local-key");
        await store.saveDeployment(store.pool, d);
        const executor = new Executor(store, setup, (deployment, id) =>
          service.runner(deployment, id),
        );
        const run = await store.change(workspaceId, (w) =>
          createRun(w, "101", "Count two words", "-100100", 0, "gpt-4.1-mini"),
        );
        await executor.execute(workspaceId, run.id);
        const saved = (await store.read(workspaceId)).runs.find(
          (r) => r.id === run.id,
        );
        expect(saved?.status).toBe("succeeded");
        expect(saved?.tools["count-1"]?.state).toBe("done");
        expect(calls).toBe(2);
        changeDuringCall = true;
        const next = await store.change(workspaceId, (w) =>
          createRun(w, "101", "Count again", "-100100", 0, "gpt-4.1-mini"),
        );
        await executor.execute(workspaceId, next.id);
        const stopped = (await store.read(workspaceId)).runs.find(
          (r) => r.id === next.id,
        );
        expect(stopped?.status).toBe("failed");
        expect(stopped?.error).toBe("extension_configuration_changed");
        expect(Object.keys(stopped?.tools ?? {})).toHaveLength(0);
        expect(calls).toBe(3);
        expect(
          (await service.runner(await store.deployment(), workspaceId))
            .extensionVersion,
        ).toBeUndefined();
      } finally {
        await server.stop(true);
      }
    });
    test("grant edits do not silently approve changed code; a reviewed version update pins the new file", async () => {
      const current = await get();
      const enabled = { ...entry, enabled: true, version: "2" };
      expect(
        (
          await request("PUT", {
            revision: current.revision,
            entries: [enabled],
          })
        ).status,
      ).toBe(200);
      const originalHash = (await store.read(workspaceId)).plugins?.entries[0]
        ?.hash;
      await writeFile(
        entry.path,
        `${await readFile(entry.path, "utf8")}\n// Updated fixture\n`,
      );
      expect((await get()).entries[0]?.fileStatus).toBe("changed");
      expect(
        (
          await request("PUT", {
            revision: current.revision + 1,
            entries: [enabled],
          })
        ).status,
      ).toBe(200);
      expect((await store.read(workspaceId)).plugins?.entries[0]?.hash).toBe(
        originalHash,
      );
      expect((await get()).entries[0]?.fileStatus).toBe("changed");
      expect(
        (
          await request("PUT", {
            revision: current.revision + 2,
            entries: [{ ...enabled, version: "3" }],
          })
        ).status,
      ).toBe(200);
      expect((await get()).entries[0]?.fileStatus).toBe("ready");
      expect(
        (await store.read(workspaceId)).plugins?.entries[0]?.hash,
      ).not.toBe(originalHash);
    });
    test("disabled missing files can be removed, and an empty saved registry does not fall back", async () => {
      const current = await get();
      await rm(entry.path);
      expect(
        (
          await request("PUT", {
            revision: current.revision,
            entries: [{ ...entry, enabled: false }],
          })
        ).status,
      ).toBe(200);
      expect((await get()).entries[0]?.fileStatus).toBe("unchecked");
      expect(
        (await request("PUT", { revision: current.revision + 1, entries: [] }))
          .status,
      ).toBe(200);
      expect((await get()).source).toBe("panel");
      expect((await get()).entries).toHaveLength(0);
      expect(
        (
          await new PluginService(store, "/missing/manifest.json").runner(
            await store.deployment(),
            workspaceId,
          )
        ).extensionVersion,
      ).toBeUndefined();
    });
    test("predefined Code Truth settings enforce grants, revisions and registered-tool collisions", async () => {
      const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/code-truth`;
      const codeRequest = (
        method = "GET",
        body?: unknown,
        credentials = auth,
        suffix = "",
      ) =>
        app.request(
          (credentials === otherAuth
            ? endpoint.replace(workspaceId, otherWorkspaceId)
            : endpoint) + suffix,
          {
            method,
            headers: {
              cookie: `deepx_session=${credentials.raw}`,
              origin,
              "content-type": "application/json",
              "x-csrf-token": credentials.csrf,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        );
      const page = await (await codeRequest()).json();
      expect(page.settings).toEqual({ enabled: false, repositories: [] });
      expect(page.workspaces.map((w: { id: string }) => w.id)).toEqual([
        workspaceId,
      ]);
      const repo = {
        id: "frontend",
        repositoryUrl: "https://github.com/example/frontend.git",
        networks: { devnet: "main" },
        workspaces: [workspaceId],
      };
      const input = {
        revision: page.revision,
        settings: { enabled: true, repositories: [repo] },
      };
      expect(
        (await codeRequest("PUT", input, { ...auth, csrf: "invalid" })).status,
      ).toBe(403);
      expect(
        (
          await codeRequest("PUT", {
            ...input,
            settings: {
              enabled: true,
              repositories: [{ ...repo, workspaces: [otherWorkspaceId] }],
            },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await codeRequest("PUT", {
            ...input,
            settings: {
              enabled: true,
              repositories: [{ ...repo, repositoryUrl: "file:///tmp/repo" }],
            },
          })
        ).status,
      ).toBe(400);
      expect((await codeRequest("PUT", input)).status).toBe(200);
      expect((await codeRequest("PUT", input)).status).toBe(409);
      expect(
        (await (await codeRequest("GET", undefined, otherAuth)).json()).settings
          .repositories,
      ).toHaveLength(0);
      expect(
        (
          await codeRequest(
            "POST",
            { workspaceId: otherWorkspaceId },
            auth,
            "/status",
          )
        ).status,
      ).toBe(400);
      expect((await codeRequest("POST", {}, auth, "/status")).status).toBe(503);
      const registered = await get();
      expect(
        (
          await request("PUT", {
            revision: registered.revision,
            entries: [{ ...entry, tools: ["get_code_context"] }],
          })
        ).status,
      ).toBe(409);
      expect(
        (await request("PUT", { revision: registered.revision, entries: [] }))
          .status,
      ).toBe(200);
      expect((await (await codeRequest()).json()).settings).toEqual(
        input.settings,
      );
      const saved = await (await codeRequest()).json();
      expect(
        (
          await codeRequest("PUT", {
            revision: saved.revision,
            settings: { ...input.settings, enabled: false },
          })
        ).status,
      ).toBe(200);
      expect(
        (await service.runner(await store.deployment(), workspaceId))
          .extensionVersion,
      ).toBeUndefined();
    });

    test("same-owner workspaces have independent settings, revisions, audits and Code Truth", async () => {
      const before = await service.view(admin, workspaceId);
      const siblingBefore = await service.view(admin, siblingWorkspaceId);
      const siblingEntry = {
        ...entry,
        enabled: false,
        workspaces: [siblingWorkspaceId],
      };
      const results = await Promise.allSettled([
        service.save(admin, siblingWorkspaceId, {
          revision: siblingBefore.revision,
          entries: [siblingEntry],
        }),
        service.save(admin, siblingWorkspaceId, {
          revision: siblingBefore.revision,
          entries: [],
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const siblingSaved = await service.view(admin, siblingWorkspaceId);
      expect(siblingSaved.revision).toBe(siblingBefore.revision + 1);
      expect(await service.view(admin, workspaceId)).toEqual(before);
      await expect(
        service.save(admin, siblingWorkspaceId, {
          revision: siblingSaved.revision,
          entries: [entry],
        }),
      ).rejects.toMatchObject({ code: "access_denied" });
      await expect(service.view(admin, otherWorkspaceId)).rejects.toMatchObject(
        { code: "access_denied" },
      );
      await expect(
        service.save(admin, otherWorkspaceId, { revision: 0, entries: [] }),
      ).rejects.toMatchObject({ code: "access_denied" });
      const truthBefore = await service.codeTruthView(admin, workspaceId);
      await service.saveCodeTruth(admin, siblingWorkspaceId, {
        revision: siblingSaved.revision,
        settings: {
          enabled: true,
          repositories: [
            {
              id: "independent",
              repositoryUrl: "https://github.com/example/independent",
              networks: { devnet: "other-branch" },
              workspaces: [siblingWorkspaceId],
            },
          ],
        },
      });
      expect(await service.codeTruthView(admin, workspaceId)).toEqual(
        truthBefore,
      );
      expect(
        (await service.codeTruthView(admin, siblingWorkspaceId)).settings
          .repositories[0]?.networks.devnet,
      ).toBe("other-branch");
      expect((await store.deployment()) as object).not.toHaveProperty(
        "plugins",
      );
      // The old operator-wide endpoint cannot silently mutate multiple workspaces.
      expect(
        (
          await app.request("/api/admin/operator/plugins", {
            headers: { cookie: `deepx_session=${auth.raw}` },
          })
        ).status,
      ).toBe(404);
    });

    test("manifest fallback and first saves are isolated per workspace", async () => {
      const fresh = [workspace(), workspace()];
      const [first, second] = fresh;
      if (!first || !second) throw Error("missing fixture");
      for (const w of fresh) {
        w.operatorId = admin.id;
        await store.pool.query(
          "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
          [w.id, admin.id, JSON.stringify(w)],
        );
      }
      const manifest = join(dir, "fallback.json");
      const fallbackPath = join(dir, "fallback.ts");
      await writeFile(
        fallbackPath,
        await readFile("examples/pi-extension.ts", "utf8"),
      );
      await writeFile(
        manifest,
        JSON.stringify([
          {
            ...entry,
            path: fallbackPath,
            enabled: true,
            workspaces: [first.id, second.id],
          },
        ]),
      );
      const fallback = new PluginService(store, manifest);
      expect(
        (await fallback.view(admin, first.id)).entries[0]?.workspaces,
      ).toEqual([first.id]);
      expect((await fallback.view(admin, second.id)).source).toBe("manifest");
      await fallback.save(admin, first.id, { revision: 0, entries: [] });
      expect((await fallback.view(admin, first.id)).entries).toEqual([]);
      expect((await fallback.view(admin, second.id)).entries).toHaveLength(1);
      expect((await fallback.view(admin, second.id)).revision).toBe(0);
      await fallback.saveCodeTruth(admin, second.id, {
        revision: 0,
        settings: { enabled: false, repositories: [] },
      });
      expect(
        (await fallback.view(admin, second.id)).entries[0]?.workspaces,
      ).toEqual([second.id]);
      expect((await fallback.view(admin, first.id)).entries).toEqual([]);
    });

    test("migration splits existing grants, preserves hashes and explicit empty settings, and runs once", async () => {
      const legacyWorkspaces = [
        workspace(),
        workspace(),
        workspace(),
        workspace(),
      ];
      const [first, second, empty, deleted] = legacyWorkspaces;
      if (!first || !second || !empty || !deleted)
        throw Error("missing fixture");
      deleted.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "pending",
      };
      for (const w of legacyWorkspaces) {
        w.operatorId = admin.id;
        await store.pool.query(
          "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
          [w.id, admin.id, JSON.stringify(w)],
        );
      }
      const oldSettings = {
        revision: 12,
        entries: [
          {
            ...entry,
            enabled: false,
            hash: "a".repeat(64),
            workspaces: [first.id, second.id],
          },
        ],
        codeTruth: {
          enabled: true,
          repositories: [
            {
              id: "legacy",
              repositoryUrl: "https://github.com/example/legacy",
              networks: { devnet: "main" },
              workspaces: [second.id],
            },
          ],
        },
      };
      const preserved = (await store.read(workspaceId)).plugins;
      await store.pool.query(
        "UPDATE deployment SET data=jsonb_set(data,'{plugins}',$1::jsonb)",
        [JSON.stringify({ [admin.id]: oldSettings })],
      );
      await store.pool.query(
        "DELETE FROM schema_migrations WHERE name='006_workspace_plugins.sql'",
      );
      await migrate(store.pool);
      const a = (await store.read(first.id)).plugins;
      const b = (await store.read(second.id)).plugins;
      expect(a?.entries[0]?.workspaces).toEqual([first.id]);
      expect(b?.entries[0]?.workspaces).toEqual([second.id]);
      expect(a?.entries[0]?.hash).toBe("a".repeat(64));
      expect(a?.entries[0]?.enabled).toBe(false);
      expect(a?.revision).toBe(12);
      expect(a?.codeTruth?.repositories).toEqual([]);
      expect(b?.codeTruth?.repositories[0]?.workspaces).toEqual([second.id]);
      expect((await store.read(empty.id)).plugins?.entries).toEqual([]);
      expect((await store.read(deleted.id)).plugins).toBeUndefined();
      expect((await store.read(otherWorkspaceId)).plugins).toBeUndefined();
      expect((await store.read(workspaceId)).plugins).toEqual(preserved);
      expect(
        (
          await new PluginService(store, "/missing/manifest.json").runner(
            await store.deployment(),
            empty.id,
          )
        ).extensionVersion,
      ).toBeUndefined();
      expect((await store.deployment()) as object).not.toHaveProperty(
        "plugins",
      );
      await service.save(admin, first.id, { revision: 12, entries: [] });
      await migrate(store.pool);
      expect((await store.read(first.id)).plugins?.revision).toBe(13);
      expect((await store.read(second.id)).plugins).toEqual(b);
      await expect(service.view(admin, deleted.id)).rejects.toMatchObject({
        code: "access_denied",
      });
      await expect(
        service.save(admin, deleted.id, { revision: 0, entries: [] }),
      ).rejects.toMatchObject({ code: "access_denied" });
    });
  },
);
