import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate, migrateJobs } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import {
  type Admin,
  type Deployment,
  settingsSchema,
} from "../../src/domain.ts";
import { startWorker } from "../../src/jobs/queue.ts";
import { SetupService } from "../../src/setup/service.ts";
import { TelegramPoller } from "../../src/telegram/polling.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)("automatic bot activation", () => {
  const root = database(rootUrl ?? "postgres://unused@localhost/unused");
  const name = `activation_${randomUUID().replaceAll("-", "")}`;
  const origin = "https://example.test";
  let store: Store, setup: SetupService, admin: Admin, initial: Deployment;
  let url: string,
    workspaceId: string,
    providerId: string,
    webhook = "";
  let auth: { raw: string; csrf: string };
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(rootUrl ?? "");
    parsed.pathname = `/${name}`;
    url = parsed.toString();
    store = new Store(database(url));
    await migrate(store.pool);
    await migrateJobs(url);
    auth = await claim(
      store.pool,
      "activationadmin",
      "activation test password",
    );
    admin = {
      id: (await store.pool.query("SELECT id FROM admins")).rows[0].id,
      username: "activationadmin",
      operator: true,
    };
    initial = await store.deployment();
  });
  beforeEach(async () => {
    await store.pool.query(
      "TRUNCATE workspaces, operator_audit, telegram_polling CASCADE",
    );
    await store.saveDeployment(store.pool, structuredClone(initial));
    webhook = "";
    setup = new SetupService(
      store,
      "ab".repeat(32),
      origin,
      () => ({
        async call<T>(method: string, params = {}) {
          if (method === "setWebhook")
            webhook = (params as { url: string }).url;
          return (
            method === "getMe"
              ? { id: 999, is_bot: true, username: "fixture_bot" }
              : method === "getUpdates"
                ? []
                : { url: webhook }
          ) as T;
        },
      }),
      "webhook",
      async () => Response.json({ data: [{ id: "gpt-4.1-mini" }] }),
    );
    workspaceId = (
      await setup.createWorkspace(
        admin,
        settingsSchema.parse({
          name: "Activation team",
          timezone: "Asia/Taipei",
        }),
      )
    ).id;
    const providers = await setup.models.save(admin, {
      version: (await store.deployment()).version,
      name: "Fixture provider",
      baseUrl: "https://models.example.test/v1",
      apiKey: "fixture-provider-key",
    });
    providerId = providers.providers[0]?.id ?? "";
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  const selection = () => ({ providerId, model: "gpt-4.1-mini" });
  async function bot() {
    await setup.saveCredentials(admin, {
      version: (await store.deployment()).version,
      botToken: "999:fixture-token-never-sent-to-telegram",
    });
  }
  const requestModel = (body: unknown, headers = {}) =>
    createApp(store, setup, origin).request(
      `/api/admin/workspaces/${workspaceId}/models`,
      {
        method: "PUT",
        headers: {
          cookie: `repodesk_session=${auth.raw}`,
          origin,
          "x-csrf-token": auth.csrf,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      },
    );
  test("successful model setup activates without a member and retries audit only once", async () => {
    await bot();
    await setup.register(admin);
    const d = await store.deployment();
    d.paused = true;
    await store.saveDeployment(store.pool, d);
    const response = await requestModel({
      revision: 0,
      selection: selection(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: 1,
      version: (await store.deployment()).version,
      configured: true,
    });
    expect(await store.deployment()).toMatchObject({
      active: true,
      paused: true,
    });
    expect((await store.read(workspaceId)).members).toEqual([]);
    await Promise.all([
      setup.autoActivate(),
      setup.autoActivate(admin.id),
      setup.activate(admin),
    ]);
    expect(
      (
        await store.pool.query(
          "SELECT actor FROM operator_audit WHERE action='deployment.activated'",
        )
      ).rows,
    ).toEqual([{ actor: admin.id }]);
  });
  test("invalid, stale, cross-origin and unauthorized model saves leave the bot inactive", async () => {
    await bot();
    await setup.register(admin);
    for (const [body, headers, status] of [
      [
        { revision: 0, selection: { ...selection(), model: "missing-model" } },
        {},
        409,
      ],
      [{ revision: 2, selection: selection() }, {}, 409],
      [{ revision: 0, selection: selection() }, { cookie: "" }, 401],
      [
        { revision: 0, selection: selection() },
        { origin: "https://other.test" },
        403,
      ],
    ] as const) {
      expect((await requestModel(body, headers)).status).toBe(status);
      expect((await store.deployment()).active).toBe(false);
      expect((await store.read(workspaceId)).chatModel).toBeUndefined();
    }
    expect(await setup.autoActivate()).toBe(false);
  });
  test("a model saved before Telegram activates when webhook registration succeeds", async () => {
    await setup.saveChatModel(admin, workspaceId, {
      revision: 0,
      selection: selection(),
    });
    expect((await store.deployment()).active).toBe(false);
    await bot();
    expect((await store.deployment()).active).toBe(false);
    await setup.register(admin);
    expect((await store.deployment()).active).toBe(true);
  });
  test("the polling loop activates when the receiver becomes ready", async () => {
    await bot();
    await setup.saveChatModel(admin, workspaceId, {
      revision: 0,
      selection: selection(),
    });
    expect((await store.deployment()).active).toBe(false);
    const polling = new SetupService(
      store,
      "ab".repeat(32),
      origin,
      () => ({
        async call<T>(method: string) {
          return (method === "getUpdates" ? [] : { url: "" }) as T;
        },
      }),
      "polling",
    );
    const shutdown = new AbortController();
    const loop = new TelegramPoller(store, polling).run(shutdown.signal);
    try {
      for (
        let attempt = 0;
        attempt < 100 && !(await store.deployment()).active;
        attempt++
      )
        await Bun.sleep(10);
      expect((await store.deployment()).active).toBe(true);
      expect((await polling.progress(admin)).receiver.ready).toBe(true);
    } finally {
      shutdown.abort();
      await loop;
    }
  });
  test("worker recovery activates a ready setup after the last missing skill is enabled", async () => {
    await bot();
    await setup.register(admin);
    await store.change(workspaceId, (w) => {
      for (const skill of w.skills) skill.enabled = false;
    });
    await setup.saveChatModel(admin, workspaceId, {
      revision: 0,
      selection: selection(),
    });
    expect((await store.deployment()).active).toBe(false);
    await store.change(workspaceId, (w) => {
      for (const skill of w.skills) skill.enabled = true;
    });
    const stop = await startWorker(store, setup, url);
    try {
      expect((await store.deployment()).active).toBe(true);
    } finally {
      await stop();
    }
  });
  test("deleted workspaces and models from another operator cannot satisfy automatic readiness", async () => {
    await bot();
    await setup.register(admin);
    await setup.models.saveChat(admin, workspaceId, {
      revision: 0,
      selection: selection(),
    });
    await store.change(workspaceId, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "pending",
      };
    });
    expect(await setup.autoActivate()).toBe(false);
    await store.change(workspaceId, (w) => {
      delete w.deletion;
    });
    const d = await store.deployment();
    if (d.modelProviders?.[0]) d.modelProviders[0].operatorId = randomUUID();
    await store.saveDeployment(store.pool, d);
    expect(await setup.autoActivate()).toBe(false);
    expect((await store.deployment()).active).toBe(false);
  });
  test("legacy model credentials also activate automatically when saved", async () => {
    await bot();
    await setup.register(admin);
    const result = await setup.saveCredentials(admin, {
      version: (await store.deployment()).version,
      model: "gpt-4.1-mini",
      modelKey: "fixture-legacy-model-key",
    });
    expect(result.active).toBe(true);
  });
  test("a failed activation write stays inactive and recovers the saved model on retry", async () => {
    await bot();
    await setup.register(admin);
    await store.pool.query(
      "CREATE FUNCTION fail_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (NEW.data->>'active')::boolean THEN RAISE EXCEPTION 'fixture activation failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_activation BEFORE UPDATE ON deployment FOR EACH ROW EXECUTE FUNCTION fail_activation()",
    );
    try {
      expect(
        (await requestModel({ revision: 0, selection: selection() })).status,
      ).toBe(503);
      expect((await store.deployment()).active).toBe(false);
      expect((await store.read(workspaceId)).chatModel?.selection).toEqual(
        selection(),
      );
      expect(
        (
          await store.pool.query(
            "SELECT * FROM operator_audit WHERE action='deployment.activated'",
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await store.pool.query(
        "DROP TRIGGER fail_activation ON deployment; DROP FUNCTION fail_activation()",
      );
    }
    expect(await setup.autoActivate()).toBe(true);
    expect((await store.deployment()).active).toBe(true);
  });
});
