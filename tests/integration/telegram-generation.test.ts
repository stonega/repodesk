import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { AgentRunner } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { queuedRunFeedback } from "../../src/telegram/feedback.ts";
import { TelegramPoller } from "../../src/telegram/polling.ts";
import { type Update, updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { createRun, deliver } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "native Telegram Stop (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `deepx_stop_${randomUUID().replaceAll("-", "")}`;
    const key = "af".repeat(32);
    const operatorId = randomUUID();
    let store: Store;
    let setup: SetupService;
    let ingress: Ingress;
    let calls: { method: string; params: Record<string, unknown> }[] = [];
    let updates: Update[] = [];
    let sequence = 70000;
    const telegram: Telegram = {
      async call<T>(method: string, params = {}) {
        calls.push({ method, params });
        return (
          method === "getUpdates"
            ? updates
            : method === "getWebhookInfo"
              ? { url: "" }
              : { message_id: 10 }
        ) as T;
      },
    };
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const url = new URL(rootUrl ?? "");
      url.pathname = `/${name}`;
      store = new Store(database(url.toString()));
      await migrate(store.pool);
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'operator','unused',true)",
        [operatorId],
      );
      setup = new SetupService(
        store,
        key,
        "http://localhost:3000",
        () => telegram,
      );
      ingress = new Ingress(store, setup);
    });
    beforeEach(async () => {
      calls = [];
      updates = [];
      const d = await store.deployment();
      Object.assign(d, {
        active: true,
        paused: false,
        bot: { id: "999", username: "test_bot", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:fake"),
          model: encrypt(key, "model", "fake"),
          webhook: encrypt(key, "webhook", "test-secret"),
        },
      });
      await store.saveDeployment(store.pool, d);
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function seed() {
      const w = workspace();
      w.operatorId = operatorId;
      const run = createRun(w, "101", "hello", "101", 7, "gpt-4.1-mini");
      run.status = "running";
      run.fence = 1;
      run.telegramDraft = { id: ++sequence, botId: "999", fence: 1 };
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      return { w, run };
    }
    function stop(
      draftId: number,
      patch: Partial<NonNullable<Update["stopped_message_generation"]>> = {},
    ): Update {
      return updateSchema.parse({
        update_id: ++sequence,
        stopped_message_generation: {
          chat: { id: 101, type: "private" },
          message_thread_id: 7,
          draft_id: draftId,
          ...patch,
        },
      });
    }
    test("a long private queue wait offers inline status and cancellation through ingress", async () => {
      const f = await seed();
      await store.change(f.w.id, (w) => {
        const r = w.runs.find((r) => r.id === f.run.id);
        if (!r) throw new Error("Missing queue fixture");
        r.status = "queued";
        r.at = new Date(Date.now() - 31000).toISOString();
        queuedRunFeedback(w);
      });
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [f.w.id],
      );
      const queued = (await store.read(f.w.id)).deliveries.find(
        (d) => d.id === `run:${f.run.id}:queued`,
      );
      if (!queued?.buttons?.[0]?.[0] || !queued.buttons[0][1])
        throw new Error("Missing queue buttons");
      await new DeliveryWorker(store, setup).send(f.w.id, queued.id);
      const tap = (data: string): Update => ({
        update_id: ++sequence,
        callback_query: {
          id: `queue-${sequence}`,
          from: { id: 101, is_bot: false },
          data,
          message: {
            message_id: 10,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 101, type: "private" },
            message_thread_id: 7,
          },
        },
      });
      await ingress.accept(tap(queued.buttons[0][0].callback_data));
      expect((await store.read(f.w.id)).deliveries.at(-1)?.text).toContain(
        "Queued",
      );
      await ingress.accept(tap(queued.buttons[0][1].callback_data));
      const stopped = (await store.read(f.w.id)).runs.find(
        (r) => r.id === f.run.id,
      );
      expect(stopped?.status).toBe("cancelled");
      expect(stopped?.stopConfirmed).toBe(true);
      expect(
        calls
          .filter((c) => c.method === "answerCallbackQuery")
          .map((c) => c.params.text),
      ).toEqual(["", ""]);
    });
    test("requests stream natively without queue replies and persist one final answer", async () => {
      for (const text of [
        "Hello",
        "/ask Hello",
        "/recap",
        "/correct once Shorter",
      ])
        for (const privateChat of [true, false]) {
          if (!privateChat && text === "Hello") continue;
          calls = [];
          const { w, run } = await seed();
          const chatId = privateChat ? "101" : "-100100";
          await store.change(w.id, (v) => {
            if (v.runs[0]) v.runs[0].status = "succeeded";
            const priorId = deliver(v, "101", chatId, "Previous answer", {
              runId: run.id,
              topicId: 7,
            });
            const prior = v.deliveries.find((d) => d.id === priorId);
            if (!prior) throw Error("missing prior delivery");
            prior.state = "sent";
            prior.remoteId = 50;
          });
          await store.pool.query(
            "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
            [w.id],
          );
          if (!privateChat)
            await store.pool.query(
              "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id",
              [chatId, w.id],
            );
          const event = updateSchema.parse({
            update_id: ++sequence,
            message: {
              message_id: ++sequence,
              date: Math.floor(Date.now() / 1000),
              from: { id: 101, is_bot: false },
              chat: {
                id: Number(chatId),
                type: privateChat ? "private" : "supergroup",
              },
              message_thread_id: 7,
              text,
              entities: text.startsWith("/")
                ? [
                    {
                      type: "bot_command",
                      offset: 0,
                      length: text.split(" ")[0]?.length,
                    },
                  ]
                : [],
              reply_to_message: { message_id: 50 },
            },
          });
          await ingress.accept(event);
          expect(await ingress.accept(event)).toEqual({ duplicate: true });
          const queued = await store.read(w.id);
          expect(queued.runs).toHaveLength(2);
          expect(queued.deliveries).toHaveLength(1);
          const next = queued.runs[1];
          if (!next) throw Error("missing run");
          const answer = `Answer [source:${next.sources[0]?.id}]`;
          const runner: AgentRunner = {
            async run(input) {
              expect(calls.map((c) => c.method)).toEqual(
                privateChat ? ["sendMessageDraft"] : [],
              );
              if (privateChat) expect(calls[0]?.params.text).toBe("");
              await input.preview?.(answer);
              return {
                text: answer,
                status: "succeeded",
                turns: 1,
                tools: 0,
                transcript: [],
              };
            },
          };
          await new Executor(store, setup, runner).execute(w.id, next.id);
          const saved = await store.read(w.id);
          expect(saved.runs[1]?.status).toBe("succeeded");
          expect(saved.deliveries).toHaveLength(2);
          const final = saved.deliveries[1];
          if (!final) throw Error("missing final delivery");
          expect(final.text).toBe(
            `${next.threadNotice ? `${next.threadNotice}\n\n` : ""}${answer}`,
          );
          const delivery = new DeliveryWorker(store, setup);
          await delivery.send(w.id, final.id);
          await delivery.send(w.id, final.id);
          expect(calls.map((c) => c.method)).toEqual(
            privateChat
              ? ["sendMessageDraft", "sendRichMessageDraft", "sendRichMessage"]
              : ["sendRichMessage"],
          );
          if (privateChat)
            expect(calls[1]?.params.draft_id).toBe(calls[0]?.params.draft_id);
        }
    });
    test("Stop uses persisted tenant/run binding despite workspace selection changes and duplicate events", async () => {
      const a = await seed();
      const b = await seed();
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [b.w.id],
      );
      const event = stop(a.run.telegramDraft?.id ?? 0);
      const freshIngress = new Ingress(new Store(store.pool), setup);
      expect(await freshIngress.accept(event)).toEqual({ accepted: true });
      expect(await freshIngress.accept(event)).toEqual({ duplicate: true });
      await freshIngress.accept({ ...event, update_id: ++sequence });
      const saved = await store.read(a.w.id);
      expect(saved.runs[0]).toMatchObject({
        status: "cancelled",
        cancelled: true,
      });
      expect(
        saved.audit.filter((e) => e.action === "run.cancelled"),
      ).toHaveLength(1);
      expect((await store.read(b.w.id)).runs[0]?.status).toBe("running");
      expect(calls).toHaveLength(0);
    });
    test("Stop rejects wrong actor, topic, bot, draft, stale fence, revoked access and group events", async () => {
      for (const mode of [
        "actor",
        "topic",
        "bot",
        "draft",
        "fence",
        "revoked",
        "group",
        "collision",
      ]) {
        const { w, run } = await seed();
        const event = stop(run.telegramDraft?.id ?? 0);
        const payload = event.stopped_message_generation;
        if (!payload) throw Error();
        if (mode === "actor") payload.chat.id = 202;
        if (mode === "topic") payload.message_thread_id = 8;
        if (mode === "draft") payload.draft_id = -999;
        if (mode === "group")
          payload.chat = { id: -100100, type: "supergroup" };
        await store.change(w.id, (v) => {
          const r = v.runs[0];
          if (!r?.telegramDraft) throw Error();
          if (mode === "bot") r.telegramDraft.botId = "888";
          if (mode === "fence") r.fence++;
          if (mode === "revoked")
            v.members.forEach((member) => {
              member.active = false;
            });
        });
        if (mode === "collision") {
          const other = await seed();
          await store.change(other.w.id, (v) => {
            if (v.runs[0]) v.runs[0].telegramDraft = run.telegramDraft;
          });
        }
        expect(await ingress.accept(event)).toEqual({ ignored: true });
        expect((await store.read(w.id)).runs[0]?.status).toBe("running");
      }
    });
    test("Stop cancels a completed but pending reply, works while paused, and ignores a sent reply", async () => {
      for (const sent of [false, true]) {
        const { w, run } = await seed();
        await store.change(w.id, (v) => {
          if (v.runs[0]) v.runs[0].status = "succeeded";
          deliver(v, "101", "101", "Done", {
            id: `run:${run.id}:result`,
            runId: run.id,
            format: "rich",
          });
          if (sent && v.deliveries[0]) v.deliveries[0].state = "sent";
          // A previously sent tool/approval message must not block stopping the final answer.
          deliver(v, "101", "101", "Earlier status", { runId: run.id });
          if (v.deliveries[1]) v.deliveries[1].state = "sent";
          v.settings.paused = true;
        });
        const d = await store.deployment();
        d.paused = true;
        await store.saveDeployment(store.pool, d);
        await ingress.accept(stop(run.telegramDraft?.id ?? 0));
        const saved = await store.read(w.id);
        expect(saved.runs[0]?.cancelled).toBe(!sent);
        expect(saved.deliveries[0]?.state).toBe(sent ? "sent" : "cancelled");
      }
    });
    test("Stop aborts the running executor and retains unknown provider reservations", async () => {
      const { w, run } = await seed();
      await store.change(w.id, (v) => {
        if (v.runs[0]) v.runs[0].status = "queued";
      });
      const runner: AgentRunner = {
        async run(input) {
          await input.reserve(0.001);
          await input.preview?.("Working");
          const draft = calls.find((c) => c.method === "sendRichMessageDraft");
          expect(draft?.params.can_stop).toBe(true);
          expect(draft?.params.keep_on_stop).toBe(false);
          expect(draft?.params.draft_id).not.toBe(run.telegramDraft?.id);
          await ingress.accept(stop(Number(draft?.params.draft_id)));
          if (!input.signal.aborted)
            await new Promise<void>((resolve) =>
              input.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          input.signal.throwIfAborted();
          throw Error("expected cancellation");
        },
      };
      await new Executor(store, setup, runner).execute(w.id, run.id);
      await new Executor(store, setup, runner).execute(w.id, run.id);
      const saved = await store.read(w.id);
      expect(saved.runs[0]).toMatchObject({
        status: "cancelled",
        error: "cancelled",
      });
      expect(saved.runs[0]?.attempts[0]?.status).toBe("unknown");
      expect(saved.deliveries).toHaveLength(2);
      expect(saved.deliveries.at(-1)?.text).toContain("has stopped");
      expect(
        saved.deliveries.every((d) => d.cancellationRunId === run.id),
      ).toBe(true);
      expect(calls.map((c) => c.method)).toEqual([
        "sendMessageDraft",
        "sendRichMessageDraft",
      ]);
    });
    test("authenticated webhooks and polling accept native Stop, including explicit allowed_updates", async () => {
      const first = await seed();
      const app = createApp(store, setup, "http://localhost:3000");
      const event = stop(first.run.telegramDraft?.id ?? 0);
      const request = (secret: string) =>
        app.request("/telegram/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secret,
          },
          body: JSON.stringify(event),
        });
      expect((await request("wrong")).status).toBe(401);
      expect((await store.read(first.w.id)).runs[0]?.cancelled).toBe(false);
      expect((await request("test-secret")).status).toBe(200);
      expect((await store.read(first.w.id)).runs[0]?.cancelled).toBe(true);
      const second = await seed();
      updates = [stop(second.run.telegramDraft?.id ?? 0)];
      const pollingSetup = new SetupService(
        store,
        key,
        "http://localhost:3000",
        () => telegram,
        "polling",
      );
      await new TelegramPoller(store, pollingSetup).pollOnce(
        new AbortController().signal,
      );
      expect((await store.read(second.w.id)).runs[0]?.cancelled).toBe(true);
      expect(
        calls.find((c) => c.method === "getUpdates")?.params.allowed_updates,
      ).toContain("stopped_message_generation");
      // No final publication can be revived by a late delivery job.
      for (const delivery of (await store.read(second.w.id)).deliveries)
        await new DeliveryWorker(store, setup).send(second.w.id, delivery.id);
    });
  },
);
