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
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Workspace } from "../../src/domain.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;

(rootUrl ? describe : describe.skip)(
  "Reply splitting and output sanitization through Executor and DeliveryWorker",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `reply_reliability_${randomUUID().replaceAll("-", "")}`;
    const key = "cf".repeat(32);
    let store: Store;
    let setup: SetupService;
    let w: Workspace;
    let calls: { method: string; params: Record<string, unknown> }[];
    let sequence = 60000;

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
      w = workspace();
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
        [w.operatorId, `reply-${w.operatorId}`],
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
    });

    async function saveWorkspace(ws: Workspace) {
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,'{}'::jsonb)",
        [ws.id, ws.operatorId],
      );
      await store.save(store.pool, ws);
    }

    test("splits long Markdown replies across balanced chunks and delivers them strictly in order", async () => {
      w.messages.push({
        id: "999:101:10",
        chatId: "101",
        topicId: 0,
        author: "101",
        role: "user",
        text: "Show me the full migration snippet",
        at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        directed: true,
      });
      const run = createRun(
        w,
        "101",
        "Show me the full migration snippet",
        "101",
        0,
        "gpt-4.1-mini",
        { replyTo: 10, botId: "999" },
      );
      await saveWorkspace(w);

      const codeBody = Array.from(
        { length: 95 },
        (_, i) => `export const migrationStep${i} = "step_${i}_payload_data";`,
      ).join("\n");
      const longReply = `Here is the full code [source:999:101:10]:\n\n\`\`\`ts\n${codeBody}\n\`\`\`\n\nAll steps verified.`;

      const runner: AgentRunner = {
        async run() {
          return {
            text: longReply,
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };

      await new Executor(store, setup, runner).execute(w.id, run.id);
      const afterExec = await store.read(w.id);
      const deliveries = afterExec.deliveries.filter((d) => d.runId === run.id);
      expect(deliveries.map((d) => d.id)).toEqual([
        `run:${run.id}:result`,
        `run:${run.id}:result:part:2`,
      ]);
      for (const d of deliveries) {
        expect(d.text.length).toBeLessThanOrEqual(3800);
        const fences = d.text.match(/^```/gm) ?? [];
        expect(fences.length % 2).toBe(0);
      }
      expect(deliveries[0]?.replyTo).toBe(10);
      expect(deliveries[1]?.replyTo).toBeUndefined();
      // Thread answer retains full text beyond the old 2700-char limit.
      const savedAnswer = afterExec.messages.find(
        (m) => m.id === `answer:${run.id}`,
      );
      expect(savedAnswer?.text.length).toBeGreaterThan(4000);

      // Attempting to send part 2 before part 1 defers without calling Telegram.
      const deliveryWorker = new DeliveryWorker(store, setup);
      await deliveryWorker.send(w.id, `run:${run.id}:result:part:2`);
      const sendCallsBefore = calls.filter(
        (c) => c.method === "sendRichMessage",
      );
      expect(sendCallsBefore).toHaveLength(0);

      // Sending part 1 delivers part 1 and immediately chains part 2 in strict order.
      await deliveryWorker.send(w.id, `run:${run.id}:result`);
      const sendCalls = calls.filter((c) => c.method === "sendRichMessage");
      expect(sendCalls).toHaveLength(2);
      const firstRich = JSON.stringify(sendCalls[0]?.params.rich_message);
      const secondRich = JSON.stringify(sendCalls[1]?.params.rich_message);
      expect(firstRich).toContain("Here is the full code");
      expect(secondRich).toContain("All steps verified.");

      const afterSend = await store.read(w.id);
      expect(
        afterSend.deliveries
          .filter((d) => d.runId === run.id)
          .every((d) => d.state === "sent"),
      ).toBe(true);
    });

    test("sanitizes unauthorized citations and unverified Telegram links instead of failing the run", async () => {
      w.messages.push({
        id: "999:101:20",
        chatId: "101",
        topicId: 0,
        author: "101",
        role: "user",
        text: "Summarize our deployment notes",
        at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        directed: true,
      });
      const run = createRun(
        w,
        "101",
        "Summarize our deployment notes",
        "101",
        0,
        "gpt-4.1-mini",
        { replyTo: 20, botId: "999" },
      );
      await saveWorkspace(w);

      const runner: AgentRunner = {
        async run(input) {
          // Streaming preview must not be suppressed on recap prompts before a citation arrives.
          await input.preview?.("Deployment summary is ready...");
          return {
            text: "Deployment summary [source:999:101:20] from [source:package.json]. See [channel](https://t.me/invented/55) and https://t.me/fake/99.",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };

      await new Executor(store, setup, runner).execute(w.id, run.id);
      const draftCalls = calls.filter(
        (c) => c.method === "sendRichMessageDraft",
      );
      expect(draftCalls).toHaveLength(1);

      const after = await store.read(w.id);
      const savedRun = after.runs.find((r) => r.id === run.id);
      expect(savedRun?.status).toBe("succeeded");
      const delivery = after.deliveries.find(
        (d) => d.id === `run:${run.id}:result`,
      );
      expect(delivery?.text).toContain("[source:999:101:20]");
      expect(delivery?.text).not.toContain("package.json");
      expect(delivery?.text).not.toContain("https://t.me/invented");
      expect(delivery?.text).not.toContain("https://t.me/fake");
      expect(delivery?.text).toContain("See channel");
      expect(
        after.audit.some(
          (a) => a.action === "run.output_sanitized" && a.target === run.id,
        ),
      ).toBe(true);
    });

    test("staged widget on a summarize request publishes without false recap_requires_sources failure", async () => {
      w.messages.push({
        id: "999:101:30",
        chatId: "101",
        topicId: 0,
        author: "101",
        role: "user",
        text: "Summarize our Q4 cost comparison with a chart",
        at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        directed: true,
      });
      const run = createRun(
        w,
        "101",
        "Summarize our Q4 cost comparison with a chart",
        "101",
        0,
        "gpt-4.1-mini",
        { replyTo: 30, botId: "999" },
      );
      await saveWorkspace(w);

      const runner: AgentRunner = {
        async run(input) {
          const widgetTool = input.tools.find(
            (t) => t.name === "send_telegram_widget",
          );
          if (!widgetTool) throw new Error("widget tool missing");
          await widgetTool.execute("call-w1", {
            html: "<div>Q4 budget summary: USD 120</div>",
            caption: "Q4 cost comparison summary",
          });
          return {
            text: "Q4 cost comparison summary [source:999:101:30].",
            status: "succeeded",
            turns: 1,
            tools: 1,
            transcript: [],
          };
        },
      };

      await new Executor(store, setup, runner).execute(w.id, run.id);
      const after = await store.read(w.id);
      const savedRun = after.runs.find((r) => r.id === run.id);
      expect(savedRun?.status).toBe("succeeded");
      expect(
        after.deliveries.some((d) => d.id === `run:${run.id}:widget`),
      ).toBe(true);
      expect(
        after.deliveries.some((d) => d.id === `run:${run.id}:result`),
      ).toBe(true);
    });
  },
);
