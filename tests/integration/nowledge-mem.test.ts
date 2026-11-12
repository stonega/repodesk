import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import type { NowledgePage } from "../../src/nowledge-mem/config.ts";
import { NowledgeService } from "../../src/nowledge-mem/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Nowledge Mem persisted application path",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `nowledge_${randomUUID().replaceAll("-", "")}`;
    const key = "ab".repeat(32),
      origin = "http://localhost:3000";
    let store: Store,
      service: NowledgeService,
      app: ReturnType<typeof createApp>,
      admin: Admin;
    let auth: { raw: string; csrf: string },
      id: string,
      sibling: string,
      calls = 0;
    const transport = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        return Response.json({
          memory: {
            id: body.id,
            space_id: body.space_id,
            content: body.content,
          },
        });
      },
      { preconnect() {} },
    ) as typeof fetch;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url ?? "");
      parsed.pathname = `/${name}`;
      const pool = database(parsed.toString());
      await migrate(pool);
      store = new Store(pool);
      auth = await claim(pool, "nowledgeoperator", "nowledge test password");
      const row = (
        await pool.query(
          "SELECT id FROM admins WHERE username='nowledgeoperator'",
        )
      ).rows[0];
      admin = { id: row.id, username: "nowledgeoperator", operator: true };
      for (let i = 0; i < 2; i++) {
        const w = workspace();
        w.operatorId = i === 0 ? admin.id : randomUUID();
        if (i === 0) id = w.id;
        else sibling = w.id;
        await pool.query(
          "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
          [w.id, admin.id, JSON.stringify(w)],
        );
      }
      const d = await store.deployment();
      d.active = true;
      d.bot = { id: "999", username: "fixture", visibleAll: false };
      await store.saveDeployment(pool, d);
      service = new NowledgeService(store, key, transport);
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
        service,
      );
      app = createApp(
        store,
        new SetupService(store, key, origin),
        origin,
        plugins,
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    const request = (
      method: string,
      body?: unknown,
      target = id,
      csrf = auth.csrf,
    ) =>
      app.request(`/api/admin/workspaces/${target}/plugins/nowledge-mem`, {
        method,
        headers: {
          cookie: `deepx_session=${auth.raw}`,
          origin,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    test("API protects configuration, encrypts credentials and preserves tenant boundaries", async () => {
      const current = (await (await request("GET")).json()) as NowledgePage;
      expect(current.settings.enabled).toBe(false);
      const input = {
        revision: 0,
        settings: {
          enabled: true,
          apiUrl: "https://mem.example",
          memberId: "101",
          spaceId: "default",
          spaceName: "Default",
        },
        apiKey: "nmem_integration_secret",
      };
      expect((await request("PUT", input, id, "bad")).status).toBe(403);
      expect((await request("PUT", input, sibling)).status).toBe(403);
      const saved = await request("PUT", input);
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain(input.apiKey);
      const row = await store.read(id);
      expect(row.plugins?.nowledgeMem?.credential).toStartWith("v2.");
      expect(row.plugins?.nowledgeMem?.credential).not.toContain(input.apiKey);
      expect(calls).toBe(0);
      expect((await request("PUT", input)).status).toBe(409);
    });
    test("concurrent saves send once; fresh service reuses a durable receipt", async () => {
      const run = await store.change(id, (w) => {
        const r = createRun(
          w,
          "101",
          "Save to Nowledge Mem: Our test decision.",
          "101",
          0,
          "gpt-4.1-mini",
        );
        r.status = "running";
        r.fence = 1;
        return structuredClone(r);
      });
      const sourceId = run.sources.find((s) => s.role === "user")?.id;
      const call = (s: NowledgeService) =>
        s.tool(id, run.id, "101", 1, 1, "save", { sourceId });
      const outcomes = await Promise.allSettled([call(service), call(service)]);
      expect(
        outcomes.filter((o) => o.status === "fulfilled").length,
      ).toBeGreaterThanOrEqual(1);
      expect(calls).toBe(1);
      expect(
        await call(new NowledgeService(store, key, transport)),
      ).toMatchObject({ status: "saved" });
      expect(calls).toBe(1);
      const data = await store.read(id);
      expect(
        data.runs.find((r) => r.id === run.id)?.nowledgeSaves?.[sourceId ?? ""]
          ?.state,
      ).toBe("saved");
      await service.configure(admin, id, {
        revision: 1,
        settings: { ...data.plugins?.nowledgeMem?.settings, enabled: false },
      });
      await expect(call(service)).rejects.toMatchObject({
        code: "run_revoked",
      });
      expect(calls).toBe(1);
    });
  },
);
