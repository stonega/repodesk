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
import type { GitHubUsers } from "../../src/github/users.ts";
import type { GoogleService } from "../../src/google/service.ts";
import { deliverAccessHelp } from "../../src/jobs/control.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "Telegram controls through ordinary chat",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `chat_controls_${randomUUID().replaceAll("-", "")}`;
    const key = "ab".repeat(32);
    let store: Store, setup: SetupService, ingress: Ingress, w: Workspace;
    let sequence = 100,
      upstream: string[],
      sent: Record<string, unknown>[];
    const telegram = {
      async call<T>(_method: string, params = {}) {
        sent.push(params);
        return { message_id: ++sequence } as T;
      },
    } as Telegram;
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
      ingress = new Ingress(
        store,
        setup,
        {
          async begin(_sql, _w, actor, bot) {
            upstream.push(`github:${actor}:${bot}`);
            return "https://github.example.test/consent";
          },
        } as GitHubUsers,
        {
          async begin(_w, actor, bot, topic) {
            upstream.push(`google:${actor}:${bot}:${topic}`);
            return "https://google.example.test/consent";
          },
        } as GoogleService,
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    beforeEach(async () => {
      upstream = [];
      sent = [];
      w = workspace();
      w.github = {
        revision: 1,
        installationId: 7,
        repositories: [{ id: 1, full_name: "example/app", private: false }],
      };
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
        [w.operatorId, w.operatorId],
      );
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, w.operatorId, JSON.stringify(w)],
      );
      for (const actor of ["101", "202"])
        await store.pool.query(
          "INSERT INTO telegram_selections(actor,workspace_id) VALUES($1,$2) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
          [actor, w.id],
        );
      const d = await store.deployment();
      Object.assign(d, {
        active: true,
        paused: false,
        bot: { id: "999", username: "test_bot", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:fake"),
          model: encrypt(key, "model", "fake"),
        },
      });
      await store.saveDeployment(store.pool, d);
    });
    async function request(text: string, actor = 101, chatId = actor) {
      const id = ++sequence;
      const update = {
        update_id: id,
        message: {
          message_id: id,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: chatId,
            type:
              chatId === actor ? ("private" as const) : ("supergroup" as const),
          },
          from: { id: actor, is_bot: false },
          message_thread_id: 7,
          text,
        },
      };
      if (chatId !== actor) {
        await store.pool.query(
          "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id",
          [String(chatId), w.id],
        );
        Object.assign(update.message, {
          reply_to_message: { message_id: 1, from: { id: 999, is_bot: true } },
        });
      }
      await ingress.accept(update);
      expect(await ingress.accept(update)).toEqual({ duplicate: true });
      const run = (await store.read(w.id)).runs.at(-1);
      if (!run) throw Error("Missing run");
      return run;
    }
    async function tool(run: Run) {
      await store.change(w.id, (w) => {
        const r = w.runs.find((r) => r.id === run.id);
        if (r) {
          r.status = "running";
          r.fence = 1;
        }
      });
      const control = applicationTools(store, w.id, run.id, 1, ingress).find(
        (t) => t.name === "manage_telegram",
      );
      if (!control) throw Error("Missing control tool");
      return control;
    }
    test("ordinary repository request reaches Executor and delivers a working picker in the original Topic", async () => {
      const r = await request("Help me choose a repository");
      const runner: AgentRunner = {
        async run(input) {
          expect(input.system).toContain("Users never need slash commands");
          const control = input.tools.find((t) => t.name === "manage_telegram");
          if (!control) throw Error("Missing production tool");
          await control.execute("picker", {
            action: "repos",
            arguments: "app",
            requestQuote: r.task,
          });
          return {
            text: "Choose a repository above.",
            status: "succeeded",
            turns: 1,
            tools: 1,
            transcript: [],
          };
        },
      };
      await new Executor(store, setup, runner).execute(w.id, r.id);
      let current = await store.read(w.id);
      const picker = current.deliveries.find((d) => d.repositoryMenu);
      if (!picker) throw Error("Missing picker");
      expect(picker.topicId).toBe(7);
      expect(picker.text).not.toContain("/repos");
      expect(picker.buttons?.[0]?.[0]?.text).toBe("example/app");
      await new DeliveryWorker(store, setup).send(w.id, picker.id);
      current = await store.read(w.id);
      const delivered = current.deliveries.find((d) => d.id === picker.id);
      await ingress.accept({
        update_id: ++sequence,
        callback_query: {
          id: "pick",
          from: { id: 101, is_bot: false },
          data: picker.buttons?.[0]?.[0]?.callback_data,
          message: {
            message_id: delivered?.remoteId ?? 0,
            date: 1,
            chat: { id: 101, type: "private" },
            from: { id: 999, is_bot: true },
            message_thread_id: 7,
          },
        },
      });
      current = await store.read(w.id);
      expect(current.deliveries.at(-1)?.text).toContain("example/app");
      expect(current.runs).toHaveLength(1);
      expect(
        current.messages
          .filter((m) => m.role !== "assistant")
          .map((m) => m.text),
      ).toEqual([r.task]);
    });
    test("private GitHub and Google connections preserve the actor and Topic and deduplicate calls", async () => {
      for (const action of ["github", "google"]) {
        const r = await request(`Connect my ${action} account`);
        const control = await tool(r);
        const args = { action, arguments: "connect", requestQuote: r.task };
        await control.execute(action, args);
        await control.execute(action, args);
        await expect(
          control.execute(action, { ...args, arguments: "disconnect" }),
        ).rejects.toThrow("tool_call_conflict");
        const d = (await store.read(w.id)).deliveries.at(-1);
        expect(d?.topicId).toBe(7);
        expect(d?.chatId).toBe("101");
        expect(d?.text).not.toMatch(/(?:^|\s)\/(?:github|google)\b/);
      }
      expect(upstream).toEqual(["github:101:999", "google:101:999:7"]);
    });
    test("account connections are denied in groups before contacting providers", async () => {
      const r = await request("Connect my Google account", 101, -100100);
      const control = await tool(r);
      for (const action of ["github", "google"])
        await expect(
          control.execute(action, {
            action,
            arguments: "connect",
            requestQuote: r.task,
          }),
        ).rejects.toThrow("use_private_chat");
      expect(upstream).toEqual([]);
    });
    test("members cannot change administrator settings and forwarded or stale requests cannot act", async () => {
      const r = await request("Change the timezone to UTC", 202);
      const control = await tool(r);
      const args = {
        action: "timezone",
        arguments: "UTC",
        requestQuote: r.task,
      };
      await expect(control.execute("timezone", args)).rejects.toThrow(
        "access_denied",
      );
      await expect(
        control.execute("quote", {
          ...args,
          requestQuote: "a request from history",
        }),
      ).rejects.toThrow("chat_request_unverified");
      for (const field of [
        "forwarded",
        "expired",
        "scheduled",
        "pending",
        "revoked",
      ]) {
        await store.change(w.id, (w) => {
          const source = w.messages.find((m) => m.author === "202");
          const run = w.runs.find((run) => run.id === r.id);
          if (!source || !run) throw Error("Missing source/run");
          source.forwarded = field === "forwarded";
          source.expiresAt = new Date(
            field === "expired" ? 0 : Date.now() + 60000,
          ).toISOString();
          run.workflowId = field === "scheduled" ? "workflow" : undefined;
          run.pendingInputs =
            field === "pending"
              ? [
                  {
                    sourceId: source.id,
                    task: "new input",
                    messageId: r.replyTo ?? 1,
                  },
                ]
              : [];
          const member = w.members.find((m) => m.id === "202");
          if (member) member.active = field !== "revoked";
        });
        await expect(
          control.execute(field, {
            action: "google",
            arguments: "connect",
            requestQuote: r.task,
          }),
        ).rejects.toThrow();
      }
      expect(upstream).toEqual([]);
    });
    test("multiple workspace memberships offer buttons before any chat selection", async () => {
      const other = workspace();
      other.operatorId = w.operatorId;
      other.settings.name = "Other team";
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [other.id, other.operatorId, JSON.stringify(other)],
      );
      await store.pool.query(
        "DELETE FROM telegram_selections WHERE actor='101'",
      );
      await ingress.accept({
        update_id: ++sequence,
        message: {
          message_id: sequence,
          date: 1,
          chat: { id: 101, type: "private" },
          from: { id: 101, is_bot: false },
          text: "Hello",
          message_thread_id: 7,
        },
      });
      await deliverAccessHelp(store, setup);
      const markup = sent.at(-1)?.reply_markup as {
        inline_keyboard: { text: string; callback_data: string }[][];
      };
      expect(
        markup.inline_keyboard
          .flat()
          .some((b) => b.callback_data === `workspace:${other.id}`),
      ).toBe(true);
      await ingress.accept({
        update_id: ++sequence,
        callback_query: {
          id: "workspace",
          from: { id: 101, is_bot: false },
          data: `workspace:${other.id}`,
          message: {
            message_id: sequence,
            date: 1,
            chat: { id: 101, type: "private" },
            message_thread_id: 7,
          },
        },
      });
      expect(
        (
          await store.pool.query(
            "SELECT workspace_id FROM telegram_selections WHERE actor='101'",
          )
        ).rows[0]?.workspace_id,
      ).toBe(other.id);
      expect((await store.read(other.id)).deliveries.at(-1)).toMatchObject({
        topicId: 7,
        text: "Selected Other team. Tell me what you want to do.",
      });
      await expect(
        ingress.accept({
          update_id: ++sequence,
          callback_query: {
            id: "forged-workspace",
            from: { id: 9999, is_bot: false },
            data: `workspace:${other.id}`,
            message: {
              message_id: sequence,
              date: 1,
              chat: { id: 9999, type: "private" },
            },
          },
        }),
      ).rejects.toThrow("access_denied");
      expect(
        (
          await store.pool.query(
            "SELECT workspace_id FROM telegram_selections WHERE actor='9999'",
          )
        ).rows,
      ).toHaveLength(0);
    });
    test("instruction/deletion requests retain approval and group invitations require no typed commands", async () => {
      const r = await request(
        "Remember to put blockers first, help me link a group, and propose deleting the workspace",
      );
      const control = await tool(r);
      await control.execute("instruction", {
        action: "remember",
        arguments: "Put blockers first",
        requestQuote: r.task,
      });
      let current = await store.read(w.id);
      expect(current.approvals.at(-1)?.kind).toBe("instruction");
      expect(current.approvals.at(-1)?.decision).toBeUndefined();
      expect(
        current.instructions.some(
          (i) => i.active && i.body === "Put blockers first",
        ),
      ).toBe(false);
      await control.execute("link", {
        action: "linktoken",
        requestQuote: r.task,
      });
      current = await store.read(w.id);
      expect(current.deliveries.at(-1)?.text).toContain(
        "https://t.me/test_bot?startgroup=link_",
      );
      expect(current.deliveries.at(-1)?.text).not.toContain("/link ");
      await control.execute("privacy", {
        action: "privacy",
        arguments: "delete",
        requestQuote: r.task,
      });
      current = await store.read(w.id);
      expect(current.approvals.at(-1)?.kind).toBe("deletion");
      expect(current.deletion).toBeUndefined();
    });
    test("plain Stop cancels an active request without another model run", async () => {
      const r = await request("Work on this task");
      await tool(r);
      await ingress.accept({
        update_id: ++sequence,
        message: {
          message_id: sequence,
          date: 1,
          chat: { id: 101, type: "private" },
          from: { id: 101, is_bot: false },
          message_thread_id: 7,
          text: "Please stop",
        },
      });
      const current = await store.read(w.id);
      expect(current.runs).toHaveLength(1);
      expect(current.runs[0]?.cancelled).toBe(true);
      expect(current.runs[0]?.pendingInputs ?? []).toHaveLength(0);
    });
    test("status and cancellation target previous work rather than the control's own run", async () => {
      let target = "";
      await store.change(w.id, (w) => {
        target = createRun(
          w,
          "101",
          "Previous work",
          "101",
          7,
          "gpt-4.1-mini",
          { botId: "999", replyTo: 1 },
        ).id;
      });
      const r = await request("Stop the previous task");
      const control = await tool(r);
      await control.execute("stop", { action: "cancel", requestQuote: r.task });
      const current = await store.read(w.id);
      expect(current.runs.find((r) => r.id === target)?.cancelled).toBe(true);
      expect(current.runs.find((run) => run.id === r.id)?.cancelled).not.toBe(
        true,
      );
    });
  },
);
