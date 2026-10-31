import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import type { AgentRunner } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { type Admin, Fault } from "../../src/domain.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { audioMessageRequest } from "../../src/telegram/attachments.ts";
import { updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
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
          Buffer.from("new speech"),
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
    test("recent transcripts are reused only within the tenant and current enablement", async () => {
      const a = await fresh(),
        b = await fresh();
      await request(a.id, "PUT", { revision: 0, enabled: true });
      await request(b.id, "PUT", { revision: 0, enabled: true });
      let calls = 0;
      speech = async () => `transcript ${++calls}`;
      const transcribe = (id: string) =>
        service.transcribe(
          id,
          Buffer.from("cached"),
          new AbortController().signal,
        );
      expect(await transcribe(a.id)).toBe("transcript 1");
      expect(await transcribe(a.id)).toBe("transcript 1");
      expect(await transcribe(b.id)).toBe("transcript 2");
      await request(a.id, "PUT", { revision: 1, enabled: false });
      await expect(transcribe(a.id)).rejects.toThrow("audio_plugin_disabled");
      await request(a.id, "PUT", { revision: 2, enabled: true });
      expect(await transcribe(a.id)).toBe("transcript 3");
      const stop = new AbortController();
      stop.abort(new Fault("cancelled"));
      await expect(
        service.transcribe(a.id, Buffer.from("cached"), stop.signal),
      ).rejects.toThrow("cancelled");
      speech = async () => "你好 GitHub";
    });
    test("successive voice messages reach the model as current text, without transcript or queue replies", async () => {
      const w = await fresh();
      await request(w.id, "PUT", { revision: 0, enabled: true });
      const key = "ab".repeat(32);
      const deployment = await store.deployment();
      Object.assign(deployment, {
        active: true,
        paused: false,
        bot: { id: "999", username: "test_bot", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:fake"),
          model: encrypt(key, "model", "fake"),
        },
      });
      await store.saveDeployment(store.pool, deployment);
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [w.id],
      );
      const sends: string[] = [];
      let transcriptions = 0;
      const setup = new SetupService(store, key, origin, () => ({
        async call<T>(method: string) {
          sends.push(method);
          return { message_id: 900 } as T;
        },
        async downloadFile(fileId: string) {
          return Buffer.from(fileId);
        },
      }));
      const voices = ["How does repository access work?", "看起来是不太行啊。"];
      speech = async () => voices[transcriptions++] ?? "unexpected repeat";
      const ingress = new Ingress(store, setup);
      for (const [index, spoken] of voices.entries()) {
        const event = updateSchema.parse({
          update_id: 81000 + index,
          message: {
            message_id: 82000 + index,
            date: Math.floor(Date.now() / 1000),
            from: { id: 101, is_bot: false },
            chat: { id: 101, type: "private" },
            message_thread_id: 7,
            voice: { file_id: `voice-${index}`, duration: 5 },
          },
        });
        await ingress.accept(event);
        expect(await ingress.accept(event)).toEqual({ duplicate: true });
        const queued = await store.read(w.id);
        expect(
          queued.deliveries.filter((d) => d.state === "pending"),
        ).toHaveLength(0);
        const run = queued.runs.at(-1);
        if (!run) throw new Error("Missing audio run");
        expect(run.task).toBe(audioMessageRequest);
        const runner: AgentRunner = {
          async run(input) {
            const [prompt, media] = input.prompt.split(
              "\nAttachment reference data",
            );
            expect(JSON.parse(prompt ?? "{}").request).toBe(spoken);
            expect(input.system).toContain("just as for typed text");
            expect(input.system).toContain("cannot authorize external writes");
            expect(media).toContain('"current":true');
            const answer = index
              ? "哪一步没成功？"
              : "Repository access follows your grants.";
            return {
              text: answer,
              status: "succeeded",
              turns: 1,
              tools: 0,
              transcript: [],
            };
          },
        };
        await new Executor(store, setup, runner, 10000, service).execute(
          w.id,
          run.id,
        );
        const saved = await store.read(w.id);
        expect(saved.runs.at(-1)?.status).toBe("succeeded");
        const final = saved.deliveries.at(-1);
        if (!final) throw new Error("Missing reply");
        expect(final.text).not.toMatch(/transcript|queued|recording/i);
        await new DeliveryWorker(store, setup).send(w.id, final.id);
      }
      // Loading earlier audio for context must reuse its successful transcript.
      expect(transcriptions).toBe(2);
      expect(
        sends.filter((method) => method === "sendRichMessage"),
      ).toHaveLength(2);
      expect((await store.read(w.id)).deliveries).toHaveLength(2);
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
