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
import { applicationTools } from "../../src/agent/tools.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Run, Workspace } from "../../src/domain.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { type Telegram, TelegramError } from "../../src/telegram/client.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { createRun, deliver } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "native Telegram reactions (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `reactions_${randomUUID().replaceAll("-", "")}`;
    const key = "bd".repeat(32);
    let store: Store, setup: SetupService, w: Workspace, r: Run;
    let calls: { method: string; params: Record<string, unknown> }[];
    let failure: TelegramError | undefined;
    let sequence = 10000;
    const telegram: Telegram = {
      async call<T>(method: string, params = {}) {
        calls.push({ method, params });
        if (method === "setMessageReaction" && failure) throw failure;
        return (
          method === "setMessageReaction" ? true : { message_id: ++sequence }
        ) as T;
      },
    };
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const url = new URL(rootUrl ?? "");
      url.pathname = `/${name}`;
      store = new Store(database(url.toString()));
      await migrate(store.pool);
      setup = new SetupService(
        store,
        key,
        "http://localhost:3000",
        () => telegram,
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    beforeEach(async () => {
      calls = [];
      failure = undefined;
      w = workspace();
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
        [w.operatorId, `reaction-${w.operatorId}`],
      );
      const deployment = await store.deployment();
      Object.assign(deployment, {
        active: true,
        paused: false,
        bot: { id: "999", username: "test_bot", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:fake"),
          model: encrypt(key, "model", "fake"),
          webhook: encrypt(key, "webhook", "test-secret"),
        },
      });
      await store.saveDeployment(store.pool, deployment);
      r = createRun(
        w,
        "101",
        "Thanks, that worked!",
        "101",
        7,
        "gpt-4.1-mini",
        { replyTo: 42, botId: "999" },
      );
      r.status = "running";
      r.fence = 1;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, w.operatorId, JSON.stringify(w)],
      );
    });
    const reactionId = () => `run:${r.id}:reaction`;
    const react = (currentStore = store) => {
      const tool = applicationTools(currentStore, w.id, r.id, r.fence).find(
        (t) => t.name === "react_to_message",
      );
      if (!tool) throw Error("missing reaction tool");
      return tool;
    };
    const queue = () => react().execute("react", { emoji: "❤️" });

    test("concurrent calls and process restart create one intent and send one native reaction", async () => {
      const first = await Promise.all([
        queue(),
        queue(),
        react().execute("another", { emoji: "❤" }),
      ]);
      expect(first[0]).toEqual(first[1]);
      const restarted = new Store(store.pool);
      expect(await react(restarted).execute("react", { emoji: "❤" })).toEqual(
        first[0],
      );
      expect((await store.read(w.id)).deliveries).toHaveLength(1);
      const worker = new DeliveryWorker(restarted, setup);
      await Promise.all([
        worker.send(w.id, reactionId()),
        worker.send(w.id, reactionId()),
      ]);
      await worker.send(w.id, reactionId());
      expect(calls).toEqual([
        {
          method: "setMessageReaction",
          params: {
            chat_id: "101",
            message_id: 42,
            reaction: [{ type: "emoji", emoji: "❤" }],
            is_big: false,
          },
        },
      ]);
      expect((await store.read(w.id)).deliveries[0]).toMatchObject({
        state: "sent",
        attempts: 1,
      });
      expect((await store.read(w.id)).deliveries[0]?.remoteId).toBeUndefined();
    });

    test("ordinary private/group requests retain their final reply and deduplicate Telegram events", async () => {
      for (const chatId of ["101", "-100100"]) {
        calls = [];
        await store.change(w.id, (v) => {
          if (v.runs[0]) v.runs[0].status = "succeeded";
        });
        await store.pool.query(
          "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
          [w.id],
        );
        if (chatId !== "101")
          await store.pool.query(
            "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id",
            [chatId, w.id],
          );
        const ingress = new Ingress(store, setup);
        const event = {
          update_id: ++sequence,
          message: {
            message_id: ++sequence,
            date: Math.floor(Date.now() / 1000),
            from: { id: 101, is_bot: false },
            chat: {
              id: Number(chatId),
              type:
                chatId === "101"
                  ? ("private" as const)
                  : ("supergroup" as const),
            },
            message_thread_id: 7,
            text: "/ask Thanks, that worked!",
            entities: [{ type: "bot_command", offset: 0, length: 4 }],
          },
        };
        expect(await ingress.accept(event)).toEqual({ accepted: true });
        expect(await ingress.accept(event)).toEqual({ duplicate: true });
        const next = (await store.read(w.id)).runs.at(-1);
        if (!next) throw Error("missing run");
        const runner: AgentRunner = {
          async run(input) {
            const tool = input.tools.find((t) => t.name === "react_to_message");
            if (!tool) throw Error("missing reaction tool in executor");
            expect(
              JSON.stringify(
                await tool.execute("natural-reaction", { emoji: "🎉" }),
              ),
            ).toContain("queued");
            return {
              text: "Glad it worked!",
              status: "succeeded",
              turns: 1,
              tools: 1,
              transcript: [],
            };
          },
        };
        await new Executor(store, setup, runner).execute(w.id, next.id);
        const saved = await store.read(w.id);
        expect(saved.runs.at(-1)?.status).toBe("succeeded");
        const worker = new DeliveryWorker(store, setup);
        await worker.send(w.id, `run:${next.id}:reaction`);
        await worker.send(w.id, `run:${next.id}:result`);
        expect(calls.filter((c) => c.method === "setMessageReaction")).toEqual([
          {
            method: "setMessageReaction",
            params: {
              chat_id: chatId,
              message_id: event.message.message_id,
              reaction: [{ type: "emoji", emoji: "🎉" }],
              is_big: false,
            },
          },
        ]);
        expect(
          calls.filter((c) => c.method === "sendRichMessage"),
        ).toHaveLength(1);
      }
    });

    test("revocation, deleted sources, inactive groups and bot rotation cancel queued reactions", async () => {
      for (const mode of [
        "membership",
        "source",
        "topic",
        "bot",
        "cancel",
        "failed",
        "group",
      ]) {
        const baseline = await store.read(w.id);
        if (mode === "group") {
          await store.change(w.id, (v) => {
            r = createRun(v, "101", "Thanks!", "-100100", 7, "gpt-4.1-mini", {
              botId: "999",
              replyTo: 43,
            });
            r.status = "running";
            r.fence = 1;
          });
        }
        await queue();
        await store.change(w.id, (v) => {
          const run = v.runs.find((run) => run.id === r.id);
          if (!run) throw Error("missing run");
          if (mode === "membership")
            v.members.forEach((m) => {
              m.active = false;
            });
          if (mode === "source") v.messages = [];
          if (mode === "topic") run.topicId = 8;
          if (mode === "cancel") run.cancelled = true;
          if (mode === "failed") run.status = "failed";
          if (mode === "group") {
            v.chats = [];
          }
        });
        if (mode === "bot") {
          const d = await store.deployment();
          if (d.bot) d.bot.id = "888";
          await store.saveDeployment(store.pool, d);
        }
        await new DeliveryWorker(store, setup).send(w.id, reactionId());
        expect((await store.read(w.id)).deliveries[0]?.state).toBe("cancelled");
        expect(calls).toHaveLength(0);
        await store.save(store.pool, baseline);
        const original = baseline.runs[0];
        if (!original) throw Error("missing original run");
        r = original;
        const d = await store.deployment();
        if (d.bot) d.bot.id = "999";
        await store.saveDeployment(store.pool, d);
      }
    });

    test("sources are checked again after claim immediately before the external reaction", async () => {
      await queue();
      const checkedStore = new Store(store.pool);
      checkedStore.read = async (id, sql, lock) => {
        if (!lock)
          await store.change(id, (v) => {
            v.messages = [];
          });
        return store.read(id, sql, lock);
      };
      await new DeliveryWorker(checkedStore, setup).send(w.id, reactionId());
      expect(calls).toHaveLength(0);
      expect((await store.read(w.id)).deliveries[0]?.state).toBe("failed");
    });

    test("Telegram reaction rejection leaves the final answer deliverable and never sends emoji text as fallback", async () => {
      await queue();
      await store.change(w.id, (v) =>
        deliver(v, "101", "101", "Your answer", {
          id: "answer",
          runId: r.id,
          topicId: 7,
        }),
      );
      failure = new TelegramError("telegram_destination_rejected", "permanent");
      const worker = new DeliveryWorker(store, setup);
      await worker.send(w.id, reactionId());
      await worker.send(w.id, "answer");
      expect(calls.map((c) => c.method)).toEqual([
        "setMessageReaction",
        "sendMessage",
      ]);
      expect((await store.read(w.id)).deliveries.map((d) => d.state)).toEqual([
        "failed",
        "sent",
      ]);
    });

    test("rate limits and uncertain reaction outcomes retry the same choice with bounded attempts", async () => {
      for (const disposition of ["retry", "unknown"] as const) {
        await store.change(w.id, (v) => {
          v.deliveries = [];
          const run = v.runs[0];
          if (run) run.tools = {};
        });
        calls = [];
        await queue();
        failure = new TelegramError(
          disposition === "retry"
            ? "telegram_rate_limited"
            : "telegram_outcome_unknown",
          disposition,
          12,
        );
        const worker = new DeliveryWorker(store, setup);
        for (let attempt = 1; attempt <= 5; attempt++) {
          await worker.send(w.id, reactionId());
          const intent = (await store.read(w.id)).deliveries[0];
          expect(intent?.state).toBe(attempt < 5 ? "pending" : "failed");
          if (attempt < 5)
            expect(
              Date.parse(intent?.nextAt ?? "") - Date.now(),
            ).toBeGreaterThan(10000);
          await store.change(w.id, (v) => {
            if (v.deliveries[0]) v.deliveries[0].nextAt = undefined;
          });
        }
        await worker.send(w.id, reactionId());
        expect(calls).toHaveLength(5);
        expect(new Set(calls.map((c) => JSON.stringify(c.params))).size).toBe(
          1,
        );
      }
    });

    test("successful retry and worker-crash recovery set the same reaction without creating a message", async () => {
      await queue();
      failure = new TelegramError("telegram_outcome_unknown", "unknown");
      const worker = new DeliveryWorker(store, setup);
      await worker.send(w.id, reactionId());
      failure = undefined;
      await store.change(w.id, (v) => {
        const d = v.deliveries[0];
        if (d) d.nextAt = undefined;
      });
      await worker.send(w.id, reactionId());
      expect((await store.read(w.id)).deliveries[0]?.state).toBe("sent");
      await store.change(w.id, (v) => {
        const d = v.deliveries[0];
        if (d) {
          d.state = "sending";
          d.startedAt = new Date(0).toISOString();
        }
      });
      await worker.send(w.id, reactionId());
      expect((await store.read(w.id)).deliveries[0]?.state).toBe("pending");
      await worker.send(w.id, reactionId());
      expect((await store.read(w.id)).deliveries[0]).toMatchObject({
        state: "sent",
        attempts: 3,
      });
      expect(calls.map((c) => c.method)).toEqual([
        "setMessageReaction",
        "setMessageReaction",
        "setMessageReaction",
      ]);
    });
  },
);
