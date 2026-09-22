import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { claim, issueClaim, session } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { deliverAccessHelp } from "../../src/jobs/control.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { sweep } from "../../src/privacy/service.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Update } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { eligible } from "../../src/workspaces/policy.ts";
import { workspace } from "../fixtures.ts";

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing test fixture");
  return value;
}
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Telegram access requests", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `deepx_access_${randomUUID().replaceAll("-", "")}`;
  const key = "ab".repeat(32);
  const origin = "http://localhost:3000";
  let store: Store;
  let setup: SetupService;
  let ingress: Ingress;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let csrf: string;
  let adminId: string;
  let w = workspace();
  let updateId = 0;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    const auth = await claim(
      store.pool,
      await issueClaim(store.pool),
      "accessadmin",
      "a long test password",
    );
    cookie = `deepx_session=${auth.raw}`;
    csrf = auth.csrf;
    adminId = required(await session(store.pool, auth.raw)).admin.id;
    await store.pool.query("UPDATE admins SET telegram_id='101' WHERE id=$1", [
      adminId,
    ]);
    const d = await store.deployment();
    d.active = true;
    d.bot = { id: "999", username: "fixture_bot", visibleAll: true };
    d.credentials.bot = encrypt(key, "bot", "999:fake-token");
    await store.saveDeployment(store.pool, d);
    setup = new SetupService(store, key, origin, () => ({
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });
        return { message_id: 123 } as T;
      },
    }));
    ingress = new Ingress(store, setup);
    app = createApp(store, setup, origin);
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  beforeEach(async () => {
    await store.pool.query("TRUNCATE workspaces CASCADE");
    await store.pool.query("DELETE FROM control_deliveries");
    w = workspace();
    w.operatorId = adminId;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, adminId, JSON.stringify(w)],
    );
    calls.length = 0;
  });
  const api = (path: string, method = "GET", body?: unknown, headers = {}) =>
    app.request(`/api/admin/workspaces/${path}`, {
      method,
      headers: {
        cookie,
        origin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const message = (actor = 404, text = "/start", chat = actor): Update => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat, type: chat === actor ? "private" : "supergroup" },
      from: {
        id: actor,
        is_bot: false,
        first_name: "New user",
        username: "new_user",
      },
      text,
      entities: text.startsWith("/")
        ? [
            {
              type: "bot_command",
              offset: 0,
              length: required(text.split(" ")[0]).length,
            },
          ]
        : [],
    },
  });
  test("member profiles follow the actual sender, persist in both APIs and respect duplicate events", async () => {
    const update = message(202, "/help");
    await ingress.accept(update);
    const current = await store.read(w.id);
    expect(current.members.find((m) => m.id === "202")).toMatchObject({
      username: "new_user",
      name: "New user",
    });
    expect(
      current.members.find((m) => m.id === "101")?.username,
    ).toBeUndefined();
    expect(current.policy).toEqual(w.policy);
    const duplicate = structuredClone(update);
    required(required(duplicate.message).from).username = "replayed_name";
    expect(await ingress.accept(duplicate)).toEqual({ duplicate: true });
    for (const resource of ["members", "access-policy"]) {
      const response = await api(`${w.id}/${resource}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(
        (body.items ?? body.members).find((m: { id: string }) => m.id === "202")
          .username,
      ).toBe("new_user");
    }
    const renamed = message(202, "/help");
    required(required(renamed.message).from).username = undefined;
    required(required(renamed.message).from).first_name = "Renamed user";
    await ingress.accept(renamed);
    expect(
      (await store.read(w.id)).members.find((m) => m.id === "202"),
    ).toMatchObject({ name: "Renamed user" });
    expect(
      (await store.read(w.id)).members.find((m) => m.id === "202")?.username,
    ).toBeUndefined();
  });
  test("anonymous senders and profiles in another workspace cannot change a member", async () => {
    const anonymous = message(202, "/help");
    required(anonymous.message).sender_chat = {
      id: -100100,
      type: "supergroup",
    };
    await ingress.accept(anonymous);
    expect(
      (await store.read(w.id)).members.find((m) => m.id === "202")?.username,
    ).toBeUndefined();
    const other = workspace();
    other.operatorId = adminId;
    other.members = [{ id: "202", active: true, role: "owner" }];
    other.policy.allowed = ["202"];
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [other.id, adminId, JSON.stringify(other)],
    );
    await store.pool.query(
      "INSERT INTO telegram_selections(actor,workspace_id) VALUES('202',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
      [w.id],
    );
    await ingress.accept(message(202, "/help"));
    expect(
      (await store.read(w.id)).members.find((m) => m.id === "202")?.username,
    ).toBe("new_user");
    expect((await store.read(other.id)).members[0]?.username).toBeUndefined();
    expect((await api(`${other.id}/members`)).status).toBe(403);
  });
  const callback = (actor = 404, target = w.id, chat = actor): Update => ({
    update_id: ++updateId,
    callback_query: {
      id: `callback-${updateId}`,
      data: `request_access:${target}`,
      from: {
        id: actor,
        is_bot: false,
        first_name: "New user",
        username: "new_user",
      },
      message: {
        message_id: 123,
        date: 1,
        chat: { id: chat, type: chat === actor ? "private" : "supergroup" },
        from: { id: 999, is_bot: true },
      },
    },
  });
  test("unauthorized DM offers a button, duplicates stay pending, approval grants and notifies once", async () => {
    await ingress.accept(message());
    await deliverAccessHelp(store, setup);
    expect(
      calls.find((c) => c.method === "sendMessage")?.params.reply_markup,
    ).toEqual({
      inline_keyboard: [
        [{ text: "Request access", callback_data: `request_access:${w.id}` }],
      ],
    });
    const update = callback();
    await Promise.all([
      ingress.accept(update),
      ingress.accept(update),
      ingress.accept(callback()),
    ]);
    const current = await store.read(w.id);
    expect(current.accessRequests).toHaveLength(1);
    expect(current.runs).toHaveLength(0);
    expect(current.messages).toHaveLength(0);
    expect(eligible(current, "404")).toBe(false);
    expect(
      calls.some((c) => String(c.params.text).includes("Access requested")),
    ).toBe(true);
    const response = await api(`${w.id}/access-requests`);
    const page = await response.json();
    expect(page.items[0].actor).toBe("404");
    expect(page.items[0].name).toBe("New user");
    expect(page.requestUrl).toContain(`start=access_${w.id}`);
    const path = `${w.id}/access-requests/${page.items[0].id}/decision`;
    const outcomes = await Promise.all([
      api(path, "POST", { decision: "approved", version: page.version }),
      api(path, "POST", { decision: "approved", version: page.version }),
    ]);
    expect(outcomes.map((r) => r.status)).toEqual([200, 200]);
    const approved = await store.read(w.id);
    expect(eligible(approved, "404")).toBe(true);
    expect(approved.members.find((m) => m.id === "404")).toMatchObject({
      id: "404",
      role: "member",
      active: true,
      username: "new_user",
      name: "New user",
    });
    expect(approved.deliveries).toHaveLength(1);
    await new DeliveryWorker(store, setup).send(
      w.id,
      required(approved.deliveries[0]).id,
    );
    expect(
      calls.some((c) =>
        String(c.params.text).includes("Access approved for Telegram user 404"),
      ),
    ).toBe(true);
    await ingress.accept(message(404, "/ask hello"));
    expect((await store.read(w.id)).runs).toHaveLength(1);
    await store.change(w.id, (v) => {
      v.policy.allowed = v.policy.allowed.filter((a) => a !== "404");
      v.policy.version++;
    });
    expect(
      (await api(path, "POST", { decision: "approved", version: page.version }))
        .status,
    ).toBe(200);
    expect(eligible(await store.read(w.id), "404")).toBe(false);
  });
  test("admin, CSRF, tenant, stale-version and rejection boundaries", async () => {
    await ingress.accept(callback());
    const current = await store.read(w.id);
    const entry = required(current.accessRequests?.[0]);
    const path = `${w.id}/access-requests/${entry.id}/decision`;
    const input = { decision: "approved", version: w.policy.version };
    expect((await api(path, "POST", input, { cookie: "" })).status).toBe(401);
    expect(
      (await api(path, "POST", input, { "x-csrf-token": "wrong" })).status,
    ).toBe(403);
    expect((await api(path, "POST", { ...input, version: 999 })).status).toBe(
      409,
    );
    const other = workspace();
    other.operatorId = adminId;
    other.members = [{ id: "303", active: true, role: "owner" }];
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [other.id, adminId, JSON.stringify(other)],
    );
    expect((await api(`${other.id}/access-requests`)).status).toBe(403);
    expect(
      (
        await api(
          `${other.id}/access-requests/${entry.id}/decision`,
          "POST",
          input,
        )
      ).status,
    ).toBe(403);
    await store.pool.query("UPDATE admins SET telegram_id='202' WHERE id=$1", [
      adminId,
    ]);
    expect((await api(path, "POST", input)).status).toBe(403);
    await store.pool.query("UPDATE admins SET telegram_id='101' WHERE id=$1", [
      adminId,
    ]);
    expect(
      (await api(path, "POST", { ...input, decision: "rejected" })).status,
    ).toBe(200);
    expect((await api(path, "POST", input)).status).toBe(409);
    await ingress.accept(callback());
    const rejected = await store.read(w.id);
    expect(rejected.accessRequests).toHaveLength(1);
    expect(rejected.accessRequests?.[0]?.status).toBe("rejected");
    expect(eligible(rejected, "404")).toBe(false);
    expect(calls.at(-1)?.params.text).toContain("rejected");
    await store.change(w.id, (v) => {
      required(v.accessRequests?.[0]).decidedAt = new Date(
        Date.now() - 2 * 86400000,
      ).toISOString();
    });
    await ingress.accept(callback());
    expect((await store.read(w.id)).accessRequests?.[0]?.id).not.toBe(entry.id);
    expect((await api(path, "POST", input)).status).toBe(404);
  });
  test("multiple workspaces need a scoped link; group callback cannot target another tenant", async () => {
    const other = workspace();
    other.operatorId = adminId;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [other.id, adminId, JSON.stringify(other)],
    );
    await ingress.accept(message());
    await deliverAccessHelp(store, setup);
    expect(
      calls.find((c) => c.method === "sendMessage")?.params.reply_markup,
    ).toBeUndefined();
    await ingress.accept(message(404, `/start access_${w.id}`));
    await ingress.accept(callback());
    expect((await store.read(w.id)).accessRequests).toHaveLength(1);
    expect((await store.read(other.id)).accessRequests).toBeUndefined();
    await store.pool.query(
      "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES($1,$2)",
      ["-100100", w.id],
    );
    await ingress.accept(message(505, "/ask hello", -100100));
    await deliverAccessHelp(store, setup);
    expect(
      calls.some(
        (c) => c.method === "sendMessage" && c.params.chat_id === "-100100",
      ),
    ).toBe(true);
    await ingress.accept(callback(505, other.id, -100100));
    expect((await store.read(other.id)).accessRequests).toBeUndefined();
    await ingress.accept(callback(505, w.id, -100100));
    expect(
      (await store.read(w.id)).accessRequests?.find((r) => r.actor === "505")
        ?.chatId,
    ).toBe("-100100");
  });
  test("bot/anonymous/forged private callbacks, deleted workspace and retention", async () => {
    const bot = callback();
    required(bot.callback_query).from.is_bot = true;
    await ingress.accept(bot);
    const forged = callback();
    required(required(forged.callback_query).message).chat.id = 555;
    await ingress.accept(forged);
    const anonymous = message();
    required(anonymous.message).sender_chat = {
      id: -100100,
      type: "supergroup",
    };
    await ingress.accept(anonymous);
    expect((await store.read(w.id)).accessRequests).toBeUndefined();
    expect(
      (await store.pool.query("SELECT * FROM control_deliveries")).rowCount,
    ).toBe(0);
    await ingress.accept(callback());
    await store.change(w.id, (v) =>
      sweep(v, new Date(Date.now() + 31 * 86400000)),
    );
    expect((await store.read(w.id)).accessRequests).toHaveLength(0);
    await store.change(w.id, (v) => {
      v.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "none",
      };
    });
    await ingress.accept(callback());
    await deliverAccessHelp(store, setup);
    expect((await store.read(w.id)).accessRequests).toHaveLength(0);
    expect(calls.some((c) => c.method === "sendMessage")).toBe(false);
  });
});
