import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { type Admin, settingsSchema } from "../../src/domain.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import {
  type Telegram,
  type TelegramCallOptions,
  TelegramError,
} from "../../src/telegram/client.ts";
import { TelegramPoller } from "../../src/telegram/polling.ts";
import { newWorkspace } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "Telegram polling (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `deepx_polling_${randomUUID().replaceAll("-", "")}`;
    const key = "ac".repeat(32);
    const admin: Admin = {
      id: randomUUID(),
      username: "operator",
      operator: true,
    };
    let store: Store;
    let setup: SetupService;
    let poller: TelegramPoller;
    let calls: { method: string; params: Record<string, unknown> }[];
    let webhook: string;
    let updates: (
      params: Record<string, unknown>,
      options?: TelegramCallOptions,
    ) => Promise<unknown>;
    const signal = () => new AbortController().signal;
    const telegram: Telegram = {
      async call<T>(
        method: string,
        params = {},
        options?: TelegramCallOptions,
      ) {
        calls.push({ method, params });
        return (
          method === "getWebhookInfo"
            ? { url: webhook }
            : await updates(params, options)
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
        "polling",
      );
    });
    beforeEach(async () => {
      await store.pool.query(
        "TRUNCATE telegram_polling, admins, workspaces, inbox, outbox, sessions, telegram_selections, chat_bindings, control_deliveries CASCADE",
      );
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'operator','unused',true)",
        [admin.id],
      );
      const d = await store.deployment();
      Object.assign(d, {
        active: false,
        webhookReady: false,
        bot: { id: "999", username: "test_bot", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:test-token"),
          model: encrypt(key, "model", "test-model-key"),
          webhook: encrypt(key, "webhook", "test-webhook-secret"),
        },
      });
      await store.saveDeployment(store.pool, d);
      calls = [];
      webhook = "";
      updates = async () => [];
      poller = new TelegramPoller(store, setup);
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function state() {
      return (
        await store.pool.query(
          "SELECT * FROM telegram_polling WHERE bot_id='999'",
        )
      ).rows[0];
    }
    async function seed(verified = true) {
      const w = verified
        ? workspace()
        : newWorkspace(
            admin.id,
            settingsSchema.parse({
              name: "Polling team",
              timezone: "Asia/Taipei",
            }),
          );
      w.operatorId = admin.id;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      return w;
    }
    function message(id: number, text: string, actor = 101) {
      return {
        update_id: id,
        message: {
          message_id: id,
          date: 1,
          chat: { id: actor, type: "private" },
          from: { id: actor, is_bot: false },
          text,
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: text.split(" ")[0]?.length,
            },
          ],
        },
      };
    }
    test("polls before activation, persists cursor across restart and deduplicates updates", async () => {
      updates = async () => [
        { update_id: 10 },
        { update_id: 10 },
        { update_id: 11 },
      ];
      await poller.pollOnce(signal());
      expect((await state()).next_offset).toBe("12");
      expect((await store.pool.query("SELECT * FROM inbox")).rowCount).toBe(2);
      expect((await setup.progress(admin)).receiver.ready).toBe(true);
      updates = async (params) => {
        expect(params.offset).toBe(12);
        expect(params.timeout).toBe(25);
        return [];
      };
      await new TelegramPoller(store, setup).pollOnce(signal());
      expect(
        calls.some(
          (c) => c.method === "setWebhook" || c.method === "deleteWebhook",
        ),
      ).toBe(false);
    });
    test("crash after acceptance replays safely without advancing over a failed cursor save", async () => {
      await store.pool.query(
        "CREATE FUNCTION fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.next_offset=21 THEN RAISE EXCEPTION 'fixture write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_cursor BEFORE UPDATE ON telegram_polling FOR EACH ROW EXECUTE FUNCTION fail_cursor()",
      );
      try {
        updates = async () => [{ update_id: 20 }, { update_id: 21 }];
        await expect(poller.pollOnce(signal())).rejects.toThrow();
        expect((await state()).next_offset).toBeNull();
        expect((await store.pool.query("SELECT * FROM inbox")).rowCount).toBe(
          1,
        );
      } finally {
        await store.pool.query(
          "DROP TRIGGER fail_cursor ON telegram_polling; DROP FUNCTION fail_cursor()",
        );
      }
      await store.pool.query("UPDATE telegram_polling SET retry_at=NULL");
      await new TelegramPoller(store, setup).pollOnce(signal());
      expect((await state()).next_offset).toBe("22");
      expect((await store.pool.query("SELECT * FROM inbox")).rowCount).toBe(2);
    });
    test("only one worker polls at a time and releases ownership after shutdown", async () => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<unknown>();
      updates = async (_params, options) => {
        entered.resolve();
        options?.signal?.addEventListener(
          "abort",
          () => gate.reject(options.signal?.reason),
          { once: true },
        );
        return gate.promise;
      };
      const abort = new AbortController();
      const first = poller.pollOnce(abort.signal);
      await entered.promise;
      await new TelegramPoller(store, setup).pollOnce(signal());
      expect(calls.filter((c) => c.method === "getUpdates")).toHaveLength(1);
      abort.abort();
      await expect(first).rejects.toThrow();
      updates = async () => [];
      await store.pool.query("UPDATE telegram_polling SET retry_at=NULL");
      await new TelegramPoller(store, setup).pollOnce(signal());
      expect((await setup.progress(admin)).receiver.ready).toBe(true);
    });
    test("existing webhook blocks polling without removing it or dropping updates", async () => {
      webhook = "https://other.example/telegram";
      await expect(poller.pollOnce(signal())).rejects.toThrow(
        "polling_webhook_conflict",
      );
      expect(calls.map((c) => c.method)).toEqual(["getWebhookInfo"]);
      expect((await setup.progress(admin)).receiver).toEqual({
        ready: false,
        error: "polling_webhook_conflict",
      });
    });
    test("rate limits persist across workers and errors do not expose message contents", async () => {
      updates = async () => {
        throw new TelegramError("telegram_rate_limited", "retry", 60);
      };
      await expect(poller.pollOnce(signal())).rejects.toThrow(
        "telegram_rate_limited",
      );
      await new TelegramPoller(store, setup).pollOnce(signal());
      expect(calls.filter((c) => c.method === "getUpdates")).toHaveLength(1);
      expect((await state()).ready_at).toBeNull();
      await store.pool.query("UPDATE telegram_polling SET retry_at=NULL");
      updates = async () => [
        { update_id: 1, message: { text: "private malformed content" } },
      ];
      await expect(poller.pollOnce(signal())).rejects.toThrow();
      const progress = JSON.stringify(await setup.progress(admin));
      expect(progress).toContain("polling_invalid_update");
      expect(progress).not.toContain("private malformed content");
      expect(progress).not.toContain("test-token");
      expect((await state()).next_offset).toBeNull();
    });
    test("idle cursor resets after a week so randomized lower update IDs are received", async () => {
      updates = async () => [{ update_id: 1000 }];
      await poller.pollOnce(signal());
      await store.pool.query(
        "UPDATE telegram_polling SET last_update_at=now()-interval '8 days'",
      );
      updates = async (params) => {
        expect(params.offset).toBeUndefined();
        return [{ update_id: 5 }];
      };
      await poller.pollOnce(signal());
      expect((await state()).next_offset).toBe("6");
    });
    test("polling readiness expires and token rotation invalidates old readiness", async () => {
      await seed();
      await poller.pollOnce(signal());
      expect((await setup.activate(admin)).active).toBe(true);
      await store.pool.query(
        "UPDATE telegram_polling SET ready_at=now()-interval '61 seconds'",
      );
      await expect(setup.activate(admin)).rejects.toThrow("setup_incomplete");
      await poller.pollOnce(signal());
      const d = await store.deployment();
      d.credentials.bot = encrypt(key, "bot", "999:rotated-token");
      await store.saveDeployment(store.pool, d);
      expect((await setup.progress(admin)).receiver.ready).toBe(false);
    });
    test("owner verification uses existing policy; pre-activation messages cannot start runs", async () => {
      const w = await seed(false);
      const token = await setup.identityToken(admin, w.id);
      updates = async () => [
        message(1, "/ask hello"),
        message(2, token.command),
        message(3, "/ask hello"),
      ];
      await poller.pollOnce(signal());
      const saved = await store.read(w.id);
      expect(saved.members.find((m) => m.id === "101")?.role).toBe("owner");
      expect(saved.policy.allowed).toContain("101");
      expect(saved.runs).toHaveLength(0);
      expect(saved.tokens).toHaveLength(0);
      expect(
        (
          await store.pool.query("SELECT telegram_id FROM admins WHERE id=$1", [
            admin.id,
          ])
        ).rows[0].telegram_id,
      ).toBe("101");
      await setup.activate(admin);
      updates = async () => [
        message(4, "/ask unauthorized", 777),
        message(5, "/ask authorized"),
      ];
      await poller.pollOnce(signal());
      const active = await store.read(w.id);
      expect(active.runs).toHaveLength(1);
      expect(active.runs[0]?.actor).toBe("101");
    });
    test("polling cannot bypass owner/skill checks, and webhook mode retains its requirements", async () => {
      await seed(false);
      await poller.pollOnce(signal());
      await expect(setup.activate(admin)).rejects.toThrow(
        "verified_owner_and_skill_required",
      );
      await expect(setup.register(admin)).rejects.toThrow(
        "webhook_disabled_in_polling_mode",
      );
      const app = createApp(store, setup, "http://localhost:3000");
      expect(
        (
          await app.request("/telegram/webhook", {
            method: "POST",
            headers: {
              "x-telegram-bot-api-secret-token": "test-webhook-secret",
            },
            body: JSON.stringify({ update_id: 10 }),
          })
        ).status,
      ).toBe(409);
      const webhookSetup = new SetupService(
        store,
        key,
        "https://example.test",
        () => telegram,
      );
      expect((await webhookSetup.progress(admin)).receiver.ready).toBe(false);
      await expect(webhookSetup.activate(admin)).rejects.toThrow(
        "setup_incomplete",
      );
      await expect(
        new TelegramPoller(store, webhookSetup).pollOnce(signal()),
      ).rejects.toThrow("polling_disabled");
      await expect(
        setup.progress({ ...admin, operator: false }),
      ).rejects.toThrow();
    });
  },
);
