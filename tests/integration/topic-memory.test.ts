import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { compactionPlan } from "../../src/agent/compaction.ts";
import {
  type AgentInput,
  type AgentRunner,
  PiRunner,
  selectedModel,
} from "../../src/agent/runtime.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { recordThreadAnswer } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

function response(
  text: string,
  calls: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content: calls.length ? calls : [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4.1-mini",
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp: Date.now(),
    usage: {
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 0,
      totalTokens: 200,
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
  const id = await input.reserve(0.001);
  await input.checkpoint(response(text), id);
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
  "Topic memory and compaction (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `deepx_memory_${randomUUID().replaceAll("-", "")}`;
    const operatorId = randomUUID();
    const key = "af".repeat(32);
    let store: Store;
    let setup: SetupService;
    const calls: string[] = [];
    const telegram: Telegram = {
      async call<T>(method: string) {
        calls.push(method);
        return { message_id: 10 } as T;
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
    async function seed(long = true) {
      const w = workspace();
      w.operatorId = operatorId;
      w.settings.runBudgetUsd = 1;
      if (long)
        for (let i = 0; i < 18; i++) {
          const r = createRun(
            w,
            "101",
            `discussion ${i}: ${"details ".repeat(440)}`,
            "101",
            10,
            "gpt-4.1-mini",
            { botId: "999" },
          );
          r.status = "succeeded";
          r.result = "Recorded decision";
          recordThreadAnswer(w, r);
        }
      const run = createRun(
        w,
        "101",
        "Please continue",
        "101",
        10,
        "gpt-4.1-mini",
        { botId: "999" },
      );
      run.modelOptions = {
        modelBaseUrl: "https://api.openai.com/v1",
        thinkingLevel: "off",
        modelLimits: {
          contextWindow: long ? 50000 : 1000000,
          maxOutputTokens: 4000,
        },
      };
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      return { w, run };
    }
    test("compaction is billed, separately checkpointed, durable, and not repeated on the next short turn", async () => {
      const { w, run } = await seed();
      let summaries = 0;
      let answers = 0;
      const keys: (string | undefined)[] = [];
      const runner: AgentRunner = {
        async run(input) {
          if (input.purpose === "compaction") {
            summaries++;
            expect(input.tools).toEqual([]);
            expect(input.preview).toBeUndefined();
            return finish(
              input,
              "Earlier discussion decisions; pending backup task.",
            );
          }
          answers++;
          keys.push(input.cacheKey);
          const context = JSON.parse(input.prompt);
          expect(context.summary).toContain("pending backup task");
          expect(context.sources.length).toBeLessThan(run.sources.length);
          expect(context.sources.at(-1)?.role).toBe("user");
          return finish(input, "Continuing the discussion.");
        },
      };
      await new Executor(store, setup, runner).execute(w.id, run.id);
      const saved = await store.read(w.id);
      const done = saved.runs.at(-1);
      expect(done?.status).toBe("succeeded");
      expect(
        done?.attempts.some(
          (a) => a.purpose === "compaction" && a.status === "settled",
        ),
      ).toBe(true);
      expect(done?.attempts[0]?.tokens?.cacheRead).toBe(80);
      expect(JSON.stringify(done?.transcript)).not.toContain(
        "Earlier discussion decisions",
      );
      expect(saved.threads?.[0]?.summary?.text).toContain(
        "pending backup task",
      );
      expect(saved.messages.length).toBe(w.messages.length + 1);
      const next = await store.change(w.id, (latest) =>
        createRun(latest, "101", "More detail", "101", 10, "gpt-4.1-mini", {
          botId: "999",
        }),
      );
      const before = summaries;
      await new Executor(new Store(store.pool), setup, runner).execute(
        w.id,
        next.id,
      );
      expect(summaries).toBe(before);
      expect(answers).toBe(2);
      expect(keys[0]).toBeDefined();
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).not.toBe(run.id);
      expect((await store.read(w.id)).threads?.[0]?.summary).toEqual(
        saved.threads?.[0]?.summary,
      );
    });
    test("real Pi tool flow silently records a new discussion and recalls it by ID", async () => {
      const { w, run } = await seed(false);
      let count = 0;
      const runner = new PiRunner((_model, context, options) => {
        expect(options?.sessionId).toMatch(/^[a-f0-9]{64}$/);
        count++;
        const result = response(
          "Here is the deployment answer.",
          count === 1
            ? [
                {
                  type: "toolCall",
                  id: "record",
                  name: "record_discussion",
                  arguments: {
                    title: "Deployment",
                    summary: "Single server",
                    decisions: ["Use one server"],
                    todos: ["Backup storage"],
                    messageIds: [run.sources[0]?.id],
                  },
                },
              ]
            : [],
        );
        expect(context.tools?.some((t) => t.name === "record_discussion")).toBe(
          true,
        );
        const stream = new AssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: result.stopReason as "stop" | "toolUse",
          message: result,
        });
        stream.end(result);
        return stream;
      });
      await new Executor(store, setup, runner).execute(w.id, run.id);
      const saved = await store.read(w.id);
      expect(saved.runs.at(-1)?.status).toBe("succeeded");
      expect(saved.approvals).toEqual([]);
      const discussion = saved.threads?.[0]?.discussions?.[0];
      expect(discussion?.title).toBe("Deployment");
      expect(count).toBe(2);
      const next = await store.change(w.id, (latest) => {
        const r = createRun(
          latest,
          "101",
          "What did we decide?",
          "101",
          10,
          "gpt-4.1-mini",
          { botId: "999" },
        );
        r.status = "running";
        return r;
      });
      const tools = applicationTools(store, w.id, next.id, next.fence);
      const query = tools.find((t) => t.name === "query_discussions");
      const history = tools.find((t) => t.name === "query_chat_history");
      if (!query || !history) throw Error("missing tools");
      const found = await query.execute("find", { id: discussion?.id });
      expect(JSON.stringify(found)).toContain("Backup storage");
      expect(
        JSON.stringify(
          await history.execute("history", { discussionId: discussion?.id }),
        ),
      ).toContain("deployment answer");
    });
    test("a persisted completed summary checkpoint resumes without another summarization call", async () => {
      const { w, run } = await seed();
      await store.change(w.id, (latest) => {
        const r = latest.runs.at(-1);
        if (!r) throw Error("missing run");
        r.modelOptions = {
          ...r.modelOptions,
          modelLimits: { contextWindow: 70000, maxOutputTokens: 4000 },
        };
        const plan = compactionPlan(latest, r, {
          model: selectedModel(r.model, r.modelOptions),
          tools: applicationTools(store, w.id, r.id, r.fence),
        } as AgentInput);
        if (!plan) throw Error("missing plan");
        r.compaction = {
          ...plan,
          transcript: [response("Recovered summary of deployment decisions.")],
        };
        r.status = "running";
        r.leaseUntil = new Date(0).toISOString();
        r.attempts.push({
          id: randomUUID(),
          purpose: "compaction",
          reserved: 0.001,
          actual: 0.001,
          status: "settled",
          at: r.at,
        });
      });
      let summaries = 0;
      const runner: AgentRunner = {
        async run(input) {
          if (input.purpose) summaries++;
          expect(JSON.parse(input.prompt).summary).toContain(
            "Recovered summary",
          );
          return finish(input, "Resumed answer");
        },
      };
      const executor = new Executor(new Store(store.pool), setup, runner);
      await executor.execute(w.id, run.id);
      await executor.execute(w.id, run.id);
      const saved = await store.read(w.id);
      expect(saved.runs.at(-1)?.status).toBe("succeeded");
      expect(saved.runs.at(-1)?.attempts).toHaveLength(2);
      expect(summaries).toBe(0);
    });
    test.each(["invalid", "cancel", "removed", "budget", "unknown"])(
      "compaction failure %s does not publish a summary or ordinary answer",
      async (mode) => {
        const { w, run } = await seed();
        let answers = 0;
        if (mode === "budget")
          await store.change(w.id, (latest) => {
            latest.settings.runBudgetUsd = 0.00001;
          });
        const runner: AgentRunner = {
          async run(input) {
            if (!input.purpose) {
              answers++;
              return finish(input, "must not publish");
            }
            if (mode === "unknown") {
              await input.reserve(0.001);
              throw Error("lost provider response");
            }
            if (mode === "cancel")
              await store.change(w.id, (latest) => {
                const r = latest.runs.at(-1);
                if (r) r.cancelled = true;
              });
            if (mode === "removed")
              await store.change(w.id, (latest) => {
                latest.messages.shift();
              });
            if (mode === "budget") await input.reserve(0.001);
            return finish(input, mode === "invalid" ? "" : "summary");
          },
        };
        await new Executor(store, setup, runner).execute(w.id, run.id);
        const saved = await store.read(w.id);
        expect(saved.runs.at(-1)?.status).not.toBe("succeeded");
        expect(saved.threads?.[0]?.summary).toBeUndefined();
        expect(answers).toBe(0);
        if (mode === "unknown")
          expect(saved.runs.at(-1)?.attempts[0]?.status).toBe("unknown");
        expect(saved.messages.some((s) => s.id === `answer:${run.id}`)).toBe(
          false,
        );
      },
    );
  },
);
