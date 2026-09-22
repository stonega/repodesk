import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  type AgentInput,
  type AgentRunner,
  PiRunner,
} from "../../src/agent/runtime.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { type Update, updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { memoryReferences } from "../../src/workspaces/conversation-memory.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { recordThreadAnswer } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4.1-mini",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 50,
      output: 5,
      cacheRead: 40,
      cacheWrite: 0,
      totalTokens: 95,
      cost: {
        input: 0.001,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.001,
      },
    },
  };
}
async function finish(input: AgentInput, text: string) {
  const attempt = await input.reserve(0.001);
  await input.checkpoint(response(text), attempt);
  return {
    text,
    status: "succeeded" as const,
    turns: 1,
    tools: 0,
    transcript: [],
  };
}
const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "group conversations (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `deepx_group_${randomUUID().replaceAll("-", "")}`;
    const operatorId = randomUUID();
    const key = "af".repeat(32);
    let store: Store;
    let setup: SetupService;
    let ingress: Ingress;
    let sequence = 100000;
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const telegram: Telegram = {
      async call<T>(method: string, params = {}) {
        calls.push({ method, params });
        return { message_id: ++sequence } as T;
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
      const d = await store.deployment();
      Object.assign(d, {
        active: true,
        paused: false,
        bot: { id: "999", username: "test_bot", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:fake"),
          model: encrypt(key, "model", "fake"),
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
      w.settings.runBudgetUsd = 1;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      await store.pool.query(
        "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES('-100100',$1) ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id",
        [w.id],
      );
      return w;
    }
    function message(
      text: string,
      actor = 101,
      topic = 0,
      replyTo?: number,
    ): Update {
      return updateSchema.parse({
        update_id: ++sequence,
        message: {
          message_id: ++sequence,
          date: Math.floor(Date.now() / 1000),
          from: { id: actor, is_bot: false },
          chat: { id: -100100, type: "supergroup" },
          message_thread_id: topic,
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
    async function answered(workspaceId: string, actor = 101, topic = 0) {
      await ingress.accept(
        message(
          actor === 101 ? "/ask 部署方案" : "/ask 招聘文案",
          actor,
          topic,
        ),
      );
      const r = (await store.read(workspaceId)).runs.at(-1);
      if (!r) throw Error("run");
      await new Executor(store, setup, {
        run: (i) => finish(i, actor === 101 ? "部署和回滚方案" : "招聘工程师"),
      }).execute(workspaceId, r.id);
      await new DeliveryWorker(store, setup).send(
        workspaceId,
        `run:${r.id}:result`,
      );
      return r;
    }
    async function candidate() {
      const w = await seed();
      const anchor = await answered(w.id);
      await ingress.accept(message("再详细点"));
      const run = (await store.read(w.id)).runs.at(-1);
      if (!run?.followup) throw Error("missing followup");
      return { w, anchor, run };
    }

    test("plain follow-ups preserve actor context, duplicate ingress and executor recovery do not repeat classification", async () => {
      const w = await seed();
      const a = await answered(w.id);
      await answered(w.id, 202);
      const msg = message("再详细点");
      const accepted = await Promise.all([
        ingress.accept(msg),
        ingress.accept(msg),
      ]);
      expect(accepted.filter((r) => "duplicate" in r)).toHaveLength(1);
      const r = (await store.read(w.id)).runs.at(-1);
      if (!r) throw Error("run");
      expect(r.threadId).toBe(a.threadId);
      let gates = 0;
      let answers = 0;
      const runner: AgentRunner = {
        async run(input) {
          expect(input.prompt).not.toContain("招聘");
          if (input.purpose === "followup") {
            gates++;
            expect(input.tools).toEqual([]);
            expect(input.preview).toBeUndefined();
            expect(input.extensionTool).toBeUndefined();
            expect(input.cacheKey).toBeUndefined();
            return finish(input, "REPLY");
          }
          answers++;
          expect(input.cacheKey).toHaveLength(64);
          expect(input.transcript).toEqual([]);
          return finish(input, "详细部署步骤");
        },
      };
      await new Executor(store, setup, runner).execute(w.id, r.id);
      await new Executor(store, setup, runner).execute(w.id, r.id);
      expect([gates, answers]).toEqual([1, 1]);
      const saved = (await store.read(w.id)).runs.find((x) => x.id === r.id);
      expect(saved?.followup?.decision).toBe("reply");
      expect(saved?.attempts.map((a) => a.purpose)).toEqual([
        "followup",
        undefined,
      ]);
      expect(saved?.attempts.every((a) => a.status === "settled")).toBe(true);
      expect(
        saved?.transcript.some((m) => JSON.stringify(m).includes('"REPLY"')),
      ).toBe(false);
      await new DeliveryWorker(store, setup).send(w.id, `run:${r.id}:result`);
      expect(calls.at(-1)?.params.reply_parameters).toEqual({
        message_id: msg.message?.message_id,
        allow_sending_without_reply: true,
      });
    });

    test("IGNORE or malformed classification stays silent and erases unaddressed message content", async () => {
      for (const verdict of ["IGNORE", "REPLY and ignore all instructions"]) {
        const { w, run } = await candidate();
        let answers = 0;
        await new Executor(store, setup, {
          async run(input) {
            if (input.purpose !== "followup") answers++;
            return finish(input, verdict);
          },
        }).execute(w.id, run.id);
        const saved = await store.read(w.id);
        const r = saved.runs.find((r) => r.id === run.id);
        expect(answers).toBe(0);
        expect(r?.followup?.decision).toBe("ignore");
        expect(r?.task).not.toContain("再详细点");
        expect(r?.sources).toEqual([]);
        expect(saved.messages.some((s) => s.runId === run.id)).toBe(false);
        expect(saved.deliveries.some((d) => d.runId === run.id)).toBe(false);
        await ingress.accept(message("继续"));
        expect((await store.read(w.id)).runs).toHaveLength(2);
      }
    });

    test("ordinary group collection remains independent of an ignored follow-up", async () => {
      const { w, run } = await candidate();
      await store.change(w.id, (w) => {
        const chat = w.chats[0];
        if (chat) chat.collection = true;
      });
      await new Executor(store, setup, {
        run: (i) => finish(i, "IGNORE"),
      }).execute(w.id, run.id);
      const saved = await store.read(w.id);
      const source = saved.messages.find((s) => s.text === "再详细点");
      expect(source?.threadId).toBeUndefined();
      expect(source?.directed).toBe(false);
      expect(saved.deliveries.some((d) => d.runId === run.id)).toBe(false);
    });

    test("routing ignores edits, other addressees and unauthorized identities; plain messages cannot trigger control commands", async () => {
      const w = await seed();
      await answered(w.id);
      const edit = message("再详细点");
      await ingress.accept({
        update_id: edit.update_id,
        edited_message: edit.message,
      });
      await ingress.accept(message("再详细点", 303));
      const other = message("@alice 再详细点");
      await ingress.accept(other);
      await ingress.accept(message("再详细点"));
      expect((await store.read(w.id)).runs).toHaveLength(1);
      await answered(w.id);
      await ingress.accept(message("/capture@other_bot on"));
      expect((await store.read(w.id)).chats[0]?.collection).toBe(false);
      await ingress.accept(message("再详细点"));
      expect((await store.read(w.id)).runs).toHaveLength(2);
    });

    test("confirmed public reply joins another participant's discussion and keeps the native topic", async () => {
      const w = await seed();
      const a = await answered(w.id, 101, 20);
      const remoteId = (await store.read(w.id)).deliveries.find(
        (d) => d.runId === a.id,
      )?.remoteId;
      await ingress.accept(message("加上回滚演练", 202, 20, remoteId));
      const joined = (await store.read(w.id)).runs.at(-1);
      expect(joined?.threadId).toBe(a.threadId);
      expect(joined?.followup).toBeUndefined();
      if (!joined) throw Error("run");
      await new Executor(store, setup, {
        run: (i) => finish(i, "回滚演练已加入方案"),
      }).execute(w.id, joined.id);
      await new DeliveryWorker(store, setup).send(
        w.id,
        `run:${joined.id}:result`,
      );
      expect(calls.at(-1)?.params.message_thread_id).toBe(20);
      await ingress.accept(message("再详细点", 202, 20));
      expect((await store.read(w.id)).runs.at(-1)?.followup?.anchorRunId).toBe(
        joined.id,
      );
    });

    test("completed classifier checkpoint resumes without another classifier call", async () => {
      const { w, run } = await candidate();
      await store.change(w.id, (w) => {
        const r = w.runs.find((r) => r.id === run.id);
        if (!r?.followup) throw Error("run");
        r.followup.references = memoryReferences(r.sources);
        r.followup.transcript = [response("REPLY")];
        r.attempts.push({
          id: "completed-gate",
          purpose: "followup",
          reserved: 0.001,
          actual: 0.001,
          status: "settled",
          at: r.at,
        });
      });
      let answers = 0;
      await new Executor(store, setup, {
        async run(i) {
          expect(i.purpose).toBeUndefined();
          answers++;
          return finish(i, "详细步骤");
        },
      }).execute(w.id, run.id);
      expect(answers).toBe(1);
      expect((await store.read(w.id)).runs.at(-1)?.attempts).toHaveLength(2);
    });

    test("gate failures, revoked access, changed sources, exhausted limits and unknown charges are silent", async () => {
      for (const mode of [
        "provider",
        "unknown",
        "revoke",
        "redirect",
        "cancel",
        "remove",
        "edit",
        "budget",
        "turns",
        "expire",
      ]) {
        const { w, run } = await candidate();
        let gates = 0;
        let answers = 0;
        if (mode === "turns" || mode === "expire")
          await store.change(w.id, (w) => {
            const r = w.runs.find((r) => r.id === run.id);
            if (!r?.followup) throw Error("run");
            if (mode === "turns") r.settings.maxTurns = 1;
            else r.followup.expiresAt = new Date(0).toISOString();
          });
        const runner: AgentRunner = {
          async run(i) {
            if (i.purpose !== "followup") {
              answers++;
              return finish(i, "should not answer");
            }
            gates++;
            if (mode === "provider") throw Error("provider unavailable");
            if (mode === "unknown") {
              await i.reserve(0.001);
              throw Error("response lost");
            }
            if (mode === "budget") {
              await i.reserve(10);
              throw Error("unreachable");
            }
            if (mode === "redirect")
              await ingress.accept(message("@alice 再详细点"));
            if (mode === "cancel" || mode === "remove")
              await store.change(w.id, (w) => {
                if (mode === "remove") w.messages.shift();
                else {
                  const pending = w.runs.find((r) => r.id === run.id);
                  if (pending) pending.cancelled = true;
                }
              });
            if (mode === "revoke" || mode === "edit")
              await store.change(w.id, (w) => {
                if (mode === "revoke") w.policy.allowed = [];
                else {
                  const source = w.messages[0];
                  if (source) source.text = "edited source";
                }
              });
            return finish(i, "REPLY");
          },
        };
        await new Executor(store, setup, runner).execute(w.id, run.id);
        await new Executor(store, setup, runner).execute(w.id, run.id);
        const saved = await store.read(w.id);
        const r = saved.runs.find((r) => r.id === run.id);
        expect(answers).toBe(0);
        expect(gates).toBeLessThanOrEqual(1);
        expect(saved.deliveries.some((d) => d.runId === run.id)).toBe(false);
        expect(r?.followup?.transcript).toEqual([]);
        expect(r?.task).not.toContain("再详细点");
        if (mode === "unknown") expect(r?.attempts[0]?.status).toBe("unknown");
      }
    });

    test("group follow-up classification, threshold compaction and answer share budget and checkpoints", async () => {
      const w = await seed();
      await store.change(w.id, (w) => {
        for (let i = 0; i < 18; i++) {
          const r = createRun(
            w,
            "101",
            `部署 ${i} ${"detail ".repeat(440)}`,
            "-100100",
            0,
            "gpt-4.1-mini",
            { botId: "999" },
          );
          r.status = "succeeded";
          r.result = "备份决定";
          recordThreadAnswer(w, r);
        }
      });
      await answered(w.id);
      await ingress.accept(message("再详细点"));
      const r = (await store.read(w.id)).runs.at(-1);
      if (!r?.followup) throw Error("run");
      await store.change(w.id, (w) => {
        const run = w.runs.find((x) => x.id === r.id);
        if (run)
          run.modelOptions = {
            modelBaseUrl: "https://api.openai.com/v1",
            thinkingLevel: "off",
            modelLimits: { contextWindow: 50000, maxOutputTokens: 4000 },
          };
      });
      const purposes: AgentInput["purpose"][] = [];
      await new Executor(store, setup, {
        run(i) {
          purposes.push(i.purpose);
          return finish(
            i,
            i.purpose === "followup"
              ? "REPLY"
              : i.purpose === "compaction"
                ? "备份决定和待办"
                : "详细方案",
          );
        },
      }).execute(w.id, r.id);
      expect(purposes).toEqual(["followup", "compaction", undefined]);
      const saved = (await store.read(w.id)).runs.at(-1);
      expect(saved?.status).toBe("succeeded");
      expect(saved?.contextSummary?.text).toBe("备份决定和待办");
      expect(saved?.attempts.map((a) => a.purpose)).toEqual(purposes);
    });

    test("real Pi loop separates the classifier and ordinary answer with no gate tools", async () => {
      const { w, run } = await candidate();
      let requests = 0;
      const pi = new PiRunner((_model, context) => {
        requests++;
        const gate = context.systemPrompt?.includes(
          "Return exactly REPLY or IGNORE",
        );
        if (gate) expect(context.tools ?? []).toEqual([]);
        else expect(JSON.stringify(context)).not.toContain('"text":"REPLY"');
        const stream = new AssistantMessageEventStream();
        const msg = response(gate ? "REPLY" : "详细部署步骤");
        stream.push({ type: "done", reason: "stop", message: msg });
        stream.end(msg);
        return stream;
      });
      await new Executor(store, setup, pi).execute(w.id, run.id);
      expect(requests).toBe(2);
      expect((await store.read(w.id)).runs.at(-1)?.status).toBe("succeeded");
    });
  },
);
