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
import { publishWidget } from "../../src/telegram/widgets.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
const args = {
  html: "<h3>3 seats</h3><button onclick=\"this.textContent='4 seats'\">+ seat</button>",
  caption: "Local estimate: 3 seats at USD 10 = USD 30. Preview only.",
};
(rootUrl ? describe : describe.skip)(
  "Telegram widgets through production composition",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `widgets_${randomUUID().replaceAll("-", "")}`;
    const key = "bd".repeat(32);
    let store: Store, setup: SetupService, w: Workspace, r: Run;
    let calls: { method: string; params: Record<string, unknown> }[];
    let failure: TelegramError | undefined;
    let sequence = 50000;
    const telegram: Telegram = {
      async call<T>(method: string, params = {}) {
        calls.push({ method, params });
        if (method === "sendWidget" && failure) throw failure;
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
      failure = undefined;
      w = workspace();
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
        [w.operatorId, `widget-${w.operatorId}`],
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
        "Make a local estimate widget",
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
    function tool(currentStore = store) {
      const found = applicationTools(currentStore, w.id, r.id, r.fence).find(
        (t) => t.name === "send_telegram_widget",
      );
      if (!found) throw Error("widget tool missing");
      return found;
    }
    const id = () => `run:${r.id}:widget`;
    async function ready() {
      await tool().execute("widget", args);
      await store.change(w.id, (w) => {
        const run = w.runs.find((run) => run.id === r.id);
        if (!run) throw Error("run missing");
        run.status = "succeeded";
        publishWidget(w, run, "999");
      });
    }
    test("duplicate concurrent calls, restart and duplicate dispatch send exactly one widget to the bound private Topic", async () => {
      await Promise.all([
        tool().execute("widget", args),
        tool().execute("widget", args),
        tool().execute("another", args),
      ]);
      expect((await store.read(w.id)).deliveries).toHaveLength(0);
      await tool(new Store(store.pool)).execute("widget", args);
      await ready();
      const worker = new DeliveryWorker(new Store(store.pool), setup);
      await Promise.all([worker.send(w.id, id()), worker.send(w.id, id())]);
      await worker.send(w.id, id());
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "sendWidget",
        params: {
          chat_id: "101",
          message_thread_id: 7,
          html: args.html,
          caption: args.caption,
          allow_queries: false,
          is_shared: false,
          protect_content: true,
          reply_parameters: { message_id: 42 },
        },
      });
      expect((await store.read(w.id)).deliveries[0]?.state).toBe("sent");
    });
    test("ordinary ingress/executor stages a widget and commits it beside the text answer, while duplicate updates do nothing", async () => {
      await store.change(w.id, (w) => {
        const prior = w.runs[0];
        if (prior) prior.status = "succeeded";
      });
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [w.id],
      );
      const event = {
        update_id: ++sequence,
        message: {
          message_id: ++sequence,
          date: Math.floor(Date.now() / 1000),
          from: { id: 101, is_bot: false },
          chat: { id: 101, type: "private" as const },
          message_thread_id: 7,
          text: "Make an interactive estimate",
        },
      };
      const ingress = new Ingress(store, setup);
      expect(await ingress.accept(event)).toEqual({ accepted: true });
      expect(await ingress.accept(event)).toEqual({ duplicate: true });
      const next = (await store.read(w.id)).runs.at(-1);
      if (!next) throw Error("missing ingress run");
      const runner: AgentRunner = {
        async run(input) {
          const t = input.tools.find((t) => t.name === "send_telegram_widget");
          if (!t) throw Error("missing widget tool");
          await t.execute("widget", args);
          expect(
            (await store.read(w.id)).deliveries.some((d) => d.widget),
          ).toBe(false);
          return {
            text: args.caption,
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
      expect(saved.deliveries.filter((d) => d.widget)).toHaveLength(1);
      const worker = new DeliveryWorker(store, setup);
      await worker.send(w.id, `run:${next.id}:widget`);
      await worker.send(w.id, `run:${next.id}:result`);
      expect(calls.filter((c) => c.method === "sendWidget")).toHaveLength(1);
      expect(calls.some((c) => c.method === "sendRichMessage")).toBe(true);
    });
    test("confirmed rejection falls back once to caption, ambiguous sends never duplicate it", async () => {
      await ready();
      failure = new TelegramError("telegram_destination_rejected", "permanent");
      const worker = new DeliveryWorker(store, setup);
      await worker.send(w.id, id());
      expect((await store.read(w.id)).deliveries[0]).toMatchObject({
        state: "pending",
        widgetFallback: true,
      });
      await worker.send(w.id, id());
      expect(calls.map((c) => c.method)).toEqual(["sendWidget", "sendMessage"]);
      expect(calls[1]?.params.text).toBe(args.caption);
      expect((await store.read(w.id)).deliveries[0]?.state).toBe("sent");
    });
    test("uncertainty and interrupted sends retain unknown outcomes without retry or fallback", async () => {
      await ready();
      for (const crashed of [false, true]) {
        calls = [];
        await store.change(w.id, (w) => {
          const d = w.deliveries[0];
          if (d) {
            d.state = "pending";
            d.attempts = 0;
          }
        });
        failure = new TelegramError("telegram_outcome_unknown", "unknown");
        if (crashed)
          await store.change(w.id, (w) => {
            const d = w.deliveries[0];
            if (d) {
              d.state = "sending";
              d.startedAt = new Date(0).toISOString();
            }
          });
        const worker = new DeliveryWorker(store, setup);
        await worker.send(w.id, id());
        await worker.send(w.id, id());
        expect((await store.read(w.id)).deliveries[0]?.state).toBe(
          "delivery_unknown",
        );
        expect(calls).toHaveLength(crashed ? 0 : 1);
      }
    });
    test("rate-limit retries honor retry hints and stop at the attempt limit", async () => {
      await ready();
      failure = new TelegramError("telegram_rate_limited", "retry", 30);
      const worker = new DeliveryWorker(store, setup);
      for (let attempt = 1; attempt <= 5; attempt++) {
        await worker.send(w.id, id());
        const d = (await store.read(w.id)).deliveries[0];
        expect(d?.attempts).toBe(attempt);
        if (attempt < 5) {
          expect(Date.parse(d?.nextAt ?? "") - Date.now()).toBeGreaterThan(
            25000,
          );
          await store.change(w.id, (w) => {
            if (w.deliveries[0]) w.deliveries[0].nextAt = undefined;
          });
        }
      }
      expect((await store.read(w.id)).deliveries[0]?.state).toBe("failed");
      expect(calls).toHaveLength(5);
    });
    test("revocation, removed sources, disabled preset, cancellation and bot rotation cancel queued widgets", async () => {
      const baseline = await store.read(w.id);
      for (const change of [
        async () =>
          store.change(w.id, (w) => {
            const m = w.members[0];
            if (m) m.active = false;
          }),
        async () =>
          store.change(w.id, (w) => {
            w.messages = [];
          }),
        async () =>
          store.change(w.id, (w) => {
            const s = w.skills.find((s) => s.draft.slug === "telegram-widgets");
            if (s) s.enabled = false;
          }),
        async () =>
          store.change(w.id, (w) => {
            const r = w.runs[0];
            if (r) r.cancelled = true;
          }),
        async () => {
          const d = await store.deployment();
          if (d.bot) d.bot.id = "1000";
          await store.saveDeployment(store.pool, d);
        },
      ]) {
        await store.save(store.pool, structuredClone(baseline));
        await ready();
        await change();
        await new DeliveryWorker(store, setup).send(w.id, id());
        expect((await store.read(w.id)).deliveries[0]?.state).toBe("cancelled");
      }
      expect(calls).toHaveLength(0);
    });
  },
);
