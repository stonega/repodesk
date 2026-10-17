import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentInput, AgentRunner } from "../../src/agent/runtime.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { claimMemoryJob } from "../../src/memory/planner.ts";
import { MemoryService } from "../../src/memory/service.ts";
import { memoryState } from "../../src/memory/state.ts";
import { queryMemories } from "../../src/memory/tools.ts";
import { sweep } from "../../src/privacy/service.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { recordThreadAnswer } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

const extraction = JSON.stringify({
  title: "Backup decision",
  summary:
    "101 chose Taipei for this project's backup region; restore testing remains open.",
});
function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4.1-mini",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
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
  await input.checkpoint(message(text), id);
  return {
    text,
    status: "succeeded" as const,
    turns: 1,
    tools: 0,
    transcript: [],
  };
}
function summary(input: AgentInput) {
  const id = JSON.parse(input.prompt).memories[0]?.id;
  return JSON.stringify({
    summary: `[memory:${id}] Backup region and unfinished restore test.`,
    memoryIds: [id],
  });
}
const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "Long-term memory (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const dbName = `repodesk_ltm_${randomUUID().replaceAll("-", "")}`;
    const operator = randomUUID(),
      key = "cf".repeat(32);
    let store: Store, setup: SetupService;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(rootUrl ?? "");
      url.pathname = `/${dbName}`;
      store = new Store(database(url.toString()));
      await migrate(store.pool);
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'operator','unused',true)",
        [operator],
      );
      const telegram: Telegram = {
        async call() {
          throw new Error("Background memory must not send Telegram messages");
        },
      };
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
        bot: { id: "999", username: "fixture", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:fixture"),
          model: encrypt(key, "model", "fixture"),
        },
      });
      await store.saveDeployment(store.pool, d);
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.end();
    });
    async function seed(group = false) {
      const w = workspace();
      w.operatorId = operator;
      w.settings.runBudgetUsd = 1;
      const r = createRun(
        w,
        "101",
        "We chose Taipei for this project's backups. Restore testing is pending.",
        group ? "-100100" : "101",
        10,
        "gpt-4.1-mini",
        { botId: "999" },
      );
      r.status = "succeeded";
      r.result = "Backup decision recorded.";
      r.finishedAt = r.at;
      r.modelOptions = {
        modelBaseUrl: "https://api.openai.com/v1",
        thinkingLevel: "off",
      };
      recordThreadAnswer(w, r);
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operator, JSON.stringify(w)],
      );
      return { w, r };
    }
    test.each([false, true])(
      "two-stage %s recall persists, uses separate checkpoints and accounts for both calls",
      async (group) => {
        const { w, r } = await seed(group);
        let calls = 0;
        const runner: AgentRunner = {
          async run(input) {
            calls++;
            expect(input.tools).toEqual([]);
            expect(input.preview).toBeUndefined();
            expect(input.extensionTool).toBeUndefined();
            expect(input.maxTurns).toBe(1);
            return finish(
              input,
              input.purpose === "memory_extract" ? extraction : summary(input),
            );
          },
        };
        const service = new MemoryService(store, setup, runner, 0);
        await service.tick(w.id);
        await service.tick(w.id);
        const saved = await new Store(store.pool).read(w.id);
        expect(calls).toBe(2);
        expect(saved.memory?.entries).toHaveLength(1);
        expect(saved.memory?.jobs[0]?.status).toBe("done");
        expect(saved.memory?.jobs[0]?.transcript).toEqual([]);
        expect(saved.memory?.indexes[0]?.text).toContain("restore test");
        const parent = saved.runs.find((run) => run.id === r.id);
        expect(parent?.transcript).toEqual([]);
        expect(parent?.status).toBe("succeeded");
        expect(parent?.attempts.map((a) => [a.purpose, a.status])).toEqual([
          ["memory_extract", "settled"],
          ["memory_consolidate", "settled"],
        ]);
        expect(saved.deliveries).toEqual([]);
        const next = createRun(
          saved,
          group ? "202" : "101",
          "What is pending?",
          group ? "-100100" : "101",
          group ? 10 : 20,
          "gpt-4.1-mini",
          { botId: "999" },
        );
        expect(next.memoryContext?.text).toContain("restore test");
        expect(
          queryMemories(saved, next, { query: "Taipei" }).memories,
        ).toHaveLength(1);
      },
    );
    test("concurrent workers claim the same durable job only once", async () => {
      const { w } = await seed();
      let calls = 0;
      const runner: AgentRunner = {
        async run(input) {
          calls++;
          return finish(
            input,
            input.purpose === "memory_extract" ? extraction : summary(input),
          );
        },
      };
      await Promise.all([
        new MemoryService(store, setup, runner, 0).tick(w.id),
        new MemoryService(new Store(store.pool), setup, runner, 0).tick(w.id),
      ]);
      expect(calls).toBe(2);
      expect((await store.read(w.id)).memory?.jobs).toHaveLength(1);
    });
    test("a completed extraction checkpoint resumes after restart without another extraction charge", async () => {
      const { w, r } = await seed();
      await store.change(w.id, (saved) => {
        const job = claimMemoryJob(saved, Date.now(), 0);
        if (!job) throw Error("missing job");
        const stored = saved.memory?.jobs[0];
        if (!stored) throw Error("missing job");
        stored.leaseUntil = new Date(0).toISOString();
        stored.transcript = [message(extraction)];
        stored.attemptIds = ["extract-checkpoint"];
        saved.runs
          .find((run) => run.id === r.id)
          ?.attempts.push({
            id: "extract-checkpoint",
            purpose: "memory_extract",
            reserved: 0.001,
            actual: 0.001,
            status: "settled",
            at: r.at,
          });
      });
      let calls = 0;
      const runner: AgentRunner = {
        async run(input) {
          calls++;
          expect(input.purpose).toBe("memory_consolidate");
          return finish(input, summary(input));
        },
      };
      await new MemoryService(new Store(store.pool), setup, runner, 0).tick(
        w.id,
      );
      expect(calls).toBe(1);
      expect((await store.read(w.id)).memory?.jobs[0]?.status).toBe("done");
    });
    test.each(["removed", "revoked", "invalid", "budget", "unknown"])(
      "pipeline failure %s cannot publish unsupported recall",
      async (mode) => {
        const { w } = await seed(mode === "revoked");
        let calls = 0;
        if (mode === "budget")
          await store.change(w.id, (saved) => {
            saved.settings.runBudgetUsd = 0.00001;
          });
        const runner: AgentRunner = {
          async run(input) {
            calls++;
            if (mode === "unknown") {
              await input.reserve(0.001);
              throw Error("lost provider response");
            }
            if (mode === "removed")
              await store.change(w.id, (saved) => {
                saved.messages.shift();
              });
            if (mode === "revoked")
              await store.change(w.id, (saved) => {
                const chat = saved.chats[0];
                if (chat) chat.active = false;
              });
            return finish(input, mode === "invalid" ? "not JSON" : extraction);
          },
        };
        const service = new MemoryService(store, setup, runner, 0);
        await service.tick(w.id);
        await service.tick(w.id);
        const saved = await store.read(w.id);
        expect(saved.memory?.entries).toEqual([]);
        expect(saved.memory?.indexes).toEqual([]);
        expect(calls).toBe(1);
        if (mode === "unknown")
          expect(saved.runs[0]?.attempts[0]?.status).toBe("unknown");
        if (mode === "removed") {
          await store.change(w.id, (state) => sweep(state));
          expect((await store.read(w.id)).memory?.jobs).toEqual([]);
        }
      },
    );
    test("deletion of another consolidation input invalidates its checkpoint immediately", async () => {
      const { w } = await seed();
      const runner: AgentRunner = {
        async run(input) {
          if (input.purpose === "memory_extract")
            return finish(input, extraction);
          await store.change(w.id, (saved) => {
            saved.messages = [];
            sweep(saved);
          });
          return finish(input, summary(input));
        },
      };
      await new MemoryService(store, setup, runner, 0).tick(w.id);
      const saved = await store.read(w.id);
      expect(memoryState(saved).entries).toEqual([]);
      expect(saved.memory?.indexes).toEqual([]);
      expect(saved.memory?.jobs).toEqual([]);
    });
  },
);
