import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { type Admin, Fault } from "../../src/domain.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { ModelStatus } from "../../src/transcription/config.ts";
import { TranscriptionService } from "../../src/transcription/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Qwen3-ASR plugin (isolated PostgreSQL)",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `repodesk_audio_${randomUUID().replaceAll("-", "")}`;
    const origin = "http://localhost:3000";
    let store: Store;
    let service: TranscriptionService;
    let app: ReturnType<typeof createApp>;
    let auth: { raw: string; csrf: string };
    let admin: Admin;
    let preparations = 0;
    let status: ModelStatus = { state: "not_downloaded" };
    let speech: () => Promise<string> = async () => "你好 GitHub";
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const target = new URL(url ?? "");
      target.pathname = `/${name}`;
      store = new Store(database(target.toString()));
      await migrate(store.pool);
      auth = await claim(store.pool, "audiooperator", "audio test password");
      const row = (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='audiooperator'",
        )
      ).rows[0];
      admin = { id: row.id, username: "audiooperator", operator: true };
      service = new TranscriptionService(store, {
        status: async () => status,
        prepare() {
          preparations++;
        },
        transcribe: () => speech(),
      });
      const plugins = new PluginService(
        store,
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
    function request(
      id: string,
      method = "GET",
      body?: unknown,
      suffix = "",
      headers = {},
    ) {
      return app.request(
        `/api/admin/workspaces/${id}/plugins/transcription${suffix}`,
        {
          method,
          headers: {
            cookie: `deepx_session=${auth.raw}`,
            origin,
            "x-csrf-token": auth.csrf,
            "content-type": "application/json",
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
    }
    test("disabled by default; enable downloads, status is readable, disable keeps cached model", async () => {
      const w = await fresh();
      const before = preparations;
      expect((await (await request(w.id)).json()).settings.enabled).toBe(false);
      expect(preparations).toBe(before);
      const enabled = await request(w.id, "PUT", {
        revision: 0,
        enabled: true,
      });
      expect(enabled.status).toBe(200);
      expect(preparations).toBe(before + 1);
      expect((await enabled.json()).revision).toBe(1);
      expect(
        (await request(w.id, "PUT", { revision: 0, enabled: true })).status,
      ).toBe(409);
      expect(preparations).toBe(before + 1);
      status = { state: "ready" };
      expect((await (await request(w.id)).json()).status.state).toBe("ready");
      expect(
        (await request(w.id, "PUT", { revision: 1, enabled: false })).status,
      ).toBe(200);
      const saved = await (await request(w.id)).json();
      expect(saved.settings.enabled).toBe(false);
      expect(saved.status.state).toBe("ready");
      expect(preparations).toBe(before + 1);
      expect(
        (await store.read(w.id)).audit.some(
          (a) => a.action === "plugins.updated",
        ),
      ).toBe(true);
    });
    test("enable/retry enforce operator ownership, CSRF, exact origin and saved revision", async () => {
      const w = await fresh();
      expect(
        (
          await request(w.id, "PUT", { revision: 0, enabled: true }, "", {
            "x-csrf-token": "bad",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(w.id, "PUT", { revision: 0, enabled: true }, "", {
            origin: "https://evil.test",
          })
        ).status,
      ).toBe(403);
      await expect(
        service.view({ ...admin, id: randomUUID() }, w.id),
      ).rejects.toThrow("access_denied");
      await expect(
        service.view({ ...admin, operator: false }, w.id),
      ).rejects.toThrow();
      expect(
        (await request(w.id, "POST", { revision: 0, enabled: true }, "/retry"))
          .status,
      ).toBe(409);
      await request(w.id, "PUT", { revision: 0, enabled: true });
      const before = preparations;
      expect(
        (await request(w.id, "POST", { revision: 0, enabled: true }, "/retry"))
          .status,
      ).toBe(409);
      expect(preparations).toBe(before);
      expect(
        (await request(w.id, "POST", { revision: 1, enabled: true }, "/retry"))
          .status,
      ).toBe(200);
      expect(preparations).toBe(before + 1);
    });
    test("transcripts are tenant scoped and discarded when enablement changes during inference", async () => {
      const a = await fresh(),
        b = await fresh();
      await request(a.id, "PUT", { revision: 0, enabled: true });
      await expect(
        service.transcribe(
          b.id,
          Buffer.from("speech"),
          new AbortController().signal,
        ),
      ).rejects.toThrow("audio_plugin_disabled");
      expect(
        await service.transcribe(
          a.id,
          Buffer.from("speech"),
          new AbortController().signal,
        ),
      ).toBe("你好 GitHub");
      speech = async () => {
        await request(a.id, "PUT", { revision: 1, enabled: false });
        await request(a.id, "PUT", { revision: 2, enabled: true });
        return "revoked transcript";
      };
      await expect(
        service.transcribe(
          a.id,
          Buffer.from("speech"),
          new AbortController().signal,
        ),
      ).rejects.toThrow("run_revoked");
      speech = async () => {
        throw new Fault("audio_model_not_ready");
      };
      await expect(
        service.transcribe(
          a.id,
          Buffer.from("speech"),
          new AbortController().signal,
        ),
      ).rejects.toThrow("audio_model_not_ready");
      speech = async () => "你好 GitHub";
    });
    test("restart reconciliation downloads only for enabled active workspaces lacking weights", async () => {
      const w = await fresh();
      let before = preparations;
      status = { state: "not_downloaded" };
      await service.reconcile(w);
      expect(preparations).toBe(before);
      await request(w.id, "PUT", { revision: 0, enabled: true });
      before = preparations;
      await service.reconcile(await store.read(w.id));
      expect(preparations).toBe(before + 1);
      status = { state: "ready" };
      await service.reconcile(await store.read(w.id));
      expect(preparations).toBe(before + 1);
    });
  },
);
