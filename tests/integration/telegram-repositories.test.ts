import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Delivery, Workspace } from "../../src/domain.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { type Update, updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "Telegram repository picker (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `repodesk_repos_${randomUUID().replaceAll("-", "")}`;
    const operatorId = randomUUID(),
      key = "ad".repeat(32);
    let store: Store, ingress: Ingress, worker: DeliveryWorker;
    let sequence = 100000;
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const telegram: Telegram = {
      async downloadFile() {
        throw Error("not used");
      },
      async call<T>(method: string, params: Record<string, unknown> = {}) {
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
      const setup = new SetupService(
        store,
        key,
        "http://localhost:3000",
        () => telegram,
      );
      ingress = new Ingress(store, setup);
      worker = new DeliveryWorker(store, setup);
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function seed() {
      calls.length = 0;
      const w = workspace();
      w.operatorId = operatorId;
      w.github = {
        revision: 1,
        installationId: 7,
        repositories: [
          { id: 1, full_name: "example/first", private: false },
          { id: 2, full_name: "example/private", private: true },
        ],
      };
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [w.id],
      );
      await store.pool.query(
        "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES('-100100',$1) ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id",
        [w.id],
      );
      return w;
    }
    function message(text: string, topic = 21, chat = 101) {
      return updateSchema.parse({
        update_id: ++sequence,
        message: {
          message_id: ++sequence,
          date: Math.floor(Date.now() / 1000),
          from: { id: 101, is_bot: false },
          chat: { id: chat, type: chat === 101 ? "private" : "supergroup" },
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
        },
      });
    }
    function callback(d: Delivery, data = d.buttons?.[0]?.[0]?.callback_data) {
      return updateSchema.parse({
        update_id: ++sequence,
        callback_query: {
          id: `callback:${sequence}`,
          from: { id: 101, is_bot: false },
          data,
          message: {
            message_id: d.remoteId,
            date: Math.floor(Date.now() / 1000),
            from: { id: 999, is_bot: true },
            chat: {
              id: Number(d.chatId),
              type: d.chatId === "101" ? "private" : "supergroup",
            },
            message_thread_id: d.topicId,
          },
        },
      });
    }
    async function open(w: Workspace, text = "/repos", topic = 21, chat = 101) {
      const update = message(text, topic, chat);
      await ingress.accept(update);
      const id = `repos:999:${update.update_id}`;
      await worker.send(w.id, id);
      const d = (await store.read(w.id)).deliveries.find((d) => d.id === id);
      if (!d) throw Error("missing menu");
      return { d, update };
    }

    test("command and click persist, deduplicate and bind default context to just this topic", async () => {
      const w = await seed();
      const { d, update } = await open(w);
      expect(d.state).toBe("sent");
      expect(
        calls.find((c) => c.method === "sendMessage")?.params,
      ).toMatchObject({
        message_thread_id: 21,
        reply_markup: { inline_keyboard: d.buttons },
      });
      expect(await ingress.accept(update)).toEqual({ duplicate: true });
      const click = callback(d, d.buttons?.[1]?.[0]?.callback_data);
      await ingress.accept(click);
      expect(await ingress.accept(click)).toEqual({ duplicate: true });
      expect(
        calls.filter((c) => c.method === "answerCallbackQuery"),
      ).toHaveLength(2);
      expect(
        calls.find((c) => c.method === "answerCallbackQuery")?.params.text,
      ).toBe("");
      const selected = await store.read(w.id);
      expect(selected.repositorySelections?.[0]).toMatchObject({
        actor: "101",
        chatId: "101",
        topicId: 21,
        repositoryId: 2,
        botId: "999",
      });
      expect(
        selected.deliveries.filter((d) => d.id.endsWith(":selected")),
      ).toHaveLength(1);
      await ingress.accept(message("Explain the code"));
      await ingress.accept(message("Explain another topic", 22));
      const runs = (await store.read(w.id)).runs;
      expect(runs[0]?.repository?.id).toBe(2);
      expect(runs[1]?.repository).toBeUndefined();
      const reopened = await open(w);
      expect(reopened.d.text).toContain("Selected: example/private");
      expect(reopened.d.buttons?.[0]?.[0]?.text).toBe("✓ example/private");
      await ingress.accept(
        callback(reopened.d, reopened.d.buttons?.at(-1)?.[0]?.callback_data),
      );
      expect((await store.read(w.id)).repositorySelections).toEqual([]);
    });

    test("search and group menus hide private repositories, forged other-user clicks are rejected", async () => {
      const w = await seed();
      const group = await open(w, "/repos@test_bot", 9, -100100);
      expect(group.d.buttons?.flat().map((b) => b.text)).toEqual([
        "example/first",
      ]);
      const forged: Update = callback(group.d);
      if (forged.callback_query) forged.callback_query.from.id = 202;
      await ingress.accept(forged);
      expect((await store.read(w.id)).repositorySelections).toBeUndefined();
      expect(calls.at(-1)?.params.text).toContain("current access");
      const found = await open(w, "/repos PRIVATE");
      expect(found.d.buttons?.flat().map((b) => b.text)).toEqual([
        "example/private",
      ]);
      const missing = await open(w, "/repos missing");
      expect(missing.d.buttons).toBeUndefined();
      expect(missing.d.text).toContain("Try /repos");
    });

    test("repository removal before delivery cancels the menu; changes before click require fresh choices", async () => {
      const w = await seed();
      const update = message("/repos");
      await ingress.accept(update);
      await store.change(w.id, (w) => {
        if (w.github) w.github.repositories = [];
      });
      const id = `repos:999:${update.update_id}`;
      await worker.send(w.id, id);
      expect(
        (await store.read(w.id)).deliveries.find((d) => d.id === id)?.state,
      ).toBe("cancelled");
      expect(calls.some((c) => c.method === "sendMessage")).toBe(false);
      const fresh = await seed();
      const { d } = await open(fresh);
      await store.change(fresh.id, (w) => {
        if (w.github) w.github.revision++;
      });
      await ingress.accept(callback(d));
      expect((await store.read(fresh.id)).repositorySelections).toBeUndefined();
      expect(calls.at(-1)?.params.text).toContain("Send /repos");
    });

    test("non-members and paused workspaces cannot open a repository picker", async () => {
      const w = await seed();
      const denied = message("/repos");
      if (denied.message?.from) denied.message.from.id = 404;
      if (denied.message) denied.message.chat.id = 404;
      await ingress.accept(denied);
      expect(
        (await store.read(w.id)).deliveries.some((d) =>
          d.id.startsWith("repos:"),
        ),
      ).toBe(false);
      await store.change(w.id, (w) => {
        w.settings.paused = true;
      });
      await ingress.accept(message("/repos"));
      expect(
        (await store.read(w.id)).deliveries.some((d) =>
          d.id.startsWith("repos:"),
        ),
      ).toBe(false);
    });
  },
);
