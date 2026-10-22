import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { login } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Workspace } from "../../src/domain.ts";
import { encrypt, hash, passwordHash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "panel group linking (isolated PostgreSQL)",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const dbName = `repodesk_group_links_${randomUUID().replaceAll("-", "")}`;
    const operatorId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const key = "ab".repeat(32);
    const origin = "http://localhost:3000";
    let store: Store;
    let app: ReturnType<typeof createApp>;
    let ingress: Ingress;
    let setup: SetupService;
    let sequence = 1000;
    let membership = "administrator";
    let credentials: Awaited<ReturnType<typeof login>>;
    let adminCredentials: typeof credentials;
    let memberCredentials: typeof credentials;
    const checks: Record<string, unknown>[] = [];
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(rootUrl ?? "");
      url.pathname = `/${dbName}`;
      store = new Store(database(url.toString()));
      await migrate(store.pool);
      const encoded = await passwordHash("group linking test password");
      for (const [id, username, telegramId, operator] of [
        [operatorId, "operator", null, true],
        [adminId, "admin", "303", false],
        [memberId, "member", "202", false],
      ] as const)
        await store.pool.query(
          "INSERT INTO admins(id,username,password_hash,telegram_id,operator) VALUES($1,$2,$3,$4,$5)",
          [id, username, encoded, telegramId, operator],
        );
      credentials = await login(
        store.pool,
        "operator",
        "group linking test password",
      );
      adminCredentials = await login(
        store.pool,
        "admin",
        "group linking test password",
      );
      memberCredentials = await login(
        store.pool,
        "member",
        "group linking test password",
      );
      setup = new SetupService(store, key, origin, () => ({
        async call<T>(method: string, params = {}) {
          if (method === "getChatMember") checks.push(params);
          return (
            method === "getChatMember"
              ? { status: membership }
              : method === "getMe"
                ? { can_read_all_group_messages: true }
                : { title: "Linked fixture group" }
          ) as T;
        },
      }));
      ingress = new Ingress(store, setup);
      app = createApp(store, setup, origin);
    });
    beforeEach(async () => {
      membership = "administrator";
      checks.length = 0;
      await store.pool.query("DELETE FROM chat_bindings");
      const deployment = await store.deployment();
      await store.pool.query("UPDATE deployment SET data=$1", [
        JSON.stringify({
          ...deployment,
          active: true,
          paused: false,
          bot: { id: "999", username: "fixture_bot", visibleAll: false },
          credentials: { bot: encrypt(key, "bot", "fixture-bot-token") },
        }),
      ]);
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.end();
    });
    async function seed() {
      const w = workspace();
      w.operatorId = operatorId;
      w.chats = [];
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      return w;
    }
    function request(
      path: string,
      session = credentials,
      headers = {},
      body = {},
    ) {
      return app.request(path, {
        method: "POST",
        headers: {
          cookie: `repodesk_session=${session.raw}`,
          origin,
          "x-csrf-token": session.csrf,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    }
    const endpoint = (w: Workspace) =>
      `/api/admin/workspaces/${w.id}/chats/link-token`;
    async function issue(w: Workspace, session = credentials) {
      const response = await request(endpoint(w), session);
      expect(response.status).toBe(201);
      return (await response.json()) as { command: string; expiresAt: string };
    }
    function update(command: string, chatId = -100200, actor = 202) {
      return updateSchema.parse({
        update_id: ++sequence,
        message: {
          message_id: sequence,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: chatId,
            type: "supergroup",
            title: "Linked fixture group",
          },
          from: { id: actor, is_bot: false, first_name: "Group admin" },
          text: command,
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: command.split(" ")[0]?.length,
            },
          ],
        },
      });
    }
    test("an unverified operator issues a command; a regular workspace member links and receives confirmation", async () => {
      const w = await seed();
      await store.change(w.id, (saved) => {
        saved.members = saved.members.filter((member) => member.id === "202");
      });
      const command = await issue(w);
      expect(command.command).toMatch(/^\/link@fixture_bot [A-Za-z0-9_-]{43}$/);
      const raw = command.command.split(" ")[1] ?? "";
      const before = await store.read(w.id);
      expect(before.tokens[0]?.hash).toBe(hash(raw));
      expect(JSON.stringify(before)).not.toContain(raw);
      expect(before.tokens[0]?.botId).toBe("999");
      await ingress.accept(update(command.command));
      const saved = await store.read(w.id);
      expect(saved.chats).toMatchObject([
        { id: "-100200", active: true, collection: false },
      ]);
      expect(saved.tokens).toHaveLength(0);
      expect(saved.members.find((m) => m.id === "202")?.role).toBe("member");
      expect(saved.deliveries.at(-1)?.text).toContain("Group linked.");
      expect(checks).toEqual([{ chat_id: -100200, user_id: 202 }]);
      expect(
        (
          await store.pool.query("SELECT telegram_id FROM admins WHERE id=$1", [
            operatorId,
          ])
        ).rows[0]?.telegram_id,
      ).toBeNull();
      await ingress.accept(update("/ask@fixture_bot hi"));
      expect((await store.read(w.id)).runs).toHaveLength(1);
    });
    test("issuance enforces sessions, CSRF, origin and workspace management authority", async () => {
      const w = await seed();
      expect(
        (await request(endpoint(w), credentials, { cookie: "" })).status,
      ).toBe(401);
      expect(
        (await request(endpoint(w), credentials, { "x-csrf-token": "wrong" }))
          .status,
      ).toBe(403);
      expect(
        (
          await request(endpoint(w), credentials, {
            origin: "https://other.example",
          })
        ).status,
      ).toBe(403);
      expect((await request(endpoint(w), memberCredentials)).status).toBe(403);
      await issue(w, adminCredentials);
      await store.change(w.id, (saved) => {
        saved.members = [];
      });
      expect((await request(endpoint(w), adminCredentials)).status).toBe(403);
      expect(
        (
          await request(
            `/api/admin/workspaces/${randomUUID()}/chats/link-token`,
          )
        ).status,
      ).toBe(404);
    });
    test("foreign operators cannot issue tokens", async () => {
      const w = await seed();
      const otherId = randomUUID();
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
        [otherId, otherId],
      );
      await store.pool.query(
        "UPDATE workspaces SET operator_id=$2::uuid,data=jsonb_set(data,'{operatorId}',to_jsonb($2::text)) WHERE id=$1",
        [w.id, otherId],
      );
      expect((await request(endpoint(w))).status).toBe(403);
      expect((await store.read(w.id)).tokens).toHaveLength(0);
    });
    test("new commands replace old ones; expired and changed-bot commands cannot link", async () => {
      const w = await seed();
      const old = await issue(w);
      const current = await issue(w);
      await ingress.accept(update(old.command));
      expect((await store.read(w.id)).chats).toHaveLength(0);
      await store.change(w.id, (saved) => {
        if (saved.tokens[0])
          saved.tokens[0].expiresAt = new Date(0).toISOString();
      });
      await ingress.accept(update(current.command));
      expect((await store.read(w.id)).chats).toHaveLength(0);
      const next = await issue(w);
      await store.pool.query(
        "UPDATE deployment SET data=jsonb_set(data,'{bot,id}','\"1000\"'::jsonb)",
      );
      await ingress.accept(update(next.command));
      expect((await store.read(w.id)).chats).toHaveLength(0);
    });
    test("a token does not bypass Telegram administration, membership, anonymous or bot-sender boundaries", async () => {
      const w = await seed();
      const command = await issue(w);
      membership = "member";
      await ingress.accept(update(command.command));
      membership = "administrator";
      await ingress.accept(update(command.command, -100200, 404));
      const anonymous = update(command.command);
      if (anonymous.message)
        anonymous.message.sender_chat = anonymous.message.chat;
      await ingress.accept(anonymous);
      const bot = update(command.command);
      if (bot.message?.from) bot.message.from.is_bot = true;
      await ingress.accept(bot);
      expect((await store.read(w.id)).chats).toHaveLength(0);
      expect(
        (await store.read(w.id)).members.find((m) => m.id === "404"),
      ).toBeUndefined();
      expect((await store.read(w.id)).tokens).toHaveLength(1);
      await ingress.accept(update(command.command));
      expect((await store.read(w.id)).chats).toHaveLength(1);
    });
    test("revoking the issuing administrator invalidates outstanding commands", async () => {
      const w = await seed();
      const command = await issue(w, adminCredentials);
      await store.change(w.id, (saved) => {
        const m = saved.members.find((m) => m.id === "303");
        if (m) m.active = false;
      });
      await ingress.accept(update(command.command));
      expect((await store.read(w.id)).chats).toHaveLength(0);
    });
    test("duplicates and concurrent different-group redemptions bind only one group and confirm once", async () => {
      const w = await seed();
      const command = await issue(w);
      const first = update(command.command);
      await Promise.all([
        ingress.accept(first),
        ingress.accept(first),
        ingress.accept(update(command.command, -100201)),
      ]);
      const saved = await store.read(w.id);
      expect(saved.chats).toHaveLength(1);
      expect(
        saved.deliveries.filter((d) => d.text.startsWith("Group linked.")),
      ).toHaveLength(1);
      expect(
        (
          await store.pool.query(
            "SELECT * FROM chat_bindings WHERE workspace_id=$1",
            [w.id],
          )
        ).rowCount,
      ).toBe(1);
      expect((await request(endpoint(w))).status).toBe(409);
    });
    test("an unverified panel operator can inspect visibility and unlink before issuing a fresh command", async () => {
      const w = await seed();
      const command = await issue(w);
      await ingress.accept(update(command.command, -100300));
      const base = `/api/admin/workspaces/${w.id}/chats/-100300`;
      expect((await request(`${base}/visibility`)).status).toBe(200);
      expect(
        (
          await request(
            `${base}/action`,
            credentials,
            {},
            { action: "collect" },
          )
        ).status,
      ).toBe(200);
      expect(
        (await request(`${base}/action`, credentials, {}, { action: "unlink" }))
          .status,
      ).toBe(200);
      expect((await store.read(w.id)).chats[0]?.active).toBe(false);
      await issue(w);
    });
    test("a token cannot take a group from another workspace", async () => {
      const first = await seed();
      const firstCommand = await issue(first);
      await ingress.accept(update(firstCommand.command, -100500));
      const second = await seed();
      const secondCommand = await issue(second);
      await ingress.accept(update(secondCommand.command, -100500));
      expect((await store.read(second.id)).chats).toHaveLength(0);
      expect(
        (
          await store.pool.query(
            "SELECT workspace_id FROM chat_bindings WHERE chat_id='-100500'",
          )
        ).rows[0]?.workspace_id,
      ).toBe(first.id);
      await ingress.accept(update(secondCommand.command, -100501));
      expect((await store.read(second.id)).chats[0]?.id).toBe("-100501");
    });
    test("paused deployments and deleted workspaces cannot redeem commands", async () => {
      const w = await seed();
      const command = await issue(w);
      await store.pool.query(
        "UPDATE deployment SET data=jsonb_set(data,'{paused}','true'::jsonb)",
      );
      await ingress.accept(update(command.command, -100600));
      expect((await store.read(w.id)).chats).toHaveLength(0);
      expect((await store.read(w.id)).tokens).toHaveLength(1);
      await store.pool.query(
        "UPDATE deployment SET data=jsonb_set(data,'{paused}','false'::jsonb)",
      );
      await store.change(w.id, (saved) => {
        saved.deletion = {
          requestedAt: new Date().toISOString(),
          providerState: "pending",
        };
      });
      expect((await request(endpoint(w))).status).toBe(403);
      await ingress.accept(update(command.command, -100600));
      expect((await store.read(w.id)).chats).toHaveLength(0);
    });
    test("legacy private /linktoken commands remain actor-bound and require workspace admin authority", async () => {
      const w = await seed();
      await store.change(w.id, (saved) => {
        saved.tokens.push({
          kind: "group",
          hash: hash("legacy"),
          actor: "303",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
      });
      await ingress.accept(update("/link legacy", -100400, 202));
      expect((await store.read(w.id)).chats).toHaveLength(0);
      await ingress.accept(update("/link legacy", -100400, 303));
      expect((await store.read(w.id)).chats).toHaveLength(1);
    });
  },
);
