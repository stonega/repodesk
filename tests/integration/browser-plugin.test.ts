import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { claim } from "../../src/admin/auth.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { createApp } from "../../src/app.ts";
import type {
  BrowserHost,
  BrowserInvocation,
} from "../../src/browser/client.ts";
import { CodexBrowsers } from "../../src/browser/codex.ts";
import type { HostResult } from "../../src/browser/protocol.ts";
import { PostgresBrowserRepository } from "../../src/browser/repository.ts";
import { BrowserService } from "../../src/browser/service.ts";
import { developmentPolicy } from "../../src/coding/development.ts";
import { taskGet, taskSave } from "../../src/coding/task-store.ts";
import { startDevelopment } from "../../src/coding/tasks.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { type Telegram, TelegramError } from "../../src/telegram/client.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL,
  key = "ca".repeat(32),
  origin = "http://localhost:3000";
(url ? describe : describe.skip)(
  "Browser production plugin and private continuations",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused"),
      name = `repodesk_browser_plugin_${randomUUID().replaceAll("-", "")}`;
    let store: Store,
      setup: SetupService,
      browser: BrowserService,
      plugins: PluginService,
      admin: Admin;
    let auth: { raw: string; csrf: string };
    const calls: BrowserInvocation[] = [],
      telegramCalls: { method: string; params: Record<string, unknown> }[] = [];
    const page = {
      id: randomUUID(),
      revision: 1,
      origin: "https://example.com",
    };
    const host: BrowserHost = {
      async invoke(input) {
        calls.push(structuredClone(input));
        const operation = input.operation;
        if (operation.command === "review")
          return {
            status: "completed",
            page,
            approvalRequired:
              !input.policy?.routineOrigins?.includes(page.origin) ||
              ("requireApproval" in operation.input &&
                !!operation.input.requireApproval) ||
              !(
                operation.input.action === "fill" ||
                (operation.input.action === "click" &&
                  operation.input.selector === "#next")
              ),
          };
        if (operation.command === "action") {
          if (operation.input.action === "read")
            return {
              status: "completed",
              page,
              text: "private-account-balance-fixture",
            };
          return { status: "completed", page };
        }
        return {
          status:
            operation.command === "delete"
              ? "deleted"
              : operation.command === "close"
                ? "closed"
                : "ready",
          headed: true,
        } as HostResult;
      },
    };
    const telegram: Telegram = {
      async call<T>(method: string, params = {}) {
        telegramCalls.push({ method, params });
        return { message_id: 123 } as T;
      },
    };
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const target = new URL(url ?? "");
      target.pathname = `/${name}`;
      store = new Store(database(target.toString()), undefined, key);
      await migrate(store.pool);
      auth = await claim(
        store.pool,
        "browseroperator",
        "browser plugin test password",
      );
      const row = (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='browseroperator'",
        )
      ).rows[0];
      admin = { id: row.id, username: "browseroperator", operator: true };
      const deployment = await store.deployment();
      Object.assign(deployment, {
        active: true,
        paused: false,
        bot: { id: "999", username: "fixture_bot", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:synthetic"),
          model: encrypt(key, "model", "synthetic"),
        },
      });
      await store.saveDeployment(store.pool, deployment);
      setup = new SetupService(store, key, origin, () => telegram);
      browser = new BrowserService(store, key, host);
      browser.coding = new CodexBrowsers(store, browser, key, origin);
      plugins = new PluginService(
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        browser,
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function seed(task = "Read the personal website", topic = 7) {
      const w = workspace();
      w.operatorId = admin.id;
      const run = createRun(w, "202", task, "202", topic, "gpt-4.1-mini", {
        botId: "999",
      });
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      return { w, run };
    }
    let nextInput = 900000;
    async function input(w: { id: string }, text: string, topic = 7) {
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES('202',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [w.id],
      );
      const update = {
        update_id: nextInput++,
        message: {
          message_id: nextInput++,
          date: Math.floor(Date.now() / 1000),
          from: { id: 202, is_bot: false, first_name: "Fixture" },
          chat: { id: 202, type: "private" as const },
          message_thread_id: topic,
          text,
        },
      };
      const ingress = new Ingress(store, setup);
      await ingress.accept(update);
      return { update, ingress };
    }
    function launch(actor: string, reference: string) {
      const fields = new URLSearchParams({
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id: Number(actor) }),
        start_param: reference,
      });
      const check = [...fields]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      fields.set(
        "hash",
        createHmac(
          "sha256",
          createHmac("sha256", "WebAppData").update("999:synthetic").digest(),
        )
          .update(check)
          .digest("hex"),
      );
      return fields.toString();
    }
    function personal(
      w: { id: string },
      actor: string,
      path: string,
      operation?: unknown,
      headers: Record<string, string> = {},
    ) {
      const reference = `browser_${w.id.replaceAll("-", "")}`;
      return createApp(store, setup, origin, plugins, undefined, key).request(
        `/mini-api/browser/${path}`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json", ...headers },
          body: JSON.stringify({
            initData: launch(actor, reference),
            reference,
            ...(operation === undefined ? {} : { operation }),
          }),
        },
      );
    }
    function modelSequence(
      steps: ({ name: string; args: Record<string, unknown> } | string)[],
    ): StreamFn {
      let sequence = 0;
      return (model) => {
        const next = steps[sequence++];
        if (!next)
          throw Error("Unexpected model turn while browser task is waiting");
        const message: AssistantMessage = {
          role: "assistant",
          content:
            typeof next === "string"
              ? [{ type: "text", text: next }]
              : [
                  {
                    type: "toolCall",
                    id: `browser-call-${sequence}`,
                    name: next.name,
                    arguments: next.args,
                  },
                ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: typeof next === "string" ? "stop" : "toolUse",
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        const stream = new AssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: message.stopReason === "stop" ? "stop" : "toolUse",
          message,
        });
        stream.end(message);
        return stream;
      };
    }
    test("progress and continue observe the original paused task without acquiring, refilling or creating another approval", async () => {
      const { w, run } = await seed(
        "Download the requested video from the website",
      );
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "navigate", url: "https://example.com/download" },
            },
          ]),
        ),
      );
      await executor.execute(w.id, run.id);
      const repo = new PostgresBrowserRepository(store.pool, key);
      const owner = { workspaceId: w.id, actor: "202" };
      const before = await repo.read(owner);
      const callCount = calls.length;
      const { update, ingress } = await input(w, "what is the progress");
      await ingress.accept(update);
      await input(w, "continue");
      const current = await store.read(w.id);
      expect(current.runs).toHaveLength(1);
      expect(current.runs[0]).toMatchObject({
        id: run.id,
        task: run.task,
        status: "awaiting_approval",
      });
      expect(await repo.read(owner)).toEqual(before);
      expect(calls.length).toBe(callCount);
      const notices = current.deliveries.filter((d) => d.browserTaskState);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toMatchObject({
        runId: run.id,
        actor: "202",
        chatId: "202",
        topicId: 7,
      });
      expect(notices[0]?.text).toContain("https://example.com");
      expect(notices[0]?.text).toContain("Allow website");
      if (!notices[0]) throw Error("missing status notice");
      const beforeSend = telegramCalls.length;
      await new DeliveryWorker(store, setup).send(w.id, notices[0].id);
      expect(telegramCalls.slice(beforeSend)).toEqual([
        {
          method: "sendMessage",
          params: expect.objectContaining({
            chat_id: "202",
            message_thread_id: 7,
            text: notices[0].text,
          }),
        },
      ]);
      const pendingNotice = notices[1];
      if (!pendingNotice || !before.access?.requests[0])
        throw Error("missing pending status");
      await browser.decide(owner, before.access.requests[0].id, true);
      await browser.reconcile(w.id);
      await new DeliveryWorker(store, setup).send(w.id, pendingNotice.id);
      const refreshed = (await store.read(w.id)).deliveries.find(
        (d) => d.id === pendingNotice.id,
      );
      expect(refreshed?.state).toBe("sent");
      expect(refreshed?.text).toContain("queued");
      expect(refreshed?.text).not.toContain("Allow website");
      expect(refreshed?.buttons).toBeUndefined();
    });
    for (const transition of ["approval", "revocation"] as const)
      test(`requested Browser status handles ${transition} after claim and before dispatch`, async () => {
        const { w, run } = await seed("Continue the original Browser goal");
        await new Executor(store, setup, (d, id) =>
          plugins.runner(
            d,
            id,
            modelSequence([
              {
                name: "browser_action",
                args: { action: "navigate", url: "https://example.com" },
              },
            ]),
          ),
        ).execute(w.id, run.id);
        const site = (await store.read(w.id)).runs[0]?.browserWait;
        if (!site) throw Error("missing website decision");
        await input(w, "progress");
        const notice = (await store.read(w.id)).deliveries.find(
          (d) => d.browserTaskState?.refresh,
        );
        if (!notice) throw Error("missing requested status");
        let armed = true;
        const changing = new Proxy(store, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== "change")
              return typeof value === "function" ? value.bind(target) : value;
            return async (...args: Parameters<Store["change"]>) => {
              const result = await target.change(...args);
              if (
                armed &&
                result !== null &&
                typeof result === "object" &&
                "id" in result &&
                result.id === notice.id &&
                "state" in result &&
                result.state === "sending"
              ) {
                armed = false;
                if (transition === "approval") {
                  await browser.decide(
                    { workspaceId: w.id, actor: "202" },
                    site.id,
                    true,
                  );
                  await browser.reconcile(w.id);
                } else
                  await store.change(w.id, (current) => {
                    const member = current.members.find((m) => m.id === "202");
                    if (member) member.active = false;
                  });
              }
              return result;
            };
          },
        });
        const before = telegramCalls.length;
        await new DeliveryWorker(changing, setup).send(w.id, notice.id);
        expect(armed).toBe(false);
        const delivered = (await store.read(w.id)).deliveries.find(
          (d) => d.id === notice.id,
        );
        if (transition === "approval") {
          expect(delivered?.state).toBe("sent");
          expect(delivered?.text).toContain("queued");
          expect(delivered?.buttons).toBeUndefined();
          expect(telegramCalls.slice(before)).toEqual([
            {
              method: "sendMessage",
              params: expect.objectContaining({ text: delivered?.text }),
            },
          ]);
        } else {
          expect(delivered?.state).toBe("cancelled");
          expect(telegramCalls.slice(before)).toEqual([]);
        }
      });
    test("requested Browser status survives repeated safe Telegram retries and follows the latest wait", async () => {
      const { w, run } = await seed(
        "Keep working on the original Browser goal",
      );
      const sequence = modelSequence([
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com" },
        },
        {
          name: "browser_action",
          args: { action: "click", selector: "#submit", requireApproval: true },
        },
      ]);
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(d, id, sequence),
      );
      await executor.execute(w.id, run.id);
      const site = (await store.read(w.id)).runs[0]?.browserWait;
      if (!site) throw Error("missing initial website decision");
      await input(w, "progress");
      const notice = (await store.read(w.id)).deliveries.find(
        (d) => d.browserTaskState?.refresh,
      );
      if (!notice) throw Error("missing requested status");
      const attempts: Record<string, unknown>[] = [];
      const limited: Telegram = {
        async call<T>(method: string, params = {}) {
          expect(method).toBe("sendMessage");
          attempts.push(structuredClone(params));
          if (attempts.length < 3)
            throw new TelegramError("telegram_rate_limited", "retry", 1);
          return telegram.call<T>(method, params);
        },
      };
      const worker = new DeliveryWorker(
        store,
        new SetupService(store, key, origin, () => limited),
      );
      const retry = async () => {
        await store.change(w.id, (current) => {
          const d = current.deliveries.find((d) => d.id === notice.id);
          if (d) d.nextAt = new Date(0).toISOString();
        });
        await worker.send(w.id, notice.id);
      };
      await worker.send(w.id, notice.id);
      expect(attempts[0]?.text).toContain("Allow website");
      expect(
        (await store.read(w.id)).deliveries.find((d) => d.id === notice.id)
          ?.state,
      ).toBe("pending");
      await browser.decide({ workspaceId: w.id, actor: "202" }, site.id, true);
      await browser.reconcile(w.id);
      await retry();
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.text).toContain("queued");
      expect(attempts[1]?.reply_markup).toBeUndefined();
      await executor.execute(w.id, run.id);
      expect((await store.read(w.id)).runs[0]?.browserWait?.kind).toBe(
        "action",
      );
      await retry();
      expect(attempts).toHaveLength(3);
      expect(attempts[2]?.text).toContain("click a control");
      expect(attempts[2]?.reply_markup).toMatchObject({
        inline_keyboard: [[{ text: "Open Browser" }]],
      });
      const sent = (await store.read(w.id)).deliveries.find(
        (d) => d.id === notice.id,
      );
      expect(sent).toMatchObject({ state: "sent", attempts: 3, remoteId: 123 });
      await worker.send(w.id, notice.id);
      expect(attempts).toHaveLength(3);
    });
    test("an unrecognized progress turn cannot steal the paused Browser even after its lease expires", async () => {
      const { w, run } = await seed("Finish the original browser goal");
      const original = new Executor(store, setup, (d, id) =>
        plugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "navigate", url: "https://example.com" },
            },
          ]),
        ),
      );
      await original.execute(w.id, run.id);
      const repo = new PostgresBrowserRepository(store.pool, key);
      const owner = { workspaceId: w.id, actor: "202" };
      await repo.change(owner, (state) => {
        if (state.lease) state.lease.expiresAt = 0;
      });
      const before = await repo.read(owner);
      const callCount = calls.length;
      await input(w, "Could you explain where this task has got to?");
      const observer = (await store.read(w.id)).runs.find(
        (r) => r.id !== run.id,
      );
      if (!observer) throw Error("missing observer turn");
      expect(observer.browserObserverOf).toBe(run.id);
      await new Executor(store, setup, (d, id) =>
        plugins.runner(
          d,
          id,
          modelSequence([
            { name: "browser_session", args: { action: "status" } },
            {
              name: "browser_action",
              args: { action: "navigate", url: "https://example.com/restart" },
            },
            "The original browser task is waiting for your website permission.",
          ]),
        ),
      ).execute(w.id, observer.id);
      const current = await store.read(w.id);
      const completed = current.runs.find((r) => r.id === observer.id);
      expect(completed?.status).toBe("succeeded");
      expect(JSON.stringify(completed?.tools)).toContain(
        "browser_task_in_progress",
      );
      expect(JSON.stringify(completed?.tools)).toContain("observerOnly");
      expect(
        current.runs.find((r) => r.id === run.id)?.browserWait,
      ).toBeDefined();
      expect(await repo.read(owner)).toEqual(before);
      expect(calls.length).toBe(callCount);
      expect(current.deliveries.filter((d) => d.browserRequest)).toHaveLength(
        1,
      );
      expect(completed?.browserObserverOf).toBe(run.id);
      await store.change(w.id, (state) => {
        const parent = state.runs.find((r) => r.id === run.id);
        const observing = state.runs.find((r) => r.id === observer.id);
        if (!parent || !observing) throw Error("missing task pair");
        parent.status = "succeeded";
        delete parent.browserWait;
        observing.status = "running";
      });
      expect(
        await browser.tool(
          w.id,
          observer.id,
          "202",
          0,
          completed?.fence ?? 0,
          "browser_action",
          {
            action: "navigate",
            url: "https://example.com/restart-after-completion",
          },
          "late-navigation",
        ),
      ).toMatchObject({
        status: "unavailable",
        code: "browser_task_in_progress",
        observerOnly: true,
        task: { runId: run.id, status: "succeeded" },
      });
      expect(calls.length).toBe(callCount);
    });
    test("an expired action explains its outcome once and explicit retry resumes the same transcript with a fresh decision", async () => {
      const { w, run } = await seed(
        "Submit the original video link and verify its download",
      );
      const sequence = modelSequence([
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com" },
        },
        {
          name: "browser_action",
          args: { action: "click", selector: "#submit", requireApproval: true },
        },
        { name: "browser_action", args: { action: "read" } },
        {
          name: "browser_action",
          args: { action: "click", selector: "#submit", requireApproval: true },
        },
      ]);
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(d, id, sequence),
      );
      const owner = { workspaceId: w.id, actor: "202" };
      const repo = new PostgresBrowserRepository(store.pool, key);
      await executor.execute(w.id, run.id);
      const site = (await store.read(w.id)).runs[0]?.browserWait;
      if (!site) throw Error("missing website decision");
      await browser.decide(owner, site.id, true);
      await browser.reconcile(w.id);
      await executor.execute(w.id, run.id);
      const action = (await store.read(w.id)).runs[0]?.browserWait;
      if (!action) throw Error("missing action decision");
      await repo.change(owner, (state) => {
        const request = state.access?.requests.find((r) => r.id === action.id);
        if (request) request.expiresAt = Date.now() - 1;
      });
      await Promise.all([browser.reconcile(w.id), browser.reconcile(w.id)]);
      let current = await store.read(w.id);
      expect(current.runs[0]?.error).toBe("browser_request_expired");
      const notices = current.deliveries.filter(
        (d) => d.id === `browser:${action.id}:ended`,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.text).toContain("expired");
      expect(
        current.deliveries.find((d) => d.id === `browser:${action.id}`)?.text,
      ).toContain("click a control on https://example.com");
      const oldLength = current.runs[0]?.transcript.length ?? 0;
      await input(w, "try again");
      current = await store.read(w.id);
      expect(current.runs).toHaveLength(1);
      expect(current.runs[0]).toMatchObject({
        id: run.id,
        task: run.task,
        status: "queued",
      });
      expect(current.runs[0]?.transcript.length).toBe(oldLength);
      await new DeliveryWorker(store, setup).send(
        w.id,
        `browser:${action.id}:ended`,
      );
      expect(
        (await store.read(w.id)).deliveries.find(
          (d) => d.id === `browser:${action.id}:ended`,
        )?.state,
      ).toBe("cancelled");
      await executor.execute(w.id, run.id);
      const resumed = (await store.read(w.id)).runs[0];
      expect(resumed?.status).toBe("awaiting_approval");
      expect(resumed?.id).toBe(run.id);
      expect(resumed?.task).toBe(run.task);
      expect(
        resumed?.sources.some((source) => source.text === "try again"),
      ).toBe(true);
      expect(resumed?.browserWait?.kind).toBe("action");
      expect(resumed?.browserWait?.id).not.toBe(action.id);
      const page = await (await personal(w, "202", "view")).json();
      expect(
        page.requests.find(
          (request: { id: string }) => request.id === resumed?.browserWait?.id,
        )?.task,
      ).toBe(run.task);
      expect(
        (await repo.read(owner)).access?.requests.find(
          (r) => r.id === action.id,
        )?.state,
      ).toBe("expired");
      expect(
        calls.filter(
          (c) =>
            c.owner.workspaceId === w.id &&
            c.operation.command === "action" &&
            c.operation.input.action === "click",
        ),
      ).toHaveLength(0);
    });
    test("a progress turn bound at ingress remains read-only if the task finishes before its first tool call", async () => {
      const { w, run } = await seed("Complete the original Browser goal");
      await new Executor(store, setup, (d, id) =>
        plugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "navigate", url: "https://example.com" },
            },
          ]),
        ),
      ).execute(w.id, run.id);
      await input(w, "Please explain how the ongoing task is getting on");
      const observer = (await store.read(w.id)).runs.find(
        (r) => r.id !== run.id,
      );
      expect(observer?.browserObserverOf).toBe(run.id);
      if (!observer) throw Error("missing observer");
      await store.change(w.id, (w) => {
        const r = w.runs.find((r) => r.id === run.id);
        if (r) {
          r.status = "succeeded";
          delete r.browserWait;
        }
      });
      const count = calls.length;
      await new Executor(store, setup, (d, id) =>
        plugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "navigate", url: "https://example.com/restart" },
            },
            "The original task has finished; see its final response.",
          ]),
        ),
      ).execute(w.id, observer.id);
      expect(calls.length).toBe(count);
      const current = (await store.read(w.id)).runs.find(
        (r) => r.id === observer.id,
      );
      expect(current?.status).toBe("succeeded");
      expect(JSON.stringify(current?.tools)).toContain(
        "browser_task_in_progress",
      );
    });
    test("a denied-origin review retains recovery evidence without an action or another approval", async () => {
      const { w, run } = await seed("Inspect the requested submit safely");
      const repo = new PostgresBrowserRepository(store.pool, key);
      await repo.change({ workspaceId: w.id, actor: "202" }, (state) => {
        state.access = {
          grants: [],
          sites: [
            {
              origin: page.origin,
              preview: false,
              configuration: 0,
              epoch: 0,
              approvedAt: Date.now(),
            },
          ],
          requests: [],
        };
      });
      const service = new BrowserService(store, key, {
        invoke: async (invocation) =>
          invocation.operation.command === "review"
            ? {
                status: "unavailable",
                text: "browser_destination_denied",
                blockedOrigins: ["https://required.example"],
              }
            : host.invoke(invocation),
      });
      const scoped = new PluginService(
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        service,
      );
      await new Executor(store, setup, (d, id) =>
        scoped.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: {
                action: "click",
                selector: "#submit",
                requireApproval: true,
              },
            },
            "The browser reported a destination requiring review before I can proceed.",
          ]),
        ),
      ).execute(w.id, run.id);
      const current = await store.read(w.id);
      expect(current.runs[0]?.status).toBe("succeeded");
      expect(JSON.stringify(current.runs[0]?.tools)).toContain(
        "https://required.example",
      );
      expect(current.runs[0]?.browserWait).toBeUndefined();
      expect(
        (await repo.read({ workspaceId: w.id, actor: "202" })).access?.requests,
      ).toHaveLength(0);
      expect(
        calls.filter(
          (c) =>
            c.owner.workspaceId === w.id && c.operation.command === "action",
        ),
      ).toHaveLength(0);
    });
    test("ordinary member pauses for site consent, resumes the same run and retains private results encrypted", async () => {
      const { w, run } = await seed();
      const stream = modelSequence([
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com/private" },
        },
        { name: "browser_action", args: { action: "read" } },
        "private-account-balance-fixture",
      ]);
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(d, id, stream),
      );
      await executor.execute(w.id, run.id);
      let saved = (await store.read(w.id)).runs.find(
        (item) => item.id === run.id,
      );
      expect(saved?.status).toBe("awaiting_approval");
      expect(saved?.browserWait?.kind).toBe("site");
      expect(saved?.result).toBeUndefined();
      expect(
        calls.filter(
          (call) =>
            call.owner.workspaceId === w.id &&
            call.operation.command === "action",
        ),
      ).toHaveLength(0);
      if (!saved?.browserWait) throw Error("missing browser wait");
      await expect(
        browser.decide(
          { workspaceId: w.id, actor: "101" },
          saved.browserWait.id,
          true,
        ),
      ).rejects.toThrow("browser_request_unavailable");
      const requestId = saved.browserWait.id;
      expect(
        (await store.read(w.id)).deliveries.filter((d) => d.browserResume),
      ).toHaveLength(0);
      expect(
        (
          await personal(w, "202", "decide", {
            id: requestId,
            approve: true,
          })
        ).status,
      ).toBe(200);
      expect(
        (await store.read(w.id)).deliveries.filter((d) => d.browserResume),
      ).toHaveLength(0);
      await Promise.all([browser.reconcile(w.id), browser.reconcile(w.id)]);
      saved = (await store.read(w.id)).runs.find((item) => item.id === run.id);
      expect(saved?.status).toBe("queued");
      expect(saved?.browserWait).toBeUndefined();
      await new BrowserService(store, key, host).reconcile(w.id);
      const notifications = (await store.read(w.id)).deliveries.filter(
        (d) => d.browserResume,
      );
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        id: `browser:${requestId}:resumed`,
        actor: "202",
        chatId: "202",
        topicId: 7,
        runId: run.id,
        browserRead: { owner: "202", botId: "999" },
        browserResume: { id: requestId },
      });
      const worker = new DeliveryWorker(store, setup);
      const beforeNotice = telegramCalls.length;
      await worker.send(w.id, `browser:${requestId}`);
      await worker.send(w.id, `browser:${requestId}:resumed`);
      await worker.send(w.id, `browser:${requestId}:resumed`);
      expect(telegramCalls.slice(beforeNotice)).toEqual([
        {
          method: "sendMessage",
          params: expect.objectContaining({
            chat_id: "202",
            message_thread_id: 7,
            text: "Browser request completed. I’m continuing your task.",
          }),
        },
      ]);
      await executor.execute(w.id, run.id);
      saved = (await store.read(w.id)).runs.find((item) => item.id === run.id);
      expect(saved?.status).toBe("succeeded");
      expect(saved?.result).toBe("private-account-balance-fixture");
      expect(saved?.fence).toBe(2);
      await browser.reconcile(w.id);
      expect(
        calls.filter(
          (call) =>
            call.owner.workspaceId === w.id &&
            call.operation.command === "action" &&
            call.operation.input.action === "navigate",
        ),
      ).toHaveLength(1);
      const raw = (
        await store.pool.query("SELECT data FROM workspaces WHERE id=$1", [
          w.id,
        ])
      ).rows[0].data;
      expect(JSON.stringify(raw)).not.toContain(
        "private-account-balance-fixture",
      );
      const app = createApp(store, setup, origin, plugins, undefined, key);
      const response = await app.request(
        `/api/admin/workspaces/${w.id}/runs/${run.id}`,
        { headers: { cookie: `repodesk_session=${auth.raw}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(
        "private-account-balance-fixture",
      );
      const result = (await store.read(w.id)).deliveries.find(
        (delivery) =>
          delivery.runId === run.id && delivery.id === `run:${run.id}:result`,
      );
      if (!result) throw Error("missing private delivery");
      await store.change(w.id, (current) => {
        const delivery = current.deliveries.find(
          (item) => item.id === result.id,
        );
        if (delivery) delivery.chatId = "-100100";
      });
      const before = telegramCalls.length;
      await new DeliveryWorker(store, setup).send(w.id, result.id);
      expect(
        telegramCalls
          .slice(before)
          .some((call) =>
            JSON.stringify(call.params).includes(
              "private-account-balance-fixture",
            ),
          ),
      ).toBe(false);
    });
    test("Pi keeps website work in one run and remembered access survives new tasks, close and reconstruction until revoked", async () => {
      const { w, run } = await seed(
        "Read my account, navigate and prepare a change",
      );
      const owner = { workspaceId: w.id, actor: "202" };
      const sequence = modelSequence([
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com/account" },
        },
        {
          name: "browser_action",
          args: { action: "fill", selector: "#search", text: "report" },
        },
        {
          name: "browser_action",
          args: { action: "click", selector: "#next" },
        },
        {
          name: "browser_action",
          args: { action: "click", selector: "#submit", requireApproval: true },
        },
        "The original account task is complete.",
      ]);
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(d, id, sequence),
      );
      await executor.execute(w.id, run.id);
      const site = (await store.read(w.id)).runs[0]?.browserWait;
      if (!site) throw Error("missing website request");
      expect(
        (await personal(w, "202", "decide", { id: site.id, approve: true }))
          .status,
      ).toBe(200);
      await browser.reconcile(w.id);
      await executor.execute(w.id, run.id);
      let saved = await store.read(w.id);
      expect(saved.runs).toHaveLength(1);
      expect(saved.runs[0]?.task).toBe(run.task);
      const submission = saved.runs[0]?.browserWait;
      expect(submission?.kind).toBe("action");
      const actions = () =>
        calls.filter(
          (c) =>
            c.owner.workspaceId === w.id && c.operation.command === "action",
        );
      expect(
        actions().filter(
          (c) =>
            c.operation.command === "action" &&
            ["fill", "click"].includes(c.operation.input.action),
        ),
      ).toHaveLength(2);
      if (!submission) throw Error("missing submission approval");
      await browser.decide(owner, submission.id, true);
      await browser.reconcile(w.id);
      expect(
        (await store.read(w.id)).deliveries.find(
          (d) => d.browserResume?.id === submission.id,
        ),
      ).toMatchObject({ runId: run.id, topicId: run.topicId });
      await executor.execute(w.id, run.id);
      saved = await store.read(w.id);
      expect(saved.runs[0]?.status).toBe("succeeded");
      expect(saved.runs[0]?.result).toBe(
        "The original account task is complete.",
      );
      expect((await personal(w, "202", "view")).status).toBe(200);
      expect(
        (await (await personal(w, "202", "view")).json()).savedOrigins,
      ).toEqual([page.origin]);
      expect(
        (await (await personal(w, "101", "view")).json()).savedOrigins,
      ).toEqual([]);
      const otherWorkspace = await seed();
      expect(
        (await (await personal(otherWorkspace.w, "202", "view")).json())
          .savedOrigins,
      ).toEqual([]);
      await personal(w, "202", "operate", { command: "close" });
      await browser.reconcile(w.id);
      const restarted = new BrowserService(store, key, host);
      const restartedPlugins = new PluginService(
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        restarted,
      );
      const next = await store.change(w.id, (current) =>
        createRun(
          current,
          "202",
          "Read my account again",
          "202",
          7,
          "gpt-4.1-mini",
          { botId: "999" },
        ),
      );
      await new Executor(store, setup, (d, id) =>
        restartedPlugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "navigate", url: "https://example.com/account" },
            },
            "Account checked again.",
          ]),
        ),
      ).execute(w.id, next.id);
      expect(
        (await store.read(w.id)).runs.find((r) => r.id === next.id)?.status,
      ).toBe("succeeded");
      const repo = new PostgresBrowserRepository(store.pool, key);
      expect(
        (await repo.read(owner)).access?.requests.filter(
          (r) => r.kind === "site",
        ),
      ).toHaveLength(1);
      expect(
        (
          await personal(w, "202", "operate", {
            command: "revoke_site",
            origin: page.origin,
          })
        ).status,
      ).toBe(200);
      await browser.reconcile(w.id);
      expect(
        (await (await personal(w, "202", "view")).json()).savedOrigins,
      ).toEqual([]);
      const last = await store.change(w.id, (current) =>
        createRun(
          current,
          "202",
          "Revisit the revoked website",
          "202",
          7,
          "gpt-4.1-mini",
          { botId: "999" },
        ),
      );
      await new Executor(store, setup, (d, id) =>
        restartedPlugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "navigate", url: "https://example.com/account" },
            },
          ]),
        ),
      ).execute(w.id, last.id);
      const pending = (await store.read(w.id)).runs.find(
        (r) => r.id === last.id,
      )?.browserWait;
      expect(pending?.kind).toBe("site");
      expect((await repo.read(owner)).access?.sites).toEqual([]);
      if (!pending) throw Error("missing renewed request");
      await browser.decide(owner, pending.id, true);
      expect(
        (await (await personal(w, "202", "view")).json()).savedOrigins,
      ).toEqual([page.origin]);
      // A closed browser can have an approved request without an active lease.
      // Revoking before the worker processes it must not restore that consent.
      await personal(w, "202", "operate", {
        command: "revoke_site",
        origin: page.origin,
      });
      await browser.reconcile(w.id);
      expect((await repo.read(owner)).access?.sites).toEqual([]);
      expect(
        (await store.read(w.id)).runs.find((r) => r.id === last.id)?.status,
      ).toBe("partial");
    });
    test("interrupted navigation retains website consent for fresh calls in the same run", async () => {
      const { w, run } = await seed();
      const owner = { workspaceId: w.id, actor: "202" },
        repo = new PostgresBrowserRepository(store.pool, key);
      let interrupted = false;
      const flakyBrowser = new BrowserService(store, key, {
        async invoke(input) {
          const result = await host.invoke(input);
          if (
            !interrupted &&
            input.operation.command === "action" &&
            input.operation.input.action === "navigate"
          ) {
            interrupted = true;
            throw Error("synthetic lost navigation response");
          }
          return result;
        },
      });
      const flakyPlugins = new PluginService(
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        flakyBrowser,
      );
      const sequence = modelSequence([
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com/account" },
        },
        { name: "browser_action", args: { action: "read" } },
        {
          name: "browser_action",
          args: { action: "request_site", url: "https://example.com/account" },
        },
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com/account" },
        },
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com/account" },
        },
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com/reports" },
        },
        "Account checked after interrupted navigation.",
      ]);
      const executor = new Executor(store, setup, (d, id) =>
        flakyPlugins.runner(d, id, sequence),
      );
      await executor.execute(w.id, run.id);
      const pending = (await store.read(w.id)).runs[0]?.browserWait;
      if (!pending) throw Error("missing website request");
      await flakyBrowser.decide(owner, pending.id, true);
      await flakyBrowser.reconcile(w.id);
      expect((await repo.read(owner)).access?.requests[0]?.result).toEqual({
        status: "unavailable",
        code: "browser_outcome_unknown",
      });
      expect(
        (await store.read(w.id)).deliveries.filter((d) => d.browserResume),
      ).toHaveLength(0);

      await executor.execute(w.id, run.id);
      const saved = (await store.read(w.id)).runs[0];
      expect(saved?.status).toBe("succeeded");
      expect(saved?.browserWait).toBeUndefined();
      expect(saved?.result).toBe(
        "Account checked after interrupted navigation.",
      );
      const state = await repo.read(owner);
      expect(state.access?.sites.map((site) => site.origin)).toEqual([
        page.origin,
      ]);
      expect(state.access?.requests).toHaveLength(1);
      expect(
        state.operations.filter((op) => op.state === "started"),
      ).toHaveLength(1);
      const navigations = calls.filter(
        (call) =>
          call.owner.workspaceId === w.id &&
          call.operation.command === "action" &&
          call.operation.input.action === "navigate",
      );
      expect(navigations).toHaveLength(4);
      expect(
        state.operations.filter((op) => op.state === "completed"),
      ).toHaveLength(4);
    });
    test("the member portal verifies signed identity, origin and membership without an admin login", async () => {
      const { w, run } = await seed();
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "navigate", url: "https://example.com" },
            },
          ]),
        ),
      );
      await executor.execute(w.id, run.id);
      const own = await personal(w, "202", "view");
      expect(own.status).toBe(200);
      const data = await own.json();
      expect(data.requests).toHaveLength(1);
      expect(data.requests[0].origin).toBe("https://example.com");
      const foreign = await personal(w, "101", "view");
      expect(foreign.status).toBe(200);
      expect((await foreign.json()).requests).toHaveLength(0);
      expect(
        (
          await personal(w, "101", "decide", {
            id: data.requests[0].id,
            approve: true,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await personal(w, "202", "view", undefined, {
            origin: "https://untrusted.example",
          })
        ).status,
      ).toBe(403);
      const reference = `browser_${w.id.replaceAll("-", "")}`;
      const noIdentity = await createApp(
        store,
        setup,
        origin,
        plugins,
        undefined,
        key,
      ).request("/mini-api/browser/view", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: `repodesk_session=${auth.raw}`,
        },
        body: JSON.stringify({ initData: "", reference }),
      });
      expect(noIdentity.status).toBe(401);
      const altered = launch("202", reference).replace("202", "101");
      const tampered = await createApp(
        store,
        setup,
        origin,
        plugins,
        undefined,
        key,
      ).request("/mini-api/browser/view", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ initData: altered, reference }),
      });
      expect(tampered.status).toBe(401);
      expect(
        (
          await personal(w, "202", "decide", {
            id: data.requests[0].id,
            approve: true,
          })
        ).status,
      ).toBe(200);
      await browser.reconcile(w.id);
      const state = await new PostgresBrowserRepository(store.pool, key).read({
        workspaceId: w.id,
        actor: "202",
      });
      expect(
        (
          await personal(w, "202", "operate", {
            command: "takeover",
            revision: state.revision,
          })
        ).status,
      ).toBe(200);
      const human = await personal(w, "202", "view");
      const currentHuman = await human.json();
      expect(currentHuman.controller.kind).toBe("human");
      expect(
        (
          await personal(w, "202", "operate", {
            command: "action",
            generation: currentHuman.generation,
            operationId: randomUUID(),
            input: { action: "pointer", x: 10, y: 10 },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await personal(w, "202", "operate", {
            command: "prepare_input",
            generation: currentHuman.generation,
            operationId: randomUUID(),
            page,
            kind: "password",
          })
        ).status,
      ).toBe(200);
      const manual = await (await personal(w, "202", "view")).json(),
        submissionId = randomUUID();
      expect(manual.input.consumer).toBe("human");
      const secure = {
        id: manual.input.id,
        submissionId,
        value: "synthetic-manual-password",
      };
      expect((await personal(w, "202", "input", secure)).status).toBe(200);
      expect((await personal(w, "202", "input", secure)).status).toBe(200);
      expect(
        calls.filter(
          (call) =>
            call.owner.workspaceId === w.id &&
            call.operation.command === "input",
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(await store.read(w.id))).not.toContain(
        secure.value,
      );
      await store.change(w.id, (current) => {
        const member = current.members.find((m) => m.id === "202");
        if (member) member.active = false;
      });
      const before = calls.length;
      expect(
        (
          await personal(w, "202", "operate", {
            command: "observe",
            view: "screenshot",
          })
        ).status,
      ).toBe(403);
      expect(calls.length).toBe(before);
    });
    test("the actual Codex capability gateway shares owner control and resumes browser tools after secure input", async () => {
      const { w, run } = await seed("Implement dashboard login checks");
      const task = await store.change(w.id, async (current, sql) => {
        current.github = {
          revision: 1,
          installationId: 501,
          repositories: [
            {
              id: 7001,
              full_name: "example/workspace",
              default_branch: "develop",
              private: true,
            },
          ],
        };
        current.coding = {
          revision: 1,
          settings: {
            enabled: true,
            backend: "podman",
            authMode: "provider_key",
            development: developmentPolicy.parse({}),
          },
        };
        grantGitHubAccess(current, ["101", "202"]);
        const r = current.runs.find((item) => item.id === run.id);
        if (!r) throw Error("missing fixture run");
        r.status = "running";
        const sources = current.messages.filter(
          (source) => source.runId === r.id && source.role === "user",
        );
        const t = await startDevelopment(
          sql,
          current,
          r.id,
          "202",
          7001,
          sources.map((source) => source.id),
          "999",
        );
        t.state = "working";
        t.fence = 1;
        t.attemptId = randomUUID();
        await taskSave(sql, t);
        return t;
      });
      const bridge = await browser.coding?.capability(w.id, task.id);
      if (!bridge) throw Error("missing Codex browser capability");
      const restarted = new CodexBrowsers(
        store,
        new BrowserService(store, key, host),
        key,
        "https://changed-origin.example",
      );
      expect(await restarted.capability(w.id, task.id)).toEqual(bridge);
      const invoke = async (operation: unknown) => {
        const response = await createApp(
          store,
          setup,
          origin,
          plugins,
          undefined,
          key,
        ).request("/browser-api/codex", {
          method: "POST",
          headers: {
            authorization: `Bearer ${bridge.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(operation),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const waiting = await invoke({
        command: "invoke",
        callId: "codex-navigation",
        tool: "browser_action",
        input: { action: "navigate", url: "https://example.com/login" },
      });
      expect(waiting.status).toBe("waiting");
      const member = await (await personal(w, "202", "view")).json();
      expect(member.requests[0].consumer).toBe("codex");
      expect(member.requests[0].task).toBe(task.payload.title);
      await personal(w, "202", "decide", {
        id: waiting.requestId,
        approve: true,
      });
      await Promise.all([browser.reconcile(w.id), browser.reconcile(w.id)]);
      expect(
        (await invoke({ command: "poll", id: waiting.requestId })).status,
      ).toBe("completed");
      const worker = new DeliveryWorker(store, setup);
      const beforeNotice = telegramCalls.length;
      await worker.send(w.id, `browser:${waiting.requestId}:resumed`);
      await worker.send(w.id, `browser:${waiting.requestId}:resumed`);
      expect(telegramCalls.slice(beforeNotice)).toEqual([
        {
          method: "sendMessage",
          params: expect.objectContaining({
            chat_id: "202",
            message_thread_id: task.topicId,
            text: "Browser request completed. I’m continuing your task.",
          }),
        },
      ]);
      const input = await invoke({
        command: "invoke",
        callId: "codex-password",
        tool: "browser_action",
        input: {
          action: "request_input",
          selector: "#password",
          label: "Codex account password",
          kind: "password",
        },
      });
      expect(input.status).toBe("waiting");
      expect(
        (
          await personal(w, "202", "input", {
            id: input.requestId,
            submissionId: randomUUID(),
            value: "codex-private-input-fixture",
          })
        ).status,
      ).toBe(200);
      await Promise.all([browser.reconcile(w.id), browser.reconcile(w.id)]);
      expect(
        await invoke({ command: "poll", id: input.requestId }),
      ).toMatchObject({ status: "completed", inputApplied: true });
      expect(
        (await store.read(w.id)).deliveries.filter((d) => d.browserResume),
      ).toHaveLength(2);
      const inputNotice = (await store.read(w.id)).deliveries.find(
        (d) => d.id === `browser:${input.requestId}:resumed`,
      );
      expect(inputNotice).toMatchObject({
        topicId: task.topicId,
        browserResume: { id: input.requestId, taskId: task.id },
        browserRead: { owner: "202" },
      });
      expect(
        (
          await invoke({
            command: "invoke",
            callId: "codex-read",
            tool: "browser_action",
            input: { action: "read" },
          })
        ).text,
      ).toBe("private-account-balance-fixture");
      const saved = await taskGet(store.pool, w.id, task.id);
      expect(saved.id).toBe(task.id);
      expect(saved.browserRead?.owner).toBe("202");
      expect(saved.browserWait).toBeUndefined();
      expect(JSON.stringify(saved)).not.toContain(
        "codex-private-input-fixture",
      );
      const owned = calls.filter((call) => call.owner.workspaceId === w.id);
      expect(owned.some((call) => call.controller.kind === "codex")).toBe(true);
      expect(owned.every((call) => call.owner.actor === "202")).toBe(true);
      await store.change(w.id, async (_current, sql) => {
        const t = await taskGet(sql, w.id, task.id);
        t.cancelRequested = true;
        await taskSave(sql, t);
      });
      const before = calls.length;
      const beforeCancelledNotice = telegramCalls.length;
      await worker.send(w.id, `browser:${input.requestId}:resumed`);
      expect(telegramCalls.length).toBe(beforeCancelledNotice);
      expect(
        (await store.read(w.id)).deliveries.find(
          (d) => d.id === inputNotice?.id,
        )?.state,
      ).toBe("cancelled");
      await expect(
        browser.coding?.invoke(bridge.token, {
          command: "invoke",
          callId: "stale",
          tool: "browser_action",
          input: { action: "read" },
        }),
      ).rejects.toThrow();
      expect(calls.length).toBe(before);
    });
    test("a granted file plugin uses the same broker and resumes its original tool; revocation removes access", async () => {
      const { w, run } = await seed("Use my plugin browser");
      const directory = await mkdtemp(
          join(tmpdir(), "repodesk-browser-plugin-"),
        ),
        path = join(directory, "browser-helper.mjs");
      try {
        await writeFile(
          path,
          `export default function(pi) { pi.registerTool({name:"private_browser_helper",label:"Browser helper",description:"Use the private browser",parameters:{type:"object",properties:{action:{type:"string"},url:{type:"string"}},required:["action"],additionalProperties:false},execute:async(_call,args,_signal,_update,context)=>{if(!context.browser)throw Error("Browser was not granted");const result=await context.browser.action(args);return {content:[{type:"text",text:JSON.stringify(result)}],details:{}};}}); }`,
        );
        const entry = {
          id: "browser-helper",
          version: "1",
          path,
          workspaces: [w.id],
          tools: ["private_browser_helper"],
          enabled: true,
          execution: "read-only" as const,
          browserAccess: true,
        };
        await plugins.save(admin, w.id, { revision: 0, entries: [entry] });
        const stream = modelSequence([
          {
            name: "private_browser_helper",
            args: { action: "navigate", url: "https://example.com" },
          },
          { name: "private_browser_helper", args: { action: "read" } },
          "Private plugin browsing completed.",
        ]);
        const executor = new Executor(store, setup, (d, id) =>
          plugins.runner(d, id, stream),
        );
        await executor.execute(w.id, run.id);
        const paused = (await store.read(w.id)).runs.find(
          (r) => r.id === run.id,
        );
        expect(paused?.status).toBe("awaiting_approval");
        expect(paused?.browserWait?.toolName).toBe("private_browser_helper");
        if (!paused?.browserWait) throw Error("missing plugin browser wait");
        await browser.decide(
          { workspaceId: w.id, actor: "202" },
          paused.browserWait.id,
          true,
        );
        await browser.reconcile(w.id);
        expect(
          (await store.read(w.id)).deliveries.filter((d) => d.browserResume),
        ).toEqual([
          expect.objectContaining({
            runId: run.id,
            topicId: run.topicId,
            browserResume: { id: paused.browserWait.id },
          }),
        ]);
        await executor.execute(w.id, run.id);
        expect(
          (await store.read(w.id)).runs.find((r) => r.id === run.id)?.status,
        ).toBe("succeeded");
        expect(
          calls.some(
            (call) =>
              call.owner.workspaceId === w.id &&
              call.controller.kind === "plugin" &&
              call.controller.pluginId === "browser-helper",
          ),
        ).toBe(true);
        const waitingRun = await store.change(w.id, (current) =>
          createRun(
            current,
            "202",
            "Use the plugin again",
            "202",
            12,
            "gpt-4.1-mini",
            { botId: "999" },
          ),
        );
        const waitingExecutor = new Executor(store, setup, (d, id) =>
          plugins.runner(
            d,
            id,
            modelSequence([
              {
                name: "private_browser_helper",
                args: { action: "navigate", url: "https://other.example.com" },
              },
            ]),
          ),
        );
        await waitingExecutor.execute(w.id, waitingRun.id);
        expect(
          (await store.read(w.id)).runs.find((r) => r.id === waitingRun.id)
            ?.browserWait,
        ).toBeDefined();
        await plugins.save(admin, w.id, {
          revision: 1,
          entries: [{ ...entry, browserAccess: false }],
        });
        await browser.reconcile(w.id);
        const cancelled = (await store.read(w.id)).runs.find(
          (r) => r.id === waitingRun.id,
        );
        expect(cancelled?.status).toBe("partial");
        expect(cancelled?.browserWait).toBeUndefined();
        const before = calls.length;
        await expect(
          browser.fileTool(
            w.id,
            run.id,
            "202",
            2,
            0,
            entry.id,
            1,
            "private_browser_helper",
            "stale",
            "browser_action",
            { action: "read" },
          ),
        ).rejects.toThrow("browser_consumer_unavailable");
        expect(calls.length).toBe(before);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    test("explicit disable persists through other plugin edits without optional host calls", async () => {
      const { w } = await seed();
      const before = calls.length;
      expect((await browser.view(admin, w.id)).settings.enabled).toBe(true);
      await browser.configure(admin, w.id, {
        revision: 0,
        settings: { enabled: false },
      });
      await plugins.save(admin, w.id, { revision: 1, entries: [] });
      expect((await browser.view(admin, w.id)).settings.enabled).toBe(false);
      expect(calls.length).toBe(before);
    });
    test("password submission is owner-bound, applies once, and resumes the originating run without recording the value", async () => {
      const { w, run } = await seed("Fill the account password", 8);
      const stream = modelSequence([
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com/login" },
        },
        {
          name: "browser_action",
          args: {
            action: "request_input",
            selector: "#password",
            label: "Account password",
            kind: "password",
          },
        },
        "The requested field was filled.",
      ]);
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(d, id, stream),
      );
      await executor.execute(w.id, run.id);
      let current = (await store.read(w.id)).runs.find(
        (item) => item.id === run.id,
      );
      if (!current?.browserWait) throw Error("missing site wait");
      await browser.decide(
        { workspaceId: w.id, actor: "202" },
        current.browserWait.id,
        true,
      );
      await Promise.all([browser.reconcile(w.id), browser.reconcile(w.id)]);
      await new BrowserService(store, key, host).reconcile(w.id);
      await executor.execute(w.id, run.id);
      current = (await store.read(w.id)).runs.find(
        (item) => item.id === run.id,
      );
      expect(current?.browserWait?.kind).toBe("input");
      if (!current?.browserWait) throw Error("missing input wait");
      const id = current.browserWait.id,
        submission = randomUUID(),
        value = "secret-input-fixture-90210";
      await expect(
        browser.submitInput(
          { workspaceId: w.id, actor: "101" },
          id,
          submission,
          value,
        ),
      ).rejects.toThrow("browser_input_unavailable");
      await browser.submitInput(
        { workspaceId: w.id, actor: "202" },
        id,
        submission,
        value,
      );
      await browser.submitInput(
        { workspaceId: w.id, actor: "202" },
        id,
        submission,
        value,
      );
      expect(
        calls.filter(
          (call) =>
            call.owner.workspaceId === w.id &&
            call.operation.command === "input",
        ),
      ).toHaveLength(1);
      await browser.reconcile(w.id);
      await new BrowserService(store, key, host).reconcile(w.id);
      const inputNotice = (await store.read(w.id)).deliveries.filter(
        (d) => d.browserResume?.id === id,
      );
      expect(inputNotice).toHaveLength(1);
      expect(inputNotice[0]).toMatchObject({
        runId: run.id,
        topicId: 8,
        text: "Browser request completed. I’m continuing your task.",
      });
      await executor.execute(w.id, run.id);
      current = (await store.read(w.id)).runs.find(
        (item) => item.id === run.id,
      );
      expect(current?.status).toBe("succeeded");
      expect(current?.fence).toBe(3);
      expect(JSON.stringify(await store.read(w.id))).not.toContain(value);
      const profile = await new PostgresBrowserRepository(store.pool, key).read(
        { workspaceId: w.id, actor: "202" },
      );
      expect(JSON.stringify(profile)).not.toContain(value);
    });
    test("site-only consent grants resources without navigating the current page", async () => {
      const { w, run } = await seed();
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "request_site", url: "https://example.com" },
            },
          ]),
        ),
      );
      await executor.execute(w.id, run.id);
      const owner = { workspaceId: w.id, actor: "202" },
        repo = new PostgresBrowserRepository(store.pool, key);
      const request = (await repo.read(owner)).access?.requests[0];
      if (!request) throw Error("missing site request");
      expect(request.action).toBeUndefined();
      await browser.decide(owner, request.id, true);
      await browser.reconcile(w.id);
      expect(
        (await store.read(w.id)).runs.find((r) => r.id === run.id)?.status,
      ).toBe("queued");
      expect(
        (await repo.read(owner)).access?.sites.map((site) => site.origin),
      ).toEqual(["https://example.com"]);
      expect(
        calls.filter(
          (c) =>
            c.owner.workspaceId === w.id && c.operation.command === "action",
        ),
      ).toHaveLength(0);
    });
    test("an approved click cannot execute after its reviewed page changes", async () => {
      const { w, run } = await seed();
      const owner = { workspaceId: w.id, actor: "202" };
      const stream = modelSequence([
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com" },
        },
        {
          name: "browser_action",
          args: { action: "click", selector: "#submit" },
        },
      ]);
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(d, id, stream),
      );
      await executor.execute(w.id, run.id);
      const site = (await store.read(w.id)).runs.find(
        (r) => r.id === run.id,
      )?.browserWait;
      if (!site) throw Error("missing site wait");
      await browser.decide(owner, site.id, true);
      await browser.reconcile(w.id);
      await executor.execute(w.id, run.id);
      const action = (await store.read(w.id)).runs.find(
        (r) => r.id === run.id,
      )?.browserWait;
      expect(action?.kind).toBe("action");
      if (!action) throw Error("missing action wait");
      await browser.decide(owner, action.id, true);
      page.revision++;
      try {
        await browser.reconcile(w.id);
        await browser.reconcile(w.id);
      } finally {
        page.revision--;
      }
      const state = await new PostgresBrowserRepository(store.pool, key).read(
        owner,
      );
      expect(
        state.access?.requests.find((r) => r.id === action.id)?.result,
      ).toMatchObject({ status: "unavailable", code: "browser_page_changed" });
      expect(
        calls.filter(
          (c) =>
            c.owner.workspaceId === w.id &&
            c.operation.command === "action" &&
            c.operation.input.action === "click",
        ),
      ).toHaveLength(0);
      expect(
        (await store.read(w.id)).runs.find((r) => r.id === run.id)?.status,
      ).toBe("queued");
    });
    test("old input and completed receipts cannot block a new task for the same owner", async () => {
      const { w, run } = await seed();
      const owner = { workspaceId: w.id, actor: "202" },
        repo = new PostgresBrowserRepository(store.pool, key);
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(
          d,
          id,
          modelSequence([
            {
              name: "browser_action",
              args: { action: "request_site", url: "https://example.com" },
            },
          ]),
        ),
      );
      await executor.execute(w.id, run.id);
      await repo.change(owner, (state) => {
        const old = state.access?.requests[0];
        if (!old) throw Error("missing old request");
        old.state = "completed";
        old.result = { status: "completed" };
        old.resumePending = true;
        state.input = {
          id: randomUUID(),
          callId: old.operationId,
          controller: old.controller,
          generation: state.generation,
          origin: page.origin,
          pageId: page.id,
          pageRevision: page.revision,
          selector: "#password",
          label: "Password",
          kind: "password",
          expiresAt: Date.now() + 60000,
          state: "completed",
        };
      });
      const next = await store.change(w.id, (current) => {
        current.runs = current.runs.filter((r) => r.id !== run.id);
        return createRun(
          current,
          "202",
          "Use a new site",
          "202",
          9,
          "gpt-4.1-mini",
          { botId: "999" },
        );
      });
      await executor.execute(w.id, next.id);
      const saved = (await store.read(w.id)).runs.find((r) => r.id === next.id);
      if (!saved?.browserWait) throw Error("missing new wait");
      await browser.decide(owner, saved.browserWait.id, true);
      await browser.reconcile(w.id);
      const state = await repo.read(owner);
      expect(state.input).toBeUndefined();
      expect(state.access?.requests[0]?.resumePending).toBe(false);
      expect(
        (await store.read(w.id)).runs.find((r) => r.id === next.id)?.status,
      ).toBe("queued");
      expect(
        calls.filter(
          (c) =>
            c.owner.workspaceId === w.id && c.operation.command === "input",
        ),
      ).toHaveLength(0);
    });
    for (const change of [
      "cancelled",
      "membership revoked",
      "browser disabled",
      "waiting again",
      "finished",
    ] as const)
      test(`a delayed Browser continuation notice stays silent after the task is ${change}`, async () => {
        const { w, run } = await seed();
        const executor = new Executor(store, setup, (d, id) =>
          plugins.runner(
            d,
            id,
            modelSequence([
              {
                name: "browser_action",
                args: { action: "navigate", url: "https://example.com" },
              },
              ...(change === "waiting again"
                ? [
                    {
                      name: "browser_action",
                      args: {
                        action: "navigate",
                        url: "https://other.example",
                      },
                    },
                  ]
                : ["Finished."]),
            ]),
          ),
        );
        await executor.execute(w.id, run.id);
        const request = (await store.read(w.id)).runs[0]?.browserWait;
        if (!request) throw Error("missing browser wait");
        await browser.decide(
          { workspaceId: w.id, actor: "202" },
          request.id,
          true,
        );
        await browser.reconcile(w.id);
        const id = `browser:${request.id}:resumed`;
        expect(
          (await store.read(w.id)).deliveries.find((d) => d.id === id)?.state,
        ).toBe("pending");
        if (change === "waiting again" || change === "finished")
          await executor.execute(w.id, run.id);
        else
          await store.change(w.id, (current) => {
            if (change === "cancelled") {
              const r = current.runs.find((r) => r.id === run.id);
              if (!r) throw Error("missing run");
              r.cancelled = true;
              r.status = "cancelled";
            } else if (change === "membership revoked") {
              const member = current.members.find((m) => m.id === "202");
              if (!member) throw Error("missing member");
              member.active = false;
            } else
              current.plugins = {
                revision: 1,
                entries: [],
                browser: { enabled: false, generation: 1 },
              };
          });
        const before = telegramCalls.length;
        await new DeliveryWorker(store, setup).send(w.id, id);
        expect(telegramCalls.length).toBe(before);
        expect(
          (await store.read(w.id)).deliveries.find((d) => d.id === id)?.state,
        ).toBe("cancelled");
      });
    for (const ending of ["denied", "expired", "close", "delete"] as const)
      test(`a ${ending} browser wait terminates without replaying navigation`, async () => {
        const { w, run } = await seed();
        const owner = { workspaceId: w.id, actor: "202" },
          repo = new PostgresBrowserRepository(store.pool, key);
        const executor = new Executor(store, setup, (d, id) =>
          plugins.runner(
            d,
            id,
            modelSequence([
              {
                name: "browser_action",
                args: { action: "navigate", url: "https://example.com" },
              },
            ]),
          ),
        );
        await executor.execute(w.id, run.id);
        if (ending === "denied") {
          const request = (await store.read(w.id)).runs[0]?.browserWait;
          if (!request) throw Error("missing browser wait");
          expect(
            (
              await personal(w, "202", "decide", {
                id: request.id,
                approve: false,
              })
            ).status,
          ).toBe(200);
        } else if (ending === "expired")
          await repo.change(owner, (state) => {
            for (const request of state.access?.requests ?? [])
              request.expiresAt = 0;
          });
        else
          expect(
            (await personal(w, "202", "operate", { command: ending })).status,
          ).toBe(200);
        await browser.reconcile(w.id);
        await browser.reconcile(w.id);
        expect(
          (await store.read(w.id)).deliveries.filter((d) => d.browserResume),
        ).toHaveLength(0);
        const saved = (await store.read(w.id)).runs.find(
            (r) => r.id === run.id,
          ),
          state = await repo.read(owner);
        expect(saved?.status).toBe(
          ending === "delete" ? "cancelled" : "partial",
        );
        expect(
          calls.filter(
            (c) =>
              c.owner.workspaceId === w.id && c.operation.command === "action",
          ),
        ).toHaveLength(0);
        if (ending === "delete") {
          expect(state).toMatchObject({
            lifecycle: "deleted",
            epoch: 1,
            operations: [],
          });
          expect(state.access).toBeUndefined();
          expect(state.input).toBeUndefined();
          expect(state.receipts).toBeUndefined();
          expect(
            calls.filter(
              (c) =>
                c.owner.workspaceId === w.id &&
                c.operation.command === "delete",
            ),
          ).toHaveLength(1);
        } else expect(saved?.browserWait).toBeUndefined();
      });
    test("a reclaimed task with a durable browser wait pauses without replaying its tool", async () => {
      const { w, run } = await seed();
      const stream = modelSequence([
        {
          name: "browser_action",
          args: { action: "navigate", url: "https://example.com" },
        },
      ]);
      const executor = new Executor(store, setup, (d, id) =>
        plugins.runner(d, id, stream),
      );
      await executor.execute(w.id, run.id);
      await store.change(w.id, (current) => {
        const saved = current.runs.find((item) => item.id === run.id);
        if (saved) {
          saved.status = "running";
          saved.leaseUntil = new Date(0).toISOString();
          const wait = saved.browserWait;
          if (wait) {
            const receipt = saved.tools[wait.callId];
            if (!receipt) throw Error("missing browser receipt fixture");
            receipt.state = "started";
            saved.transcript = saved.transcript.filter(
              (message) =>
                !(
                  message &&
                  typeof message === "object" &&
                  "role" in message &&
                  message.role === "toolResult"
                ),
            );
          }
        }
      });
      await executor.execute(w.id, run.id);
      const saved = (await store.read(w.id)).runs.find(
        (item) => item.id === run.id,
      );
      expect(saved?.status).toBe("awaiting_approval");
      expect(saved?.fence).toBe(1);
      expect(saved?.browserWait).toBeDefined();
      expect(
        calls.some(
          (call) =>
            call.owner.workspaceId === w.id &&
            call.operation.command === "action",
        ),
      ).toBe(false);
      expect(
        await new PostgresBrowserRepository(store.pool, key).read({
          workspaceId: w.id,
          actor: "101",
        }),
      ).toMatchObject({ generation: 0, operations: [] });
    });
  },
);
