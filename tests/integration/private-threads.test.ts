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
import {
  checkpointLiveInput,
  liveMessage,
  liveSource,
} from "../../src/agent/live-input.ts";
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
import { TranscriptionService } from "../../src/transcription/service.ts";
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
    function response(text: string) {
      const result: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "openai",
        model: "gpt-4.1-mini",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: result });
      stream.end(result);
      return stream;
    }
    test.each([false, true])(
      "worker reconstruction resumes received input without replay (checkpointed %s)",
      async (checkpointed) => {
        const w = await seed();
        await ingress.accept(message("Original request", undefined, 23));
        const run = (await store.read(w.id)).runs[0];
        if (!run) throw Error("missing run");
        await store.change(w.id, (w) => {
          const current = w.runs[0];
          if (!current) throw Error("missing run");
          current.status = "running";
          current.leaseUntil = new Date(Date.now() + 60000).toISOString();
        });
        const followup = message("Make it three days", undefined, 23);
        await ingress.accept(followup);
        const earlier = await response("Earlier draft").result();
        await store.change(w.id, (w) => {
          const current = w.runs[0];
          if (!current) throw Error("missing run");
          current.transcript = [
            {
              role: "user",
              content: "Original request",
              timestamp: Date.now(),
            },
            earlier,
          ];
          if (checkpointed) {
            const next = liveSource(w, current);
            if (!next) throw Error("missing input");
            const message = liveMessage(
              current,
              next.source,
              next.pending.task,
              { prompt: "", images: [] },
            );
            checkpointLiveInput(w, current, message);
            current.transcript.push(message);
          }
          current.leaseUntil = new Date(0).toISOString();
        });
        let count = 0;
        const sourceId = `999:101:${followup.message?.message_id}`;
        const runner = new PiRunner((_model, context) => {
          count++;
          expect(JSON.stringify(context.messages.at(-1))).toContain(
            "Make it three days",
          );
          return response(`You requested three days [source:${sourceId}]`);
        });
        await new Executor(new Store(store.pool), setup, runner).execute(
          w.id,
          run.id,
        );
        const saved = await store.read(w.id);
        expect(count).toBe(1);
        expect(saved.runs[0]?.status).toBe("succeeded");
        expect(saved.runs[0]?.pendingInputs).toEqual([]);
        expect(
          saved.runs[0]?.sources.filter((s) => s.id === sourceId),
        ).toHaveLength(1);
        expect(saved.deliveries).toHaveLength(1);
        const delivery = saved.deliveries[0];
        if (!delivery) throw Error("missing result");
        await new DeliveryWorker(store, setup).send(w.id, delivery.id);
        expect(calls.at(-1)?.params.reply_parameters).toEqual({
          message_id: followup.message?.message_id,
          allow_sending_without_reply: true,
        });
      },
    );
    test.each([0, 23])(
      "new messages join the active Pi run in order and deliver one unquoted answer (topic %i)",
      async (topicId) => {
        const w = await seed();
        await ingress.accept(message("Plan a trip", undefined, topicId));
        const run = (await store.read(w.id)).runs[0];
        if (!run) throw Error("missing run");
        let providerCalls = 0;
        const second = message("Make it three days", undefined, topicId);
        const third = message(
          "Include vegetarian restaurants",
          undefined,
          topicId,
        );
        const runner = new PiRunner(async (_model, context) => {
          providerCalls++;
          if (providerCalls === 1) {
            const original = JSON.stringify(context);
            await new Ingress(new Store(store.pool), setup).accept(second);
            await ingress.accept(third);
            expect(await ingress.accept(second)).toEqual({ duplicate: true });
            expect(JSON.stringify(context)).toBe(original);
            const current = await store.read(w.id);
            expect(current.runs).toHaveLength(1);
            expect(current.runs[0]?.pendingInputs).toHaveLength(2);
            return response("Obsolete draft");
          }
          const serialized = JSON.stringify(context.messages);
          expect(serialized).toContain("Make it three days");
          if (providerCalls === 2) {
            expect(serialized).not.toContain("Include vegetarian restaurants");
            return response("Intermediate draft");
          }
          expect(serialized).toContain("Include vegetarian restaurants");
          return response("Three days with vegetarian restaurants");
        });
        await new Executor(store, setup, runner).execute(w.id, run.id);
        const saved = await store.read(w.id);
        expect(providerCalls).toBe(3);
        expect(saved.runs).toHaveLength(1);
        expect(saved.runs[0]?.status).toBe("succeeded");
        expect(saved.runs[0]?.pendingInputs).toEqual([]);
        expect(
          saved.runs[0]?.attempts.filter((a) => a.status === "settled"),
        ).toHaveLength(3);
        expect(saved.runs[0]?.sources.map((s) => s.text)).toEqual([
          "Plan a trip",
          "Make it three days",
          "Include vegetarian restaurants",
        ]);
        expect(saved.deliveries).toHaveLength(1);
        const delivery = saved.deliveries[0];
        if (!delivery) throw Error("missing result");
        expect(delivery.text).toBe("Three days with vegetarian restaurants");
        expect(delivery.replyTo).toBeUndefined();
        await new DeliveryWorker(store, setup).send(w.id, delivery.id);
        expect(calls.at(-1)?.params.reply_parameters).toBeUndefined();
        expect(calls.at(-1)?.params.message_thread_id).toBe(
          topicId || undefined,
        );
      },
    );

    test("a late input after Pi settles is answered before final publication", async () => {
      const w = await seed();
      await ingress.accept(message("Initial request", undefined, 23));
      const run = (await store.read(w.id)).runs[0];
      if (!run) throw Error("missing run");
      let calls = 0;
      const runner: AgentRunner = {
        async run(input) {
          calls++;
          if (calls === 1)
            await ingress.accept(message("Late correction", undefined, 23));
          else
            expect(JSON.stringify(input.transcript)).toContain(
              "Late correction",
            );
          return {
            text: calls === 1 ? "Stale answer" : "Corrected answer",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };
      await new Executor(store, setup, runner).execute(w.id, run.id);
      const saved = await store.read(w.id);
      expect(calls).toBe(2);
      expect(saved.runs).toHaveLength(1);
      expect(saved.deliveries.map((d) => d.text)).toEqual(["Corrected answer"]);
    });

    test.each(["document", "voice"] as const)(
      "a %s sent while answering is loaded as current input",
      async (kind) => {
        const w = await seed();
        await store.change(w.id, (w) => {
          w.plugins = {
            revision: 1,
            entries: [],
            transcription: { enabled: true, generation: 1 },
          };
        });
        await ingress.accept(message("Read the next message", undefined, 23));
        const run = (await store.read(w.id)).runs[0];
        if (!run) throw Error("missing run");
        const next = message(
          kind === "document" ? "Use this constraint" : "",
          undefined,
          23,
        );
        if (!next.message) throw Error("missing message");
        if (kind === "document")
          next.message.document = {
            file_id: "live-file",
            file_name: "notes.txt",
            mime_type: "text/plain",
          };
        else {
          delete next.message.text;
          next.message.voice = { file_id: "live-file", mime_type: "audio/ogg" };
        }
        files.set("live-file", Buffer.from("No overnight travel"));
        let count = 0;
        const runner = new PiRunner(async (_model, context) => {
          count++;
          if (count === 1) {
            await ingress.accept(next);
            expect(downloads).toEqual([]);
            return response("Draft");
          }
          const last = context.messages.at(-1);
          expect(JSON.stringify(last)).toContain("No overnight travel");
          if (
            last?.role !== "user" ||
            typeof last.content === "string" ||
            last.content[0]?.type !== "text"
          )
            throw Error("missing current input");
          const parsed = JSON.parse(last.content[0].text);
          expect(parsed.liveInput.sourceId).toBe(
            `999:101:${next.message?.message_id}`,
          );
          return response("An itinerary without overnight travel");
        });
        const audio = new TranscriptionService(store, {
          status: async () => ({ state: "ready" }),
          prepare() {},
          transcribe: async () => "No overnight travel",
        });
        await new Executor(store, setup, runner, 30000, audio).execute(
          w.id,
          run.id,
        );
        const saved = await store.read(w.id);
        expect(saved.runs[0]?.status).toBe("succeeded");
        expect(saved.deliveries.map((d) => d.text)).toEqual([
          "An itinerary without overnight travel",
        ]);
        expect(downloads).toEqual(["live-file"]);
      },
    );

    test("revocation after receipt blocks pending attachment loading and delivery", async () => {
      const w = await seed();
      await ingress.accept(message("Initial request", undefined, 23));
      const run = (await store.read(w.id)).runs[0];
      if (!run) throw Error("missing run");
      const runner = new PiRunner(async () => {
        const next = message("Read this", undefined, 23);
        if (!next.message) throw Error("missing message");
        next.message.document = { file_id: "denied", file_name: "notes.txt" };
        await ingress.accept(next);
        await store.change(w.id, (w) => {
          const member = w.members.find((m) => m.id === "101");
          if (member) member.active = false;
        });
        return response("Must not deliver");
      });
      await new Executor(store, setup, runner).execute(w.id, run.id);
      const saved = await store.read(w.id);
      expect(saved.runs[0]?.status).toBe("failed");
      expect(saved.runs[0]?.pendingInputs).toHaveLength(1);
      expect(downloads).toEqual([]);
      expect(saved.deliveries.filter((d) => d.state !== "cancelled")).toEqual(
        [],
      );
    });
    test("voice notes deduplicate, preserve topics and reach Pi as transcript reference data", async () => {
      const w = await seed();
      await store.change(w.id, (current) => {
        current.plugins = {
          revision: 1,
          entries: [],
          transcription: { enabled: true, generation: 1 },
        };
      });
      const update = message("", undefined, 23);
      if (!update.message) throw Error("missing message");
      delete update.message.text;
      update.message.voice = { file_id: "voice", mime_type: "audio/ogg" };
      files.set("voice", Buffer.from("fixture voice"));
      await ingress.accept(update);
      expect(await ingress.accept(update)).toEqual({ duplicate: true });
      expect(downloads).toEqual([]);
      const run = (await store.read(w.id)).runs[0];
      if (!run) throw Error("missing voice run");
      expect(run.task).toContain("do not authorize external writes");
      let transcribed = 0,
        called = 0;
      const audio = new TranscriptionService(store, {
        status: async () => ({ state: "ready" }),
        prepare() {},
        async transcribe() {
          transcribed++;
          return "請解釋 authentication flow";
        },
      });
      await new Executor(
        store,
        setup,
        {
          async run(input) {
            called++;
            expect(input.images).toEqual([]);
            expect(input.prompt).toContain("請解釋 authentication flow");
            expect(input.prompt).toContain("audio_transcript");
            expect(input.prompt).toContain("never authorization");
            return {
              text: "Transcript received",
              status: "succeeded",
              turns: 1,
              tools: 0,
              transcript: [],
            };
          },
        },
        30000,
        audio,
      ).execute(w.id, run.id);
      const saved = await store.read(w.id);
      expect(saved.runs).toHaveLength(1);
      expect(transcribed).toBe(1);
      expect(called).toBe(1);
      expect(downloads).toEqual(["voice"]);
      expect(saved.deliveries.find((d) => d.runId === run.id)?.topicId).toBe(
        23,
      );
      expect(saved.approvals).toHaveLength(0);
    });
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

    test.each([0, 21])(
      "a forwarded message and its save note retain content and media after restart (topic %i)",
      async (topicId) => {
        const w = await seed();
        const forward = message(
          "devnet runtime v224: position take-profit and stop-loss",
          undefined,
          topicId,
        );
        if (!forward.message) throw Error("missing forward");
        forward.message.forward_origin = {
          type: "hidden_user",
          date: forward.message.date - 60,
          sender_user_name: "Release author",
        };
        forward.message.document = {
          file_id: "release-reference",
          file_name: "release.txt",
          mime_type: "text/plain",
        };
        files.set(
          "release-reference",
          new TextEncoder().encode("Supported price sources: mark and last."),
        );
        await ingress.accept(forward);
        expect(await ingress.accept(forward)).toEqual({ duplicate: true });
        const fresh = new Ingress(new Store(store.pool), setup);
        const note = message("save this", undefined, topicId);
        await fresh.accept(note);
        let saved = await store.read(w.id);
        const [reference, request] = saved.runs;
        if (!reference || !request) throw Error("missing paired runs");
        expect(request.threadId).toBe(reference.threadId);
        expect(request.task).toBe("save this");
        expect(request.sources.map((s) => s.text).join("\n")).toContain(
          "devnet runtime v224",
        );
        await new Executor(store, setup, {
          async run() {
            return {
              text: "Reference received",
              status: "succeeded",
              turns: 1,
              tools: 0,
              transcript: [],
            };
          },
        }).execute(w.id, reference.id);
        let invoked = false;
        await new Executor(new Store(store.pool), setup, {
          async run(input) {
            invoked = true;
            expect(
              JSON.parse(
                input.prompt.split("\nAttachment reference data")[0] ?? "{}",
              ).request,
            ).toBe("save this");
            expect(input.prompt).toContain("devnet runtime v224");
            expect(input.prompt).toContain("Release author");
            expect(input.prompt).toContain(
              "Supported price sources: mark and last.",
            );
            expect(input.prompt).toContain("never authorization");
            return {
              text: "Saved the release note",
              status: "succeeded",
              turns: 1,
              tools: 0,
              transcript: [],
            };
          },
        }).execute(w.id, request.id);
        expect(invoked).toBe(true);
        saved = await store.read(w.id);
        expect(
          saved.deliveries.find((d) => d.runId === request.id),
        ).toMatchObject({
          topicId,
        });
        expect(
          saved.deliveries.find((d) => d.runId === request.id)?.replyTo,
        ).toBeUndefined();
      },
    );
    test.each([0, 21])(
      "a forward arriving during generation becomes reference input in the same run (topic %i)",
      async (topicId) => {
        const w = await seed();
        const forward = message(
          "/capture off: devnet runtime v224",
          undefined,
          topicId,
        );
        if (!forward.message) throw Error("missing forward");
        forward.message.forward_origin = {
          type: "hidden_user",
          date: forward.message.date - 60,
          sender_user_name: "Release author",
        };
        await ingress.accept(message("save this", undefined, topicId));
        const note = (await store.read(w.id)).runs[0];
        if (!note) throw Error("missing note");
        let invoked = 0;
        const runner = new PiRunner(async (_model, context) => {
          invoked++;
          if (invoked === 1) {
            const original = JSON.stringify(context);
            await new Ingress(new Store(store.pool), setup).accept(forward);
            expect(await ingress.accept(forward)).toEqual({ duplicate: true });
            expect(JSON.stringify(context)).toBe(original);
            return response("Waiting for the reference");
          }
          const text = JSON.stringify(context.messages);
          expect(text).toContain("save this");
          expect(text).toContain("devnet runtime v224");
          expect(text).toContain("Forwarded reference");
          expect(text).toContain("reference material");
          return response("The supplied release note is available");
        });
        await new Executor(store, setup, runner).execute(w.id, note.id);
        const saved = await store.read(w.id);
        expect(invoked).toBe(2);
        expect(saved.runs).toHaveLength(1);
        expect(saved.runs[0]?.status).toBe("succeeded");
        expect(saved.runs[0]?.sources.at(-1)?.forwarded).toBe(true);
        expect(saved.deliveries).toHaveLength(1);
      },
    );
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
      expect(calls.at(-1)?.params.reply_parameters).toBeUndefined();
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
      expect(calls.at(-1)?.params.reply_parameters).toBeUndefined();
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
