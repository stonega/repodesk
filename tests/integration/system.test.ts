import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { claim, issueClaim, login, session } from "../../src/admin/auth.ts";
import { extensionToolExecution } from "../../src/agent/extension-execution.ts";
import { type AgentRunner, PiRunner } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import { migrate, migrateJobs } from "../../src/db/migrate.ts";
import { database, transaction } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { Fault } from "../../src/domain.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { dispatch, queue } from "../../src/jobs/queue.ts";
import { requestDeletion, sweep } from "../../src/privacy/service.ts";
import { encrypt, hash, passwordHash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { type Telegram, TelegramError } from "../../src/telegram/client.ts";
import { updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import {
  decide,
  proposeInstruction,
  proposeWorkflow,
  tick,
  workflowAction,
} from "../../src/workflows/service.ts";
import { setPolicy } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { spec, workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("PostgreSQL integration (isolated database)", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const dbName = `deepx_test_${randomUUID().replaceAll("-", "")}`;
  let store: Store;
  let setup: SetupService;
  let app: ReturnType<typeof createApp>;
  let testUrl: string;
  let cookie = "";
  let csrf = "";
  let operatorId = "";
  const key = "ab".repeat(32);
  const origin = "http://localhost:3000";
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let telegramFailure: TelegramError | undefined;
  let membershipStatus = "administrator";
  let chatLookupFailure = false;
  const telegram: Telegram = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "getChat") {
        if (chatLookupFailure)
          throw new TelegramError("telegram_destination_rejected", "permanent");
        return { title: "DeepX team" } as T;
      }
      if (
        telegramFailure &&
        ["sendMessage", "sendRichMessage", "sendRichMessageDraft"].includes(
          method,
        )
      )
        throw telegramFailure;
      const result =
        method === "getChatMember"
          ? { status: membershipStatus }
          : method === "getMe"
            ? {
                id: 999,
                is_bot: true,
                username: "deepx_test_bot",
                can_read_all_group_messages: true,
              }
            : { message_id: 123 };
      return result as T;
    },
  };
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${dbName}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${dbName}`;
    testUrl = parsed.toString();
    const pool = database(testUrl);
    store = new Store(pool);
    await migrate(pool);
    await migrateJobs(testUrl);
    setup = new SetupService(store, key, origin, () => telegram);
    app = createApp(store, setup, origin);
  }, 30000);
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  async function seed() {
    const w = workspace();
    w.operatorId = operatorId;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, w.operatorId, JSON.stringify(w)],
    );
    return w;
  }
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
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
  test("one-use bootstrap is atomic under two concurrent claims", async () => {
    const token = await issueClaim(store.pool);
    const attempts = await Promise.allSettled([
      claim(store.pool, token, "operator", "a long test password"),
      claim(store.pool, token, "intruder", "a long test password"),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const fulfilled = attempts.find((r) => r.status === "fulfilled");
    if (fulfilled?.status !== "fulfilled") throw Error();
    cookie = `deepx_session=${fulfilled.value.raw}`;
    csrf = fulfilled.value.csrf;
    const account = await session(store.pool, fulfilled.value.raw);
    operatorId = account?.admin.id ?? "";
    expect(operatorId).toBeTruthy();
    expect((await store.pool.query("SELECT * FROM admins")).rowCount).toBe(1);
    await expect(issueClaim(store.pool)).rejects.toThrow("already_claimed");
    await store.pool.query("UPDATE admins SET telegram_id='101' WHERE id=$1", [
      operatorId,
    ]);
    await transaction(store.pool, async (sql) => {
      const d = await store.deployment(sql, true);
      d.active = true;
      d.bot = { id: "999", username: "deepx_test_bot", visibleAll: true };
      d.credentials = {
        bot: encrypt(key, "bot", "999:fake-bot-token-for-tests"),
        model: encrypt(key, "model", "fake-provider-key"),
        webhook: encrypt(key, "webhook", "test-webhook-secret"),
      };
      await store.saveDeployment(sql, d);
    });
  });
  test("migration is repeatable and state survives a second connection", async () => {
    await migrate(store.pool);
    const second = new Store(database(testUrl));
    expect((await second.deployment()).active).toBe(true);
    await second.pool.end();
  });
  test("authentication, CSRF, cross-tenant and secret redaction", async () => {
    const w = await seed();
    expect(
      (await app.request(`/api/admin/workspaces/${w.id}/settings`)).status,
    ).toBe(401);
    expect(
      (
        await request(
          `/api/admin/workspaces/${w.id}/settings`,
          "PUT",
          { version: 1, settings: w.settings },
          { origin: "https://evil.invalid" },
        )
      ).status,
    ).toBe(403);
    const other = await seed();
    await store.change(other.id, (v) => {
      v.policy.allowed = ["303"];
    });
    expect(
      (await request(`/api/admin/workspaces/${other.id}/settings`)).status,
    ).toBe(403);
    const progress = await request("/api/setup/progress");
    expect(progress.status).toBe(200);
    const text = await progress.text();
    expect(text).not.toContain("fake-provider-key");
    expect(text).not.toContain("v1.");
    expect(
      (await request("/api/admin/not-a-resource")).headers.get("content-type"),
    ).toContain("json");
  });
  test("operator saves compatible settings, protects keys and worker uses the saved model", async () => {
    const original = await store.deployment();
    const path = "/api/admin/operator/credentials";
    const input = {
      version: original.version,
      model: "team/custom",
      modelBaseUrl: "https://models.example.test/v1/",
      modelKey: "local",
      thinkingLevel: "xhigh",
      modelPricing: { input: 1, output: 2 },
      modelLimits: { contextWindow: 128000, maxOutputTokens: 16000 },
    };
    try {
      for (const patch of [
        { modelBaseUrl: "not-url" },
        { thinkingLevel: "extreme" },
        { model: "" },
        { modelBaseUrl: "https://secret@host/v1" },
      ]) {
        expect(
          (await request(path, "PUT", { ...input, ...patch })).status,
        ).toBe(400);
      }
      expect(
        (await request(path, "PUT", { ...input, modelKey: undefined })).status,
      ).toBe(400);
      const response = await request(path, "PUT", input);
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved).toMatchObject({
        model: input.model,
        modelBaseUrl: "https://models.example.test/v1",
        thinkingLevel: "xhigh",
        credentials: { model: true },
      });
      expect(saved.modelKey).toBeUndefined();
      expect((await store.deployment()).credentials.model).not.toBe("local");
      expect(await setup.modelKey(saved.modelBaseUrl)).toBe("local");
      await expect(setup.modelKey("https://wrong.example/v1")).rejects.toThrow(
        "model_endpoint_changed",
      );
      expect((await request(path, "PUT", input)).status).toBe(409);
      expect(
        (
          await request(path, "PUT", {
            version: saved.version,
            thinkingLevel: "high",
          })
        ).status,
      ).toBe(200);
      expect(await setup.modelKey()).toBe("local");
      await expect(
        setup.saveCredentials(
          { id: operatorId, username: "member", operator: false },
          { version: saved.version },
        ),
      ).rejects.toThrow("operator_required");
      const w = await seed();
      const r = await store.change(w.id, (v) =>
        createRun(v, "101", "Hello", "101", 0, input.model),
      );
      let dispatched = false;
      const runner: AgentRunner = {
        async run(options) {
          dispatched = true;
          expect(options.model.id).toBe(input.model);
          expect(options.model.baseUrl).toBe(saved.modelBaseUrl);
          expect(options.model.api).toBe("openai-completions");
          expect(options.apiKey).toBe("local");
          expect(options.thinkingLevel).toBe("high");
          expect(options.model.cost.input).toBe(1);
          expect(options.maxInputChars).toBeUndefined();
          expect(options.maxOutputTokens).toBeUndefined();
          expect(await options.remainingBudget?.()).toEqual({
            run: 0.1,
            workspace: 10,
          });
          expect(options.model.contextWindow).toBe(128000);
          expect(options.model.maxTokens).toBe(16000);
          await options.guard();
          return {
            text: "Done",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };
      await new Executor(store, setup, runner).execute(w.id, r.id);
      expect(dispatched).toBe(true);
      expect(
        (await store.read(w.id)).runs.find((run) => run.id === r.id)
          ?.modelOptions,
      ).toMatchObject({
        modelBaseUrl: saved.modelBaseUrl,
        thinkingLevel: "high",
        modelLimits: input.modelLimits,
      });
      const audit = await store.pool.query(
        "SELECT action,target FROM operator_audit WHERE action='credentials.updated'",
      );
      expect(JSON.stringify(audit.rows)).not.toContain("local");
      const current = await store.deployment();
      const reset = await request(path, "PUT", {
        version: current.version,
        modelLimits: null,
      });
      expect(reset.status).toBe(400);
      expect((await reset.json()).error).toBe("model_limits_required");
      const switched = await request(path, "PUT", {
        version: current.version,
        model: "gpt-4.1-mini",
      });
      expect(switched.status).toBe(200);
      expect((await switched.json()).modelCapabilities.source).toBe("catalog");
      expect((await store.deployment()).modelLimits).toBeUndefined();
    } finally {
      await transaction(store.pool, (sql) =>
        store.saveDeployment(sql, original),
      );
    }
  });
  test("settings expose capabilities and reject field errors without altering saved state", async () => {
    const w = await seed();
    const path = `/api/admin/workspaces/${w.id}/settings`;
    const current = await (await request(path)).json();
    expect(current.capabilities.source).toBe("catalog");
    const invalid = await request(path, "PUT", {
      version: w.version,
      settings: {
        ...w.settings,
        maxTurns: 21,
      },
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).issues[0].path).toBe("settings.maxTurns");
    expect((await store.read(w.id)).version).toBe(w.version);
    const negative = await request(path, "PUT", {
      version: w.version,
      settings: { ...w.settings, runBudgetUsd: -1 },
    });
    expect((await negative.json()).issues[0].path).toBe(
      "settings.runBudgetUsd",
    );
    const saved = await request(path, "PUT", {
      version: w.version,
      settings: {
        ...w.settings,
        runBudgetUsd: 200,
        monthlyBudgetUsd: 2000,
        maxInputChars: 0,
        maxOutputTokens: 8000,
        maxTurns: 10,
      },
    });
    expect(saved.status).toBe(200);
    expect((await store.read(w.id)).settings).not.toHaveProperty(
      "maxOutputTokens",
    );
    expect((await store.read(w.id)).settings).not.toHaveProperty(
      "maxInputChars",
    );
    // A foreign/non-member actor cannot read limits or write settings.
    await store.change(w.id, (v) => {
      v.policy.allowed = ["303"];
    });
    expect((await request(path)).status).toBe(403);
    expect(
      (
        await request(path, "PUT", {
          version: w.version + 1,
          settings: w.settings,
        })
      ).status,
    ).toBe(403);
  });
  test("migration removes retired controls without changing historical snapshots", async () => {
    const w = await seed();
    const legacy = {
      ...w.settings,
      language: "en",
      maxInputChars: 16000,
      maxOutputTokens: 1024,
    };
    const run = createRun(w, "101", "test", "101", 0, "gpt-4.1-mini");
    const snapshot = { ...run, settings: legacy };
    await store.pool.query("UPDATE workspaces SET data=$2 WHERE id=$1", [
      w.id,
      JSON.stringify({ ...w, settings: legacy, runs: [snapshot] }),
    ]);
    const migration = await readFile(
      "migrations/010_automatic_response_settings.sql",
      "utf8",
    );
    await store.pool.query(migration);
    const saved = await store.read(w.id);
    expect(saved.settings).not.toHaveProperty("language");
    expect(saved.settings).not.toHaveProperty("maxInputChars");
    expect(saved.settings).not.toHaveProperty("maxOutputTokens");
    expect(saved.settings.runBudgetUsd).toBe(w.settings.runBudgetUsd);
    expect(saved.version).toBe(w.version + 1);
    expect(saved.runs[0]?.settings).toEqual(legacy);
    await store.pool.query(migration);
    expect((await store.read(w.id)).version).toBe(saved.version);
  });
  test("concurrent versioned settings writes cannot overwrite each other", async () => {
    const w = await seed();
    const results = await Promise.all([
      request(`/api/admin/workspaces/${w.id}/settings`, "PUT", {
        version: 1,
        settings: { ...w.settings, name: "First" },
      }),
      request(`/api/admin/workspaces/${w.id}/settings`, "PUT", {
        version: 1,
        settings: { ...w.settings, name: "Second" },
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await store.read(w.id)).version).toBe(2);
  });
  test("duplicate webhook accepts one logical run and rejects forgery", async () => {
    const w = await seed();
    await store.pool.query(
      "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES('-100100',$1)",
      [w.id],
    );
    const update = {
      update_id: 100,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100100, type: "supergroup" },
        from: { id: 101, is_bot: false },
        text: "/ask summarize",
        entities: [{ type: "bot_command", offset: 0, length: 4 }],
      },
    };
    expect((await request("/telegram/webhook", "POST", update)).status).toBe(
      401,
    );
    const results = await Promise.all([
      request("/telegram/webhook", "POST", update, {
        "x-telegram-bot-api-secret-token": "test-webhook-secret",
      }),
      request("/telegram/webhook", "POST", update, {
        "x-telegram-bot-api-secret-token": "test-webhook-secret",
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await store.read(w.id)).runs).toHaveLength(1);
    expect(
      (
        await store.pool.query(
          "SELECT * FROM outbox WHERE workspace_id=$1 AND kind='run'",
          [w.id],
        )
      ).rowCount,
    ).toBe(1);
    await store.pool.query("DELETE FROM chat_bindings WHERE workspace_id=$1", [
      w.id,
    ]);
  });
  test("group mentions preserve access, deduplication, topic and retention boundaries", async () => {
    const w = await seed();
    const chatId = -100301;
    await store.change(w.id, (current) => {
      current.chats = [
        {
          id: String(chatId),
          active: true,
          collection: false,
          visibleAll: true,
          linkedAt: new Date().toISOString(),
        },
      ];
    });
    const ingress = new Ingress(store, setup);
    const update = {
      update_id: 201,
      message: {
        message_id: 20,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "supergroup" as const },
        message_thread_id: 42,
        from: { id: 101, is_bot: false },
        text: "@deepx_test_bot hi",
        entities: [{ type: "mention", offset: 0, length: 15 }],
      },
    };
    // A mention cannot select an unlinked group or grant the sender access.
    await ingress.accept(update);
    expect((await store.read(w.id)).runs).toHaveLength(0);
    await store.pool.query(
      "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES($1,$2)",
      [String(chatId), w.id],
    );
    await ingress.accept({
      ...update,
      update_id: 202,
      message: { ...update.message, from: { id: 9999, is_bot: false } },
    });
    expect((await store.read(w.id)).runs).toHaveLength(0);
    await Promise.all([
      ingress.accept({ ...update, update_id: 203 }),
      ingress.accept({ ...update, update_id: 203 }),
    ]);
    await ingress.accept({
      ...update,
      update_id: 204,
      message: {
        ...update.message,
        message_id: 21,
        text: "hi team",
        entities: [],
      },
    });
    const current = await store.read(w.id);
    expect(current.runs).toHaveLength(1);
    expect(current.runs[0]).toMatchObject({
      task: "hi",
      chatId: String(chatId),
      topicId: 42,
    });
    expect(current.messages).toHaveLength(1);
    expect(current.messages[0]?.directed).toBe(true);
    expect(current.deliveries).toHaveLength(0);
    await store.pool.query("DELETE FROM chat_bindings WHERE workspace_id=$1", [
      w.id,
    ]);
  });
  test("unlinked groups and unauthorized members produce no runs", async () => {
    const ingress = new Ingress(store, setup);
    await ingress.accept({
      update_id: 200,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -12345, type: "supergroup" },
        from: { id: 9999, is_bot: false },
        text: "/ask secret",
        entities: [{ type: "bot_command", offset: 0, length: 4 }],
      },
    });
    expect(
      (
        await store.pool.query(
          "SELECT workspace_id FROM inbox WHERE update_id=200",
        )
      ).rows[0].workspace_id,
    ).toBeNull();
  });
  test("transaction rollback removes both accepted input and enqueue intent", async () => {
    const w = await seed();
    await expect(
      transaction(store.pool, async (sql) => {
        await sql.query(
          "INSERT INTO inbox(bot_id,update_id,workspace_id) VALUES('999',300,$1)",
          [w.id],
        );
        const copy = await store.read(w.id, sql, true);
        createRun(copy, "101", "hello", "-100100", 0, "gpt-4.1-mini");
        await store.save(sql, copy);
        throw Error("crash before commit");
      }),
    ).rejects.toThrow();
    expect(
      (await store.pool.query("SELECT * FROM inbox WHERE update_id=300"))
        .rowCount,
    ).toBe(0);
    expect((await store.read(w.id)).runs).toHaveLength(0);
    expect(
      (
        await store.pool.query("SELECT * FROM outbox WHERE workspace_id=$1", [
          w.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  test("extension tool outcomes deduplicate, refuse unknown replay, and enforce tenant, actor and fence", async () => {
    const w = await seed();
    const other = await seed();
    const run = await store.change(w.id, (v) => {
      const r = createRun(
        v,
        "101",
        "plugin test",
        "-100100",
        0,
        "gpt-4.1-mini",
      );
      r.status = "running";
      r.fence = 1;
      return r;
    });
    const signal = new AbortController().signal;
    const execute = extensionToolExecution(store, w.id, run.id, 1, signal);
    let calls = 0;
    const action = async () => {
      calls++;
      return {
        content: [{ type: "text" as const, text: "result" }],
        details: {},
      };
    };
    await execute("plugin_tool", "one", action);
    expect(await execute("plugin_tool", "one", action)).toEqual({
      content: [{ type: "text", text: "result" }],
      details: {},
    });
    expect(calls).toBe(1);
    await expect(execute("other_tool", "one", action)).rejects.toThrow(
      "extension_tool_outcome_unknown",
    );
    await expect(
      execute("plugin_tool", "unknown", async () => {
        throw Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(execute("plugin_tool", "unknown", action)).rejects.toThrow(
      "extension_tool_outcome_unknown",
    );
    await expect(
      extensionToolExecution(
        store,
        other.id,
        run.id,
        1,
        signal,
      )("plugin_tool", "new", action),
    ).rejects.toThrow("tool_policy_denied");
    await expect(
      extensionToolExecution(
        store,
        w.id,
        run.id,
        2,
        signal,
      )("plugin_tool", "new", action),
    ).rejects.toThrow("tool_policy_denied");
    await store.change(w.id, (v) => {
      v.policy.allowed = [];
    });
    await expect(execute("plugin_tool", "one", action)).rejects.toThrow(
      "tool_policy_denied",
    );
    expect(calls).toBe(1);
  });
  test("resumed runs refuse a changed plugin configuration before model dispatch", async () => {
    const w = await seed();
    const run = await store.change(w.id, (v) => {
      const r = createRun(
        v,
        "101",
        "plugin version test",
        "-100100",
        0,
        "gpt-4.1-mini",
      );
      r.extensionVersion = "old-plugin-version";
      return r;
    });
    let calls = 0;
    const runner: AgentRunner = {
      extensionVersion: "new-plugin-version",
      run: async () => {
        calls++;
        throw Error("must not dispatch");
      },
    };
    await new Executor(store, setup, runner).execute(w.id, run.id);
    const saved = (await store.read(w.id)).runs.find((r) => r.id === run.id);
    expect(saved?.error).toBe("extension_configuration_changed");
    expect(saved?.status).toBe("failed");
    expect(calls).toBe(0);
  });
  test("outbox enqueue and acknowledgement use pg-boss transaction adapter", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) =>
      createRun(v, "101", "hello", "-100100", 0, "gpt-4.1-mini"),
    );
    const boss = queue(testUrl);
    await boss.start();
    await Promise.all([dispatch(store, boss, 600), dispatch(store, boss, 600)]);
    const jobs = await boss.findJobs("run", {});
    expect(
      jobs.filter((j) => (j.data as { targetId: string }).targetId === r.id),
    ).toHaveLength(1);
    expect(
      jobs.find((j) => (j.data as { targetId: string }).targetId === r.id)
        ?.expireInSeconds,
    ).toBe(660);
    await boss.stop();
  });
  test("queue migration updates existing run expiry without changing delivery expiry", async () => {
    await migrateJobs(testUrl, 600);
    const boss = queue(testUrl);
    await boss.start();
    try {
      expect((await boss.getQueue("run"))?.expireInSeconds).toBe(660);
      expect((await boss.getQueue("delivery"))?.expireInSeconds).toBe(180);
    } finally {
      await boss.stop();
      await migrateJobs(testUrl);
    }
  });
  test("deadlines, shutdown and user cancellation retain distinct outcomes and unknown charges", async () => {
    for (const cause of ["timeout", "shutdown", "user"] as const) {
      const w = await seed();
      const r = await store.change(w.id, (v) =>
        createRun(v, "101", "slow request", "101", 0, "gpt-4.1-mini"),
      );
      const deadline = new AbortController();
      const shutdown = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
        deadline.signal,
      );
      const log = spyOn(store.log, "write");
      const runner: AgentRunner = {
        async run(input) {
          await input.reserve(0.001);
          if (cause === "user") {
            await store.change(w.id, (v) => {
              const run = v.runs.find((run) => run.id === r.id);
              if (run) run.cancelled = true;
            });
          } else if (cause === "timeout") {
            deadline.abort(new DOMException("deadline", "TimeoutError"));
            shutdown.abort();
          } else {
            shutdown.abort();
            deadline.abort(new DOMException("deadline", "TimeoutError"));
          }
          // Pi reports an abort generically; the executor must recover its source.
          throw new Fault("cancelled", 409);
        },
      };
      try {
        await new Executor(store, setup, runner).execute(
          w.id,
          r.id,
          shutdown.signal,
        );
        expect(timeout).toHaveBeenCalledWith(300000);
        const saved = await store.read(w.id);
        const run = saved.runs.find((run) => run.id === r.id);
        const code =
          cause === "timeout"
            ? "run_timeout"
            : cause === "shutdown"
              ? "worker_shutdown"
              : "cancelled";
        expect(run?.status).toBe(cause === "timeout" ? "failed" : "cancelled");
        expect(run?.error).toBe(code);
        expect(run?.cancelled).toBe(cause === "user");
        expect(run?.attempts[0]?.status).toBe("unknown");
        expect(run?.attempts[0]?.reserved).toBe(0.001);
        expect(run?.attempts[0]?.actual).toBeUndefined();
        expect(log).toHaveBeenCalledWith(
          "run_failed",
          expect.objectContaining({ error: expect.objectContaining({ code }) }),
        );
        if (cause === "user") expect(saved.deliveries).toHaveLength(0);
        else expect(saved.deliveries.at(-1)?.text).toContain(`(${code})`);
        if (cause === "timeout")
          expect(saved.deliveries.at(-1)?.text).toContain(
            "300-second time limit",
          );
        // A repeated queue event must not replay an uncertain provider call.
        let replayed = false;
        await new Executor(store, setup, {
          async run() {
            replayed = true;
            throw Error();
          },
        }).execute(w.id, r.id);
        expect(replayed).toBe(false);
      } finally {
        timeout.mockRestore();
        log.mockRestore();
      }
    }
  });
  test("timeout before dispatch records no unknown charge and uses the configured deadline", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) =>
      createRun(v, "101", "test", "101", 0, "gpt-4.1-mini"),
    );
    const deadline = new AbortController();
    deadline.abort(new DOMException("deadline", "TimeoutError"));
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
      deadline.signal,
    );
    let called = false;
    try {
      await new Executor(
        store,
        setup,
        {
          async run() {
            called = true;
            throw Error();
          },
        },
        600000,
      ).execute(w.id, r.id);
      expect(timeout).toHaveBeenCalledWith(600000);
      expect(called).toBe(false);
      const saved = await store.read(w.id);
      expect(saved.runs[0]?.error).toBe("run_timeout");
      expect(saved.runs[0]?.attempts).toHaveLength(0);
      expect(saved.deliveries[0]?.text).toContain("600-second time limit");
      expect(saved.deliveries[0]?.text).not.toContain(
        "charges remain reserved",
      );
    } finally {
      timeout.mockRestore();
    }
  });
  test("two approvals and two scheduler ticks produce one occurrence", async () => {
    const w = await seed();
    const now = new Date("2026-09-18T08:59:00Z");
    const proposal = await store.change(w.id, (v) =>
      proposeWorkflow(v, "101", spec(v), now),
    );
    const approvals = await Promise.allSettled([
      store.change(w.id, (v) =>
        decide(v, "101", proposal.approval.id, true, now),
      ),
      store.change(w.id, (v) =>
        decide(v, "101", proposal.approval.id, true, now),
      ),
    ]);
    expect(approvals.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    await Promise.all([
      store.change(w.id, (v) =>
        tick(v, "gpt-4.1-mini", new Date("2026-09-18T09:00:00Z")),
      ),
      store.change(w.id, (v) =>
        tick(v, "gpt-4.1-mini", new Date("2026-09-18T09:00:00Z")),
      ),
    ]);
    expect((await store.read(w.id)).occurrences).toHaveLength(1);
  });
  test("Pi executor reserves and reconciles usage, delivering separately", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) =>
      createRun(v, "101", "hello", "-100100", 0, "gpt-4.1-mini"),
    );
    const fake = new PiRunner((model) => {
      const stream = new AssistantMessageEventStream();
      const m = {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "**Hello** from the fake provider" },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop" as const,
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 10,
          totalTokens: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: {
            input: 0.000004,
            output: 0.000016,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.00002,
          },
        },
      };
      stream.push({ type: "done", reason: "stop", message: m });
      stream.end(m);
      return stream;
    });
    await new Executor(store, setup, fake).execute(w.id, r.id);
    const saved = await store.read(w.id);
    expect(saved.runs[0]?.status).toBe("succeeded");
    expect(saved.runs[0]?.attempts[0]?.status).toBe("settled");
    expect(saved.deliveries[0]?.state).toBe("pending");
    expect(saved.deliveries[0]?.format).toBe("rich");
    await new DeliveryWorker(store, setup).send(
      w.id,
      saved.deliveries[0]?.id ?? "",
    );
    expect((await store.read(w.id)).deliveries[0]?.remoteId).toBe(123);
    const sent = calls.at(-1)?.params;
    expect(calls.at(-1)?.method).toBe("sendRichMessage");
    expect(JSON.stringify(sent?.rich_message)).toContain('"type":"bold"');
    expect(JSON.stringify(sent?.rich_message)).toContain(
      "from the fake provider",
    );
    expect(sent?.parse_mode).toBeUndefined();
  });
  test("private runs preview, finalize durably and deduplicate; group runs do not preview", async () => {
    for (const chatId of ["101", "-100100"]) {
      const w = await seed();
      const r = await store.change(w.id, (v) =>
        createRun(v, "101", "hello", chatId, 7, "gpt-4.1-mini"),
      );
      const before = calls.length;
      const runner: AgentRunner = {
        async run(input) {
          expect(!!input.preview).toBe(chatId === "101");
          await input.preview?.("**Hello**");
          expect((await store.read(w.id)).deliveries).toHaveLength(0);
          return {
            text: "**Hello** world",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };
      const executor = new Executor(store, setup, runner);
      await executor.execute(w.id, r.id);
      await executor.execute(w.id, r.id);
      const saved = await store.read(w.id);
      expect(saved.deliveries).toHaveLength(1);
      expect(saved.deliveries[0]?.format).toBe("rich");
      const worker = new DeliveryWorker(store, setup);
      await worker.send(w.id, saved.deliveries[0]?.id ?? "");
      await worker.send(w.id, saved.deliveries[0]?.id ?? "");
      expect(calls.slice(before).map((c) => c.method)).toEqual(
        chatId === "101"
          ? ["sendMessageDraft", "sendRichMessageDraft", "sendRichMessage"]
          : ["sendRichMessage"],
      );
      expect(calls.at(-1)?.params.message_thread_id).toBe(7);
    }
  });
  test("preview transport failures preserve final replies and revocation prevents previews", async () => {
    for (const mode of [
      "unsupported",
      "revoked",
      "paused",
      "fenced",
      "cancelled",
    ]) {
      const w = await seed();
      const r = await store.change(w.id, (v) =>
        createRun(v, "101", "hello", "101", 0, "gpt-4.1-mini"),
      );
      const before = calls.length;
      const runner: AgentRunner = {
        async run(input) {
          if (mode === "unsupported")
            telegramFailure = new TelegramError(
              "telegram_destination_rejected",
              "permanent",
            );
          else
            await store.change(w.id, (v) => {
              if (mode === "revoked") v.policy.allowed = [];
              if (mode === "paused") v.settings.paused = true;
              const run = v.runs.find((item) => item.id === r.id);
              if (run && mode === "fenced") run.fence++;
              if (run && mode === "cancelled") run.cancelled = true;
            });
          await input.preview?.("Hello");
          telegramFailure = undefined;
          return {
            text: "Hello",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };
      await new Executor(store, setup, runner).execute(w.id, r.id);
      const saved = await store.read(w.id);
      if (mode === "unsupported") {
        expect(saved.runs[0]?.status).toBe("succeeded");
        expect(saved.deliveries[0]?.format).toBe("rich");
        await new DeliveryWorker(store, setup).send(
          w.id,
          saved.deliveries[0]?.id ?? "",
        );
        expect(calls.slice(before).map((c) => c.method)).toEqual([
          "sendMessageDraft",
          "sendRichMessageDraft",
          "sendRichMessage",
        ]);
      } else {
        // The thinking placeholder precedes revocation; no generated text may follow it.
        expect(calls.slice(before).map((c) => c.method)).toEqual([
          "sendMessageDraft",
        ]);
      }
    }
  });
  test("rich final rejection falls back once; ambiguous rich sends are never replayed", async () => {
    for (const disposition of ["permanent", "unknown"] as const) {
      const w = await seed();
      const id = randomUUID();
      await store.change(w.id, (v) => {
        v.deliveries.push({
          id,
          actor: "101",
          chatId: "101",
          topicId: 7,
          text: "**Hello**",
          format: "rich",
          state: "pending",
          attempts: 0,
          at: new Date().toISOString(),
        });
      });
      telegramFailure = new TelegramError(
        "telegram_destination_rejected",
        disposition,
      );
      const before = calls.length;
      const worker = new DeliveryWorker(store, setup);
      await worker.send(w.id, id);
      telegramFailure = undefined;
      await worker.send(w.id, id);
      await worker.send(w.id, id);
      expect(calls.slice(before).map((c) => c.method)).toEqual(
        disposition === "permanent"
          ? ["sendRichMessage", "sendMessage"]
          : ["sendRichMessage"],
      );
      expect((await store.read(w.id)).deliveries[0]?.state).toBe(
        disposition === "permanent" ? "sent" : "delivery_unknown",
      );
    }
  });
  test("unknown Telegram outcome is never blindly resent", async () => {
    const w = await seed();
    w.deliveries.push({
      id: randomUUID(),
      actor: "101",
      chatId: "-100100",
      topicId: 7,
      text: "test",
      state: "pending",
      attempts: 0,
      at: new Date().toISOString(),
    });
    await store.change(w.id, (v) => {
      v.deliveries = w.deliveries;
    });
    telegramFailure = new TelegramError("timeout", "unknown");
    const worker = new DeliveryWorker(store, setup);
    const before = calls.length;
    await worker.send(w.id, w.deliveries[0]?.id ?? "");
    await worker.send(w.id, w.deliveries[0]?.id ?? "");
    telegramFailure = undefined;
    expect(calls.length - before).toBe(1);
    expect((await store.read(w.id)).deliveries[0]?.state).toBe(
      "delivery_unknown",
    );
  });
  test("429 retries at recorded time; permanent destinations stop", async () => {
    const w = await seed();
    const id = randomUUID();
    await store.change(w.id, (v) => {
      v.deliveries.push({
        id,
        actor: "101",
        chatId: "-100100",
        topicId: 0,
        text: "test",
        state: "pending",
        attempts: 0,
        at: new Date().toISOString(),
      });
    });
    telegramFailure = new TelegramError("rate_limit", "retry", 60);
    const worker = new DeliveryWorker(store, setup);
    await worker.send(w.id, id);
    expect((await store.read(w.id)).deliveries[0]?.state).toBe("pending");
    const before = calls.length;
    await worker.send(w.id, id);
    expect(calls.length).toBe(before);
    await store.change(w.id, (v) => {
      if (v.deliveries[0]) v.deliveries[0].nextAt = new Date(0).toISOString();
    });
    telegramFailure = new TelegramError("blocked", "permanent");
    await worker.send(w.id, id);
    telegramFailure = undefined;
    expect((await store.read(w.id)).deliveries[0]?.state).toBe("failed");
  });
  test("revoked session and queued run cannot call the model", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) =>
      createRun(v, "101", "hello", "-100100", 0, "gpt-4.1-mini"),
    );
    await store.change(w.id, (v) =>
      setPolicy(v, "303", v.policy.version, "whitelist", ["303"]),
    );
    expect((await request(`/api/admin/workspaces/${w.id}/runs`)).status).toBe(
      403,
    );
    let called = false;
    const runner: AgentRunner = {
      async run() {
        called = true;
        throw Error();
      },
    };
    await new Executor(store, setup, runner).execute(w.id, r.id);
    expect(called).toBe(false);
  });
  test("crashed provider attempt keeps reservation and requires recovery", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) => {
      const r = createRun(v, "101", "hello", "-100100", 0, "gpt-4.1-mini");
      r.status = "running";
      r.leaseUntil = new Date(0).toISOString();
      r.attempts.push({
        id: "crashed",
        reserved: 0.05,
        status: "reserved",
        at: new Date().toISOString(),
      });
      return r;
    });
    await new Executor(store, setup).execute(w.id, r.id);
    const saved = (await store.read(w.id)).runs[0];
    expect(saved?.error).toBe("provider_outcome_unknown");
    expect(saved?.attempts[0]?.status).toBe("unknown");
  });
  test("deletion survives restart and does not recreate erased work", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) =>
      createRun(v, "101", "hello", "-100100", 0, "gpt-4.1-mini"),
    );
    await store.change(w.id, (v) => {
      decide(v, "101", requestDeletion(v, "101").id, true);
      sweep(v);
    });
    await new Executor(store, setup).execute(w.id, r.id);
    const other = new Store(database(testUrl));
    expect((await other.read(w.id)).runs).toHaveLength(0);
    expect((await other.read(w.id)).deletion?.purgedAt).toBeTruthy();
    await other.pool.end();
  });
  test("Pi queries tenant-scoped model costs and persists an idempotent report", async () => {
    const w = await seed();
    const other = await seed();
    await store.change(other.id, (v) => {
      const r = createRun(v, "101", "unrelated", "101", 0, "gpt-4.1-mini");
      r.status = "succeeded";
      r.attempts.push({
        id: "other-cost",
        at: new Date().toISOString(),
        status: "settled",
        reserved: 100,
        actual: 100,
      });
    });
    const run = await store.change(w.id, (v) =>
      createRun(
        v,
        "101",
        "How much have I spent on model API calls?",
        "101",
        0,
        "gpt-4.1-mini",
      ),
    );
    let modelCalls = 0;
    const fake = new PiRunner((model, context) => {
      modelCalls++;
      if (modelCalls === 2) {
        const result = context.messages.findLast(
          (m) => m.role === "toolResult",
        );
        expect(result?.role).toBe("toolResult");
        if (result?.role !== "toolResult")
          throw new Error("missing cost result");
        expect(result.isError).toBe(false);
        const content = result.content[0];
        if (content?.type !== "text") throw new Error("missing cost text");
        const report = JSON.parse(content.text);
        expect(report.currency).toBe("USD");
        expect(report.scope).toBe("self");
        expect(report.totals.calls).toBe(1);
        expect(report.totals.settledUsd).toBe(0.00002);
        expect(report.totals.accountedUsd).toBe(0.00002);
      }
      const message = {
        role: "assistant" as const,
        content:
          modelCalls === 1
            ? [
                {
                  type: "toolCall" as const,
                  id: "cost-query",
                  name: "query_model_cost",
                  arguments: {},
                },
              ]
            : [
                {
                  type: "text" as const,
                  text: "Your recorded model cost is $0.00002 USD so far; this answer is excluded.",
                },
              ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: modelCalls === 1 ? ("toolUse" as const) : ("stop" as const),
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 10,
          totalTokens: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: {
            input: 0.000004,
            output: 0.000016,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.00002,
          },
        },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    });
    const executor = new Executor(store, setup, fake);
    await executor.execute(w.id, run.id);
    await executor.execute(w.id, run.id);
    const saved = await store.read(w.id);
    expect(modelCalls).toBe(2);
    expect(saved.runs[0]?.status).toBe("succeeded");
    expect(saved.runs[0]?.tools["cost-query"]?.state).toBe("done");
    expect(saved.runs[0]?.attempts).toHaveLength(2);
    expect(saved.deliveries).toHaveLength(1);
  });
  test("proposal tools pause the Pi loop durably and approval completes the run", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) =>
      createRun(
        v,
        "101",
        "Remember to use bullets",
        "-100100",
        0,
        "gpt-4.1-mini",
      ),
    );
    let modelCalls = 0;
    const fake = new PiRunner((model) => {
      modelCalls++;
      const stream = new AssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [
          {
            type: "toolCall" as const,
            id: "instruction-call",
            name: "propose_instruction",
            arguments: { body: "Use bullets", scope: "workspace" },
          },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "toolUse" as const,
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 10,
          totalTokens: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: {
            input: 0.000004,
            output: 0.000016,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.00002,
          },
        },
      };
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end(message);
      return stream;
    });
    await new Executor(store, setup, fake).execute(w.id, r.id);
    const saved = await store.read(w.id);
    expect(modelCalls).toBe(1);
    expect(saved.runs[0]?.status).toBe("awaiting_approval");
    expect(saved.approvals[0]?.runId).toBe(r.id);
    expect(saved.instructions).toHaveLength(0);
    await store.change(w.id, (v) =>
      decide(v, "101", v.approvals[0]?.id ?? "", true),
    );
    expect((await store.read(w.id)).instructions[0]?.body).toBe("Use bullets");
    expect((await store.read(w.id)).runs[0]?.status).toBe("succeeded");
  });
  test("zero budgets allow free dispatch but reject positive reservations", async () => {
    const w = await seed();
    await store.change(w.id, (v) => {
      v.settings.runBudgetUsd = 0;
      v.settings.monthlyBudgetUsd = 0;
    });
    for (const amount of [0, 0.001]) {
      const r = await store.change(w.id, (v) =>
        createRun(v, "101", "test", "101", 0, "gpt-4.1-mini"),
      );
      const runner: AgentRunner = {
        async run(input) {
          await input.reserve(amount);
          return {
            text: "Done",
            status: "succeeded",
            turns: 1,
            tools: 0,
            transcript: [],
          };
        },
      };
      await new Executor(store, setup, runner).execute(w.id, r.id);
      const saved = (await store.read(w.id)).runs.find(
        (run) => run.id === r.id,
      );
      expect(saved?.status).toBe(amount === 0 ? "succeeded" : "failed");
      if (amount > 0) expect(saved?.error).toBe("run_budget_exhausted");
    }
  });
  test("workspace budget reservation serializes concurrent runs", async () => {
    const w = await seed();
    await store.change(w.id, (v) => {
      v.settings.monthlyBudgetUsd = 0.02;
    });
    const first = await store.change(w.id, (v) =>
      createRun(v, "101", "first", "-100100", 1, "gpt-4.1-mini"),
    );
    const second = await store.change(w.id, (v) =>
      createRun(v, "101", "second", "-100100", 2, "gpt-4.1-mini"),
    );
    let allowed = 0;
    const runner: AgentRunner = {
      async run(input) {
        await input.reserve(0.015);
        allowed++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          text: "result",
          status: "succeeded",
          turns: 1,
          tools: 0,
          transcript: [],
        };
      },
    };
    await Promise.all([
      new Executor(store, setup, runner).execute(w.id, first.id),
      new Executor(store, setup, runner).execute(w.id, second.id),
    ]);
    expect(allowed).toBe(1);
    const current = await store.read(w.id);
    expect(
      current.runs.some((r) => r.error === "workspace_budget_exhausted"),
    ).toBe(true);
  });
  test("existing worker lease excludes a second executor", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) =>
      createRun(v, "101", "hello", "-100100", 0, "gpt-4.1-mini"),
    );
    let calls = 0;
    const runner: AgentRunner = {
      async run() {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          text: "result",
          status: "succeeded",
          turns: 1,
          tools: 0,
          transcript: [],
        };
      },
    };
    const results = await Promise.allSettled([
      new Executor(store, setup, runner).execute(w.id, r.id),
      new Executor(store, setup, runner).execute(w.id, r.id),
    ]);
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  test("approved skill versions remain pinned when a new version is published", async () => {
    const w = await seed();
    const r = await store.change(w.id, (v) =>
      createRun(v, "101", "hello", "-100100", 0, "gpt-4.1-mini"),
    );
    await store.change(w.id, (v) => {
      const skill = v.skills[0];
      if (skill)
        skill.published.push({ ...skill.draft, body: "Updated convention" });
    });
    const current = await store.read(w.id);
    expect(current.runs[0]?.skillPins[0]?.version).toBe(1);
    expect(r.skillPins[0]?.version).toBe(1);
  });
  test("group linking requires Telegram admin authority and cannot claim a group twice", async () => {
    const first = await seed();
    const second = await seed();
    for (const [w, raw] of [
      [first, "first-link"],
      [second, "second-link"],
    ] as const)
      await store.change(w.id, (v) => {
        v.chats = [];
        v.tokens.push({
          hash: hash(raw),
          actor: "101",
          kind: "group",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
      });
    const ingress = new Ingress(store, setup);
    const make = (update_id: number, text: string) => ({
      update_id,
      message: {
        message_id: update_id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100200, type: "supergroup" as const, title: "Team group" },
        from: { id: 101, is_bot: false },
        text,
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      },
    });
    membershipStatus = "member";
    await ingress.accept(make(901, "/link first-link"));
    expect((await store.read(first.id)).chats).toHaveLength(0);
    membershipStatus = "administrator";
    await ingress.accept(updateSchema.parse(make(902, "/link first-link")));
    expect((await store.read(first.id)).chats[0]?.active).toBe(true);
    expect((await store.read(first.id)).chats[0]?.title).toBe("Team group");
    await ingress.accept(make(903, "/link second-link"));
    expect((await store.read(second.id)).chats).toHaveLength(0);
    expect(
      (
        await store.pool.query(
          "SELECT * FROM chat_bindings WHERE chat_id='-100200'",
        )
      ).rows[0].workspace_id,
    ).toBe(first.id);
    const renamed = updateSchema.parse({
      ...make(904, ""),
      message: { ...make(904, "").message, new_chat_title: "Renamed team" },
    });
    await ingress.accept(renamed);
    expect((await store.read(first.id)).chats[0]?.title).toBe("Renamed team");
    await ingress.accept(updateSchema.parse(make(902, "/link first-link")));
    expect((await store.read(first.id)).chats[0]?.title).toBe("Renamed team");
    const withoutTitle = make(905, "");
    await ingress.accept(
      updateSchema.parse({
        ...withoutTitle,
        message: {
          ...withoutTitle.message,
          chat: { id: -100200, type: "supergroup" },
        },
      }),
    );
    expect((await store.read(first.id)).chats[0]?.title).toBe("Renamed team");
  });
  test("visibility recheck backfills group names and retains them when inaccessible", async () => {
    const w = await seed();
    const endpoint = `/api/admin/workspaces/${w.id}/chats`;
    const response = await request(`${endpoint}/-100100/visibility`, "POST");
    expect(response.status).toBe(200);
    expect((await store.read(w.id)).chats[0]?.title).toBe("DeepX team");
    expect((await (await request(endpoint)).json()).items[0].title).toBe(
      "DeepX team",
    );
    chatLookupFailure = true;
    try {
      expect(
        (await request(`${endpoint}/-100100/visibility`, "POST")).status,
      ).toBe(200);
      expect((await store.read(w.id)).chats[0]?.title).toBe("DeepX team");
    } finally {
      chatLookupFailure = false;
    }
    const before = calls.length;
    expect(
      (await request(`${endpoint}/-999999/visibility`, "POST")).status,
    ).toBe(404);
    expect(calls).toHaveLength(before);
  });
  test("approved correction survives reconnection and one scheduled recap is delivered before pause", async () => {
    const w = await seed();
    const now = new Date();
    const nextMinute = new Date(now.getTime() + 60000);
    const proposal = await store.change(w.id, (v) => {
      v.messages.push({
        id: "-100100:1",
        chatId: "-100100",
        topicId: 0,
        author: "101",
        text: "Release approved after QA",
        at: new Date(now.getTime() - 1000).toISOString(),
        expiresAt: new Date(now.getTime() + 86400000).toISOString(),
        directed: true,
      });
      const input = spec(v);
      input.recurrence = {
        frequency: "daily",
        hour: nextMinute.getUTCHours(),
        minute: nextMinute.getUTCMinutes(),
        timezone: "UTC",
      };
      const p = proposeWorkflow(v, "101", input, now);
      decide(v, "101", p.approval.id, true, now);
      const correction = proposeInstruction(
        v,
        "101",
        "Use bullet lists",
        "workflow",
        "manual-output",
        p.workflow.id,
      );
      decide(v, "101", correction.id, true);
      return p;
    });
    const second = new Store(database(testUrl));
    const scheduled = new Date(proposal.workflow.nextAt ?? "");
    await Promise.all([
      store.change(w.id, (v) => tick(v, "gpt-4.1-mini", scheduled)),
      second.change(w.id, (v) => tick(v, "gpt-4.1-mini", scheduled)),
    ]);
    const run = (await second.read(w.id)).runs[0];
    expect(run?.instructions[0]?.body).toBe("Use bullet lists");
    expect((await second.read(w.id)).runs).toHaveLength(1);
    const runner = new PiRunner((model, context) => {
      expect(context.systemPrompt).toContain("Use bullet lists");
      const stream = new AssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: "- Release approved after QA [source:-100100:1]",
          },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop" as const,
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 10,
          totalTokens: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: {
            input: 0.000004,
            output: 0.000016,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.00002,
          },
        },
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    });
    await new Executor(second, setup, runner).execute(w.id, run?.id ?? "");
    const delivery = (await second.read(w.id)).deliveries[0];
    const worker = new DeliveryWorker(second, setup);
    const before = calls.filter((c) => c.method === "sendRichMessage").length;
    await worker.send(w.id, delivery?.id ?? "");
    await worker.send(w.id, delivery?.id ?? "");
    expect(
      calls.filter((c) => c.method === "sendRichMessage").length - before,
    ).toBe(1);
    await second.change(w.id, (v) =>
      workflowAction(
        v,
        "101",
        proposal.workflow.id,
        "pause",
        1,
        "gpt-4.1-mini",
      ),
    );
    await second.change(w.id, (v) =>
      tick(v, "gpt-4.1-mini", new Date(scheduled.getTime() + 86400000)),
    );
    expect((await second.read(w.id)).runs).toHaveLength(1);
    await second.pool.end();
  });
  test("expired sessions fail even when the cookie is valid", async () => {
    const username = `test_${randomUUID().slice(0, 8)}`;
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash) VALUES($1,$2,$3)",
      [randomUUID(), username, await passwordHash("a long test password")],
    );
    const signed = await login(store.pool, username, "a long test password");
    await store.pool.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE csrf=$1",
      [signed.csrf],
    );
    expect(await session(store.pool, signed.raw)).toBeUndefined();
  });
});
