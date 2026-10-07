import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { PgBoss } from "pg-boss";
import { type AgentRunner, PiRunner } from "../../src/agent/runtime.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { recoverJobs } from "../../src/jobs/recovery.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { type Update, updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "private conversation threads (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `deepx_threads_${randomUUID().replaceAll("-", "")}`;
    const key = "af".repeat(32);
    const operatorId = randomUUID();
    let store: Store;
    let setup: SetupService;
    let ingress: Ingress;
    let calls: { method: string; params: Record<string, unknown> }[] = [];
    let updates: Update[] = [];
    let sequence = 70000;
    let downloads: string[] = [];
    let files = new Map<string, Uint8Array>();
    let onDownload: (() => Promise<void>) | undefined;
    const telegram: Telegram = {
      async downloadFile(fileId) {
        downloads.push(fileId);
        await onDownload?.();
        const bytes = files.get(fileId);
        if (!bytes) throw Error("missing fixture file");
        return bytes;
      },
      async call<T>(method: string, params = {}) {
        calls.push({ method, params });
        return (
          method === "getUpdates"
            ? updates
            : method === "getWebhookInfo"
              ? { url: "" }
              : { message_id: ++sequence }
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
      downloads = [];
      files = new Map();
      onDownload = undefined;
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

      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [w.id],
      );
      return w;
    }
    function message(text: string, replyTo?: number, topicId = 0): Update {
      return updateSchema.parse({
        update_id: ++sequence,
        message: {
          message_id: ++sequence,
          date: Math.floor(Date.now() / 1000),
          from: { id: 101, is_bot: false },
          chat: { id: 101, type: "private" },
          message_thread_id: topicId || undefined,
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
          reply_to_message: replyTo
            ? { message_id: replyTo, from: { id: 999, is_bot: true } }
            : undefined,
        },
      });
    }
    test("captionless photos deduplicate, stay in their topic and reach the model as images", async () => {
      const w = await seed();
      const update = message("", undefined, 21);
      if (!update.message) throw Error("missing message");
      delete update.message.text;
      update.message.photo = [{ file_id: "photo", width: 1, height: 1 }];
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNFEAAAAASUVORK5CYII=",
        "base64",
      );
      files.set("photo", bytes);
      await ingress.accept(update);
      expect(await ingress.accept(update)).toEqual({ duplicate: true });
      expect(downloads).toEqual([]);
      const run = (await store.read(w.id)).runs[0];
      if (!run) throw Error("missing photo run");
      expect(run.sources[0]?.attachments?.[0]).toMatchObject({
        botId: "999",
        fileId: "photo",
      });
      expect(run.topicId).toBe(21);
      let called = 0;
      await new Executor(store, setup, {
        async run(input) {
          called++;
          expect(input.images).toEqual([
            {
              type: "image",
              mimeType: "image/png",
              data: bytes.toString("base64"),
            },
          ]);
          expect(input.prompt).toContain('"imageIndex":1');
          return {
            text: "Image received",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      }).execute(w.id, run.id);
      expect(called).toBe(1);
      expect(downloads).toEqual(["photo"]);
      const saved = await store.read(w.id);
      expect(saved.runs).toHaveLength(1);
      expect(saved.deliveries.find((d) => d.runId === run.id)?.topicId).toBe(
        21,
      );
      const document = message("", undefined, 21);
      if (!document.message) throw Error("missing document");
      delete document.message.text;
      document.message.caption = "/ask explain this code";
      document.message.caption_entities = [
        { type: "bot_command", offset: 0, length: 4 },
      ];
      document.message.document = {
        file_id: "code",
        mime_type: "text/plain",
        file_name: "app.ts",
      };
      files.set("code", Buffer.from("export const answer = 42;"));
      await ingress.accept(document);
      const next = (await store.read(w.id)).runs[1];
      if (!next) throw Error("missing document run");
      expect(next.threadId).toBe(run.threadId);
      expect(next.task).toBe("explain this code");
      await new Executor(store, setup, {
        async run(input) {
          expect(input.prompt).toContain("export const answer = 42;");
          expect(input.prompt).toContain("app.ts");
          return {
            text: "It exports 42",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      }).execute(w.id, next.id);
      expect((await store.read(w.id)).runs[1]?.status).toBe("succeeded");
    });

    test("media from denied actors is ignored, and queued/during-download revocation blocks model input", async () => {
      const w = await seed();
      const update = message("", undefined, 22);
      if (!update.message) throw Error("missing message");
      delete update.message.text;
      update.message.document = { file_id: "notes", mime_type: "text/plain" };
      files.set("notes", Buffer.from("private attachment"));
      await store.change(w.id, (w) => {
        w.members.forEach((member) => {
          member.active = false;
        });
      });
      await ingress.accept(update);
      expect((await store.read(w.id)).runs).toHaveLength(0);
      expect((await store.read(w.id)).messages).toHaveLength(0);
      expect(downloads).toEqual([]);
      await store.change(w.id, (w) => {
        w.members.forEach((member) => {
          member.active = member.id === "101";
        });
      });
      update.update_id = ++sequence;
      await ingress.accept(update);
      const run = (await store.read(w.id)).runs[0];
      if (!run) throw Error("missing run");
      let called = false;
      const runner: AgentRunner = {
        async run() {
          called = true;
          throw Error("must not dispatch");
        },
      };
      await store.change(w.id, (w) => {
        w.members.forEach((member) => {
          member.active = false;
        });
      });
      await new Executor(store, setup, runner).execute(w.id, run.id);
      expect(downloads).toEqual([]);
      expect(called).toBe(false);
      await store.change(w.id, (w) => {
        w.members.forEach((member) => {
          member.active = member.id === "101";
        });
      });
      const during = message("", undefined, 23);
      if (!during.message) throw Error("missing message");
      delete during.message.text;
      during.message.document = update.message.document;
      await ingress.accept(during);
      const next = (await store.read(w.id)).runs[1];
      if (!next) throw Error("missing next run");
      onDownload = async () => {
        await store.change(w.id, (w) => {
          w.members.forEach((member) => {
            member.active = false;
          });
        });
      };
      await new Executor(store, setup, runner).execute(w.id, next.id);
      expect(downloads).toEqual(["notes"]);
      expect(called).toBe(false);
      expect((await store.read(w.id)).runs[1]?.error).toBe("run_revoked");
      expect(
        (await store.read(w.id)).deliveries.some((d) => d.runId === next.id),
      ).toBe(false);
    });

    test("group caption mentions retain media while unaddressed media stays quiet", async () => {
      const w = await seed();
      await store.pool.query(
        "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES('-100100',$1) ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id",
        [w.id],
      );
      const update = message("", undefined, 24);
      if (!update.message) throw Error("missing message");
      delete update.message.text;
      update.message.chat = { id: -100100, type: "supergroup" };
      update.message.document = {
        file_id: "group-notes",
        mime_type: "text/plain",
      };
      await ingress.accept(update);
      expect((await store.read(w.id)).messages).toHaveLength(0);
      expect((await store.read(w.id)).runs).toHaveLength(0);
      update.update_id = ++sequence;
      update.message.caption = "@test_bot explain this file";
      update.message.caption_entities = [
        { type: "mention", offset: 0, length: 9 },
      ];
      files.set("group-notes", Buffer.from("Group release notes"));
      await ingress.accept(update);
      const run = (await store.read(w.id)).runs[0];
      if (!run) throw Error("missing group run");
      expect(run.task).toBe("explain this file");
      await new Executor(store, setup, {
        async run(input) {
          expect(input.prompt).toContain("Group release notes");
          return {
            text: "Release notes received",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      }).execute(w.id, run.id);
      expect((await store.read(w.id)).runs[0]?.status).toBe("succeeded");
      expect(downloads).toEqual(["group-notes"]);
    });

    test("unsupported files get clear feedback and do not block the next topic request", async () => {
      const w = await seed();
      const update = message("", undefined, 25);
      if (!update.message) throw Error("missing message");
      delete update.message.text;
      update.message.document = {
        file_id: "zip",
        mime_type: "application/zip",
      };
      files.set("zip", Buffer.from("PK"));
      await ingress.accept(update);
      const run = (await store.read(w.id)).runs[0];
      if (!run) throw Error("missing run");
      await new Executor(store, setup, {
        async run() {
          throw Error("unsupported file reached model");
        },
      }).execute(w.id, run.id);
      let saved = await store.read(w.id);
      expect(saved.runs[0]?.error).toBe("attachment_unsupported");
      expect(saved.deliveries.find((d) => d.runId === run.id)?.text).toContain(
        "UTF-8 text/code files",
      );
      expect(saved.runs[0]?.attempts).toHaveLength(0);
      await ingress.accept(message("Hello", undefined, 25));
      const next = (await store.read(w.id)).runs[1];
      if (!next) throw Error("missing next run");
      await new Executor(store, setup, {
        async run(input) {
          expect(input.prompt).toContain("unavailable");
          return {
            text: "Hello",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      }).execute(w.id, next.id);
      saved = await store.read(w.id);
      expect(saved.runs[1]?.status).toBe("succeeded");
    });

    test("ingress persists separate threads and resumes replies after restart without duplicates", async () => {
      const w = await seed();
      const first = message("Kyoto trip");
      await ingress.accept(first);
      expect(await ingress.accept(first)).toEqual({ duplicate: true });
      const a = (await store.read(w.id)).runs[0];
      if (!a) throw Error("missing first run");
      const runner: AgentRunner = {
        async run(input) {
          expect(input.transcript).toEqual([]);
          expect(input.prompt).toContain("Kyoto trip");
          return {
            text: "Visit Kyoto temples",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };
      await new Executor(store, setup, runner).execute(w.id, a.id);
      const intent = (await store.read(w.id)).deliveries.find(
        (d) => d.runId === a.id,
      );
      if (!intent) throw Error("missing delivery");
      await new DeliveryWorker(store, setup).send(w.id, intent.id);
      expect(calls.at(-1)?.params.reply_parameters).toEqual({
        message_id: first.message?.message_id,
        allow_sending_without_reply: true,
      });
      const sent = (await store.read(w.id)).deliveries.find(
        (d) => d.id === intent.id,
      );
      const fresh = new Ingress(new Store(store.pool), setup);
      await fresh.accept(message("Debug server"));
      await fresh.accept(message("More temples", sent?.remoteId));
      await fresh.accept(message("Vegetarian food", first.message?.message_id));
      const beforeHelp = (await store.read(w.id)).threads?.length;
      await fresh.accept(message("/help"));
      const saved = await store.read(w.id);
      expect(saved.runs).toHaveLength(4);
      expect(saved.threads).toHaveLength(2);
      expect(saved.threads?.length).toBe(beforeHelp);
      expect(saved.runs[1]?.threadId).not.toBe(a.threadId);
      expect(saved.runs[1]?.sources.map((m) => m.text)).toEqual([
        "Debug server",
      ]);
      expect(saved.runs[2]?.threadId).toBe(a.threadId);
      expect(saved.runs[3]?.threadId).toBe(a.threadId);
      expect(saved.runs[2]?.sources.map((m) => m.text)).toEqual([
        "Kyoto trip",
        "Visit Kyoto temples",
        "More temples",
      ]);
    });
    test("native topics persist across ingress instances and keep previews, replies and commands in their topic", async () => {
      const w = await seed();
      const first = message("Kyoto trip", undefined, 10);
      const next = message("Add restaurants", undefined, 10);
      await Promise.all([ingress.accept(first), ingress.accept(first)]);
      const a = (await store.read(w.id)).runs[0];
      if (!a) throw Error("missing run");
      const runner: AgentRunner = {
        async run(input) {
          await input.preview?.("Visit temples");
          return {
            text: "Visit temples",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };
      await new Executor(store, setup, runner).execute(w.id, a.id);
      const intent = (await store.read(w.id)).deliveries.find(
        (d) => d.runId === a.id,
      );
      if (!intent) throw Error("missing delivery");
      await new DeliveryWorker(store, setup).send(w.id, intent.id);
      expect(calls.map((c) => c.method)).toEqual([
        "sendMessageDraft",
        "sendRichMessageDraft",
        "sendRichMessage",
      ]);
      expect(calls.every((c) => c.params.message_thread_id === 10)).toBe(true);
      expect(calls.at(-1)?.params.reply_parameters).toMatchObject({
        message_id: first.message?.message_id,
      });
      const fresh = new Ingress(new Store(store.pool), setup);
      await fresh.accept(next);
      await fresh.accept(
        message("Debug server", first.message?.message_id, 20),
      );
      await fresh.accept(message("More temples", 999999, 10));
      await fresh.accept(message("/recap", undefined, 10));
      await fresh.accept(message("/help", undefined, 10));
      const saved = await store.read(w.id);
      expect(saved.runs).toHaveLength(5);
      expect(saved.threads).toHaveLength(2);
      expect(saved.threads?.find((t) => t.id === a.threadId)?.topicId).toBe(10);
      expect(saved.runs[1]?.threadId).toBe(a.threadId);
      expect(saved.runs[1]?.sources.map((s) => s.text)).toEqual([
        "Kyoto trip",
        "Visit temples",
        "Add restaurants",
      ]);
      expect(saved.runs[2]?.threadId).not.toBe(a.threadId);
      expect(saved.runs[2]?.sources.map((s) => s.text)).toEqual([
        "Debug server",
      ]);
      expect(saved.runs[3]?.threadId).toBe(a.threadId);
      expect(saved.runs[4]?.threadId).toBe(a.threadId);
      expect(saved.runs.every((r) => !r.threadNotice)).toBe(true);
      expect(saved.deliveries.at(-1)).toMatchObject({ topicId: 10 });
      expect(saved.deliveries.at(-1)?.text).toContain("Telegram Topics");
    });
    test.each([0, 10])(
      "same-thread requests wait in insertion order while unrelated threads execute (topic %i)",
      async (topicId) => {
        const w = await seed();
        const first = message("First", undefined, topicId);
        await ingress.accept(first);
        await ingress.accept(
          message(
            "Second",
            topicId ? undefined : first.message?.message_id,
            topicId,
          ),
        );
        await ingress.accept(message("Unrelated", undefined, topicId ? 20 : 0));
        const queued = (await store.read(w.id)).runs;
        const [a, b, c] = queued;
        if (!a || !b || !c) throw Error("missing runs");
        const seen: string[] = [];
        const runner: AgentRunner = {
          async run(input) {
            seen.push(input.runId);
            if (input.runId === b.id) {
              expect(input.prompt).toContain("First answer");
              expect(input.prompt).not.toContain("Unrelated");
            }
            return {
              text: input.runId === a.id ? "First answer" : "Other answer",
              status: "succeeded",
              turns: 1,
              tools: 0,
              transcript: [],
            };
          },
        };
        const executor = new Executor(store, setup, runner);
        await executor.execute(w.id, b.id);
        expect(seen).toEqual([]);
        expect((await store.read(w.id)).runs[1]?.status).toBe("queued");
        await store.pool.query(
          "UPDATE outbox SET dispatched_at=now() WHERE workspace_id=$1 AND target_id=$2",
          [w.id, b.id],
        );
        await recoverJobs(store, {
          getJobById: async () => ({ state: "completed" }),
        } as unknown as PgBoss);
        const waiting = await store.pool.query(
          "SELECT dispatched_at FROM outbox WHERE workspace_id=$1 AND target_id=$2",
          [w.id, b.id],
        );
        expect(waiting.rows[0].dispatched_at).toBeNull();
        await executor.execute(w.id, c.id);
        await executor.execute(w.id, a.id);
        await executor.execute(w.id, b.id);
        expect(seen).toEqual([c.id, a.id, b.id]);
        expect(
          (await store.read(w.id)).runs.every((r) => r.status === "succeeded"),
        ).toBe(true);
      },
    );
    test.each([0, 10])(
      "a failed predecessor releases the queued follow-up without inventing an answer (topic %i)",
      async (topicId) => {
        const w = await seed();
        const first = message("First attempt", undefined, topicId);
        await ingress.accept(first);
        await ingress.accept(
          message(
            "Try again",
            topicId ? undefined : first.message?.message_id,
            topicId,
          ),
        );
        const [a, b] = (await store.read(w.id)).runs;
        if (!a || !b) throw Error("missing runs");
        const runner: AgentRunner = {
          async run(input) {
            if (input.runId === a.id) throw Error("fake provider failure");
            const context = JSON.parse(input.prompt);
            expect(
              context.sources.map((s: { role: string }) => s.role),
            ).toEqual(["user", "user"]);
            return {
              text: "Recovered",
              status: "succeeded",
              turns: 1,
              tools: 0,
              transcript: [],
            };
          },
        };
        const executor = new Executor(store, setup, runner);
        await executor.execute(w.id, a.id);
        await executor.execute(w.id, b.id);
        expect((await store.read(w.id)).runs.map((r) => r.status)).toEqual([
          "failed",
          "succeeded",
        ]);
      },
    );
    test("history tool citations validate against the durable retrieved source set", async () => {
      const w = await seed();
      await ingress.accept(message("Secret Kyoto plan"));
      await ingress.accept(message("Recall my plan"));
      const saved = await store.read(w.id);
      const [a, b] = saved.runs;
      if (!a || !b) throw Error("missing runs");
      let providerCalls = 0;
      const runner = new PiRunner((model, context) => {
        providerCalls++;
        let content: AssistantMessage["content"];
        if (providerCalls === 1) {
          expect(JSON.stringify(context.messages)).not.toContain(
            "Secret Kyoto plan",
          );
          content = [
            {
              type: "toolCall",
              id: "history",
              name: "query_chat_history",
              arguments: { threadId: a.threadId },
            },
          ];
        } else {
          const tail = context.messages.at(-1);
          if (tail?.role !== "toolResult" || tail.content[0]?.type !== "text")
            throw Error("missing history result");
          const history = JSON.parse(tail.content[0].text);
          expect(history.messages[0].text).toBe("Secret Kyoto plan");
          content = [
            {
              type: "text",
              text: `Your plan [source:${history.messages[0].id}]`,
            },
          ];
        }
        const response: AssistantMessage = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: providerCalls === 1 ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        const stream = new AssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: providerCalls === 1 ? "toolUse" : "stop",
          message: response,
        });
        stream.end(response);
        return stream;
      });
      await new Executor(store, setup, runner).execute(w.id, b.id);
      expect((await store.read(w.id)).runs[1]?.status).toBe("succeeded");
      expect(providerCalls).toBe(2);
    });
    test.each([0, 10])(
      "workspace switches cannot resume or search another workspace's thread (topic %i)",
      async (topicId) => {
        const a = await seed();
        const first = message("workspace A secret", undefined, topicId);
        await ingress.accept(first);
        const aRun = (await store.read(a.id)).runs[0];
        const b = await seed();
        await ingress.accept(
          message("continue", first.message?.message_id, topicId),
        );
        const bRun = (await store.read(b.id)).runs[0];
        expect(bRun?.threadId).not.toBe(aRun?.threadId);
        expect(bRun?.sources.map((m) => m.text)).toEqual(["continue"]);
        if (topicId) expect(bRun?.threadNotice).toBeUndefined();
        else expect(bRun?.threadNotice).toContain("new conversation");
      },
    );
  },
);
