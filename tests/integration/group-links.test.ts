import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
    let privacyDisabled = true;
    let botMembership = "member";
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
        async call<T>(method: string, params: Record<string, unknown> = {}) {
          if (method === "getChatMember") checks.push(params);
          return (
            method === "getChatMember"
              ? {
                  status: params.user_id === "999" ? botMembership : membership,
                }
              : method === "getMe"
                ? { can_read_all_group_messages: privacyDisabled }
                : { title: "Linked fixture group" }
          ) as T;
        },
      }));
      ingress = new Ingress(store, setup);
      app = createApp(store, setup, origin);
    });
    beforeEach(async () => {
      membership = "administrator";
      privacyDisabled = true;
      botMembership = "member";
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
        {
          id: "-100200",
          active: true,
          collection: true,
          visibleAll: true,
          consentBy: "202",
        },
      ]);
      expect(saved.chats[0]?.consentAt).toBe(saved.chats[0]?.linkedAt);
      expect(saved.tokens).toHaveLength(0);
      expect(saved.members.find((m) => m.id === "202")?.role).toBe("member");
      expect(saved.deliveries.at(-1)?.text).toContain("Group linked.");
      expect(saved.deliveries.at(-1)?.text).toContain(
        "Received group messages are collected for context.",
      );
      expect(saved.deliveries.at(-1)?.text).not.toContain("/capture on");
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
    test("linking collects received non-member messages by default; duplicate updates and explicit opt-out remain respected", async () => {
      const w = await seed();
      await ingress.accept(update((await issue(w)).command));
      const ordinary = update("Team discussion", -100200, 404);
      if (ordinary.message) ordinary.message.entities = undefined;
      await ingress.accept(ordinary);
      await ingress.accept(ordinary);
      const collected = (await store.read(w.id)).messages.filter(
        (message) => message.author === "404",
      );
      expect(collected).toHaveLength(1);
      expect(collected[0]?.directed).toBe(false);
      expect((await store.read(w.id)).runs).toHaveLength(0);
      const response = await request(
        `/api/admin/workspaces/${w.id}/chats/-100200/action`,
        credentials,
        {},
        { action: "directed" },
      );
      expect(response.status).toBe(200);
      const later = update("Later discussion", -100200, 404);
      if (later.message) later.message.entities = undefined;
      await ingress.accept(later);
      expect(
        (await store.read(w.id)).messages.filter(
          (message) => message.author === "404",
        ),
      ).toHaveLength(1);
      expect((await store.read(w.id)).chats[0]?.collection).toBe(false);
    });
    test("visibility recognizes group admins and never changes the saved collection choice", async () => {
      const w = await seed();
      privacyDisabled = false;
      botMembership = "administrator";
      await ingress.accept(update((await issue(w)).command));
      const base = `/api/admin/workspaces/${w.id}/chats/-100200`;
      expect((await store.read(w.id)).chats[0]?.visibleAll).toBe(true);
      expect(
        (
          await request(
            `${base}/action`,
            credentials,
            {},
            { action: "directed" },
          )
        ).status,
      ).toBe(200);
      expect((await request(`${base}/visibility`)).status).toBe(200);
      expect((await store.read(w.id)).chats[0]?.collection).toBe(false);
      botMembership = "member";
      expect((await request(`${base}/visibility`)).status).toBe(200);
      expect((await store.read(w.id)).chats[0]?.visibleAll).toBe(false);
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
      expect((await request(`${base}/visibility`)).status).toBe(200);
      expect((await store.read(w.id)).chats[0]?.collection).toBe(true);
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
    test("one command binds only one group under concurrent redemption; fresh commands add more groups", async () => {
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
      const next = await issue(w);
      await ingress.accept(update(next.command, -100202));
      await ingress.accept(update(next.command, -100203));
      const after = await store.read(w.id);
      expect(after.chats).toHaveLength(2);
      expect(after.chats.every((chat) => chat.active)).toBe(true);
      expect(after.chats.some((chat) => chat.id === "-100203")).toBe(false);
      expect(
        after.deliveries.filter((d) => d.text.startsWith("Group linked.")),
      ).toHaveLength(2);
      expect(
        (
          await store.pool.query(
            "SELECT * FROM chat_bindings WHERE workspace_id=$1",
            [w.id],
          )
        ).rowCount,
      ).toBe(2);
    });
    test("the migration preserves existing bindings, permits multiple groups and keeps group ownership exclusive", async () => {
      const client = await store.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "CREATE TEMP TABLE chat_bindings(chat_id text PRIMARY KEY, workspace_id uuid NOT NULL UNIQUE)",
        );
        const id = randomUUID();
        await client.query("INSERT INTO chat_bindings VALUES('-1001',$1)", [
          id,
        ]);
        const migration = await readFile(
          "migrations/021_multiple_groups.sql",
          "utf8",
        );
        await client.query(migration);
        await client.query(migration);
        await client.query("INSERT INTO chat_bindings VALUES('-1002',$1)", [
          id,
        ]);
        expect(
          (await client.query("SELECT * FROM chat_bindings ORDER BY chat_id"))
            .rows,
        ).toEqual([
          { chat_id: "-1001", workspace_id: id },
          { chat_id: "-1002", workspace_id: id },
        ]);
        await expect(
          client.query("INSERT INTO chat_bindings VALUES('-1001',$1)", [
            randomUUID(),
          ]),
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    test("group settings, conversations and unlinking stay scoped to the selected group", async () => {
      const w = await seed();
      for (const chatId of [-100700, -100701])
        await ingress.accept(update((await issue(w)).command, chatId));
      const first = `/api/admin/workspaces/${w.id}/chats/-100700`;
      expect(
        (
          await request(
            `${first}/action`,
            credentials,
            {},
            { action: "directed" },
          )
        ).status,
      ).toBe(200);
      privacyDisabled = false;
      expect((await request(`${first}/visibility`)).status).toBe(200);
      const before = await store.read(w.id);
      expect(before.chats.find((chat) => chat.id === "-100700")).toMatchObject({
        collection: false,
        visibleAll: false,
      });
      const other = before.chats.find((chat) => chat.id === "-100701");
      expect(other).toMatchObject({
        active: true,
        collection: true,
        visibleAll: true,
      });
      await ingress.accept(
        update("/ask@fixture_bot First group question", -100700),
      );
      await ingress.accept(
        update("/ask@fixture_bot Second group question", -100701),
      );
      const conversations = (await store.read(w.id)).runs;
      expect(conversations).toHaveLength(2);
      expect(new Set(conversations.map((run) => run.threadId)).size).toBe(2);
      for (const run of conversations)
        expect(
          run.sources.every((source) => source.chatId === run.chatId),
        ).toBe(true);
      expect(
        (
          await request(
            `${first}/action`,
            credentials,
            {},
            { action: "unlink" },
          )
        ).status,
      ).toBe(200);
      const saved = await store.read(w.id);
      expect(saved.chats.find((chat) => chat.id === "-100700")?.active).toBe(
        false,
      );
      expect(saved.chats.find((chat) => chat.id === "-100701")).toEqual(other);
      expect(saved.runs.find((run) => run.chatId === "-100700")?.status).toBe(
        "cancelled",
      );
      expect(saved.runs.find((run) => run.chatId === "-100701")?.status).toBe(
        "queued",
      );
      expect(
        (
          await store.pool.query(
            "SELECT chat_id FROM chat_bindings WHERE workspace_id=$1",
            [w.id],
          )
        ).rows,
      ).toEqual([{ chat_id: "-100701" }]);
      await ingress.accept(update("/ask@fixture_bot Still connected", -100701));
      expect((await store.read(w.id)).runs).toHaveLength(3);
      await ingress.accept(update((await issue(w)).command, -100700));
      const relinked = await store.read(w.id);
      expect(relinked.chats).toHaveLength(2);
      expect(relinked.chats.every((chat) => chat.active)).toBe(true);
      expect(relinked.chats.find((chat) => chat.id === "-100701")).toEqual(
        other,
      );
    });
    test("group migration and bot removal leave other group bindings usable", async () => {
      const w = await seed();
      for (const chatId of [-100800, -100801, -100802])
        await ingress.accept(update((await issue(w)).command, chatId));
      const migration = update("", -100800);
      if (migration.message) migration.message.migrate_to_chat_id = -100900;
      await ingress.accept(migration);
      await ingress.accept(
        updateSchema.parse({
          update_id: ++sequence,
          my_chat_member: {
            chat: { id: -100801, type: "supergroup" },
            from: { id: 202, is_bot: false },
            date: Math.floor(Date.now() / 1000),
            old_chat_member: {
              user: { id: 999, is_bot: true },
              status: "member",
            },
            new_chat_member: {
              user: { id: 999, is_bot: true },
              status: "left",
            },
          },
        }),
      );
      const saved = await store.read(w.id);
      expect(
        saved.chats.filter((chat) => chat.active).map((chat) => chat.id),
      ).toEqual(["-100802"]);
      expect(
        (
          await store.pool.query(
            "SELECT workspace_id FROM chat_bindings WHERE chat_id='-100802'",
          )
        ).rows[0]?.workspace_id,
      ).toBe(w.id);
      await ingress.accept(update("/ask@fixture_bot Still connected", -100802));
      expect((await store.read(w.id)).runs.at(-1)?.chatId).toBe("-100802");
      await ingress.accept(update((await issue(w)).command, -100900));
      expect(
        (await store.read(w.id)).chats.filter((chat) => chat.active),
      ).toHaveLength(2);
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
      await ingress.accept(update((await issue(second)).command, -100502));
      const secondCommand = await issue(second);
      await ingress.accept(update(secondCommand.command, -100500));
      expect(
        (await store.read(second.id)).chats.map((chat) => chat.id),
      ).toEqual(["-100502"]);
      expect(
        (
          await store.pool.query(
            "SELECT workspace_id FROM chat_bindings WHERE chat_id='-100500'",
          )
        ).rows[0]?.workspace_id,
      ).toBe(first.id);
      await ingress.accept(update(secondCommand.command, -100501));
      expect(
        (await store.read(second.id)).chats.map((chat) => chat.id),
      ).toEqual(["-100502", "-100501"]);
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
      await ingress.accept(update((await issue(w)).command, -100399));
      await store.change(w.id, (saved) => {
        saved.tokens.push({
          kind: "group",
          hash: hash("legacy"),
          actor: "303",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
      });
      await ingress.accept(update("/link legacy", -100400, 202));
      expect((await store.read(w.id)).chats).toHaveLength(1);
      await ingress.accept(update("/link legacy", -100400, 303));
      expect((await store.read(w.id)).chats).toHaveLength(2);
    });
  },
);
