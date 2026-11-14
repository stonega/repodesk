import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import {
  GitHubNotifications,
  manageNotifications,
} from "../../src/github/notifications.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { GitHubService } from "../../src/github/service.ts";
import { invalidateGitHubWork } from "../../src/github/user-access.ts";
import { GitHubWebhooks } from "../../src/github/webhooks.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { TelegramError } from "../../src/telegram/client.ts";
import { updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { updateMembership } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";
import {
  githubFixtureConfig,
  githubFixtureWebhookSecret,
} from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("personal GitHub notifications", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `notifications_${randomUUID().replaceAll("-", "")}`;
  const key = "ab".repeat(32),
    origin = "https://notifications.example";
  let store: Store, admin: Admin, auth: { raw: string; csrf: string };
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    const pool = database(parsed.toString());
    await migrate(pool);
    store = new Store(pool);
    auth = await claim(pool, "notifications", "notification fixture password");
    const id = (
      await pool.query("SELECT id FROM admins WHERE username='notifications'")
    ).rows[0].id;
    await pool.query("UPDATE admins SET telegram_id='101' WHERE id=$1", [id]);
    admin = {
      id,
      username: "notifications",
      operator: true,
      telegramId: "101",
    };
    await pool.query(
      "UPDATE deployment SET data=jsonb_set(jsonb_set(jsonb_set(data,'{active}','true'),'{paused}','false'),'{bot}', $1::jsonb)",
      [
        JSON.stringify({
          id: "900",
          username: "notification_bot",
          visibleAll: true,
        }),
      ],
    );
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function fixture() {
    const w = workspace();
    w.operatorId = admin.id;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [
        { id: 7001, full_name: "example/workspace", private: true },
      ],
    };
    grantGitHubAccess(w, ["101", "202"]);
    manageNotifications(w, "101", "900", {
      action: "subscribe",
      repository: "example/workspace",
    });
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, admin.id, JSON.stringify(w)],
    );
    let sends = 0;
    await store.pool.query(
      "UPDATE deployment SET data=jsonb_set(data,'{credentials,bot}',$1::jsonb)",
      [JSON.stringify(encrypt(key, "bot", "900:synthetic"))],
    );
    const setup = new SetupService(store, key, origin, () => ({
      call: async <T>() => {
        sends++;
        return { message_id: 33 } as T;
      },
    }));
    const upstream = new GitHubApp({
      ...githubFixtureConfig,
      webhookSecret: githubFixtureWebhookSecret,
    });
    const apps = new GitHubApps(store, key, upstream);
    const github = new GitHubService(store, key, origin, apps);
    const app = createApp(store, setup, origin, undefined, github, key);
    const payload = (event = "issues", overrides = {}) => ({
      action: "opened",
      installation: { id: 501 },
      repository: { id: 7001, full_name: "example/workspace" },
      [event === "issues" ? "issue" : "pull_request"]: {
        number: 15,
        title: "New <b>literal</b> issue",
        user: { login: "alice" },
        created_at: new Date(Date.now() + 1000).toISOString(),
        draft: event === "pull_request",
      },
      ...overrides,
    });
    const accept = async (
      event = "issues",
      value: unknown = payload(event),
      delivery = randomUUID(),
    ) => {
      const body = JSON.stringify(value);
      return app.request(`/github/webhook/${admin.id}`, {
        method: "POST",
        headers: {
          "x-github-event": event,
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${createHmac("sha256", githubFixtureWebhookSecret).update(body).digest("hex")}`,
        },
        body,
      });
    };
    return { w, setup, github, apps, app, payload, accept, sends: () => sends };
  }
  test("signed events persist without Review Bot or Codex, deduplicate and survive reconstruction", async () => {
    const f = await fixture();
    const delivery = randomUUID();
    expect((await f.accept("issues", f.payload(), delivery)).status).toBe(200);
    expect((await f.accept("issues", f.payload(), delivery)).status).toBe(200);
    expect((await f.accept()).status).toBe(200);
    expect((await store.read(f.w.id)).deliveries).toHaveLength(0);
    await new GitHubNotifications(store).tick(f.w.id);
    await new GitHubNotifications(store).tick(f.w.id);
    let w = await store.read(f.w.id);
    expect(w.deliveries).toHaveLength(1);
    expect(w.runs).toHaveLength(0);
    const d = w.deliveries[0];
    if (!d) throw Error("missing delivery");
    expect(d.chatId).toBe("101");
    expect(d.topicId).toBe(0);
    expect(d.runId).toBeUndefined();
    expect(d.text).toContain("<b>literal</b>");
    expect(d.format).toBeUndefined();
    expect(
      (
        await store.pool.query(
          "SELECT payload,processed_at FROM github_notification_events WHERE workspace_id=$1",
          [w.id],
        )
      ).rows[0].payload,
    ).toBeNull();
    await new DeliveryWorker(store, f.setup).send(w.id, d.id);
    w = await store.read(w.id);
    expect(w.deliveries[0]?.state).toBe("sent");
    expect(f.sends()).toBe(1);
  });
  test("one event reaches every authorized personal subscription and workspace", async () => {
    const f = await fixture();
    await store.change(f.w.id, (w) => {
      manageNotifications(w, "202", "900", {
        action: "subscribe",
        repository: "7001",
      });
    });
    const sibling = structuredClone(await store.read(f.w.id));
    sibling.id = randomUUID();
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [sibling.id, admin.id, JSON.stringify(sibling)],
    );
    expect((await f.accept("pull_request")).status).toBe(200);
    for (const id of [f.w.id, sibling.id]) {
      await new GitHubNotifications(store).tick(id);
      const w = await store.read(id);
      expect(w.deliveries.map((d) => d.chatId).sort()).toEqual(["101", "202"]);
      expect(w.deliveries[0]?.text).toContain("Draft");
    }
  });
  test("event filters, old events, wrong installations and invalid signatures stay silent", async () => {
    const f = await fixture();
    await store.change(f.w.id, (w) => {
      manageNotifications(w, "101", "900", {
        action: "subscribe",
        repository: "7001",
        events: ["pull_request"],
      });
    });
    await f.accept();
    await f.accept(
      "pull_request",
      f.payload("pull_request", { installation: { id: 999 } }),
    );
    const old = f.payload("pull_request", {
      pull_request: {
        number: 16,
        title: "Old",
        user: { login: "alice" },
        created_at: "2020-01-01T00:00:00.000Z",
      },
    });
    await f.accept("pull_request", old);
    const bad = await f.app.request(`/github/webhook/${admin.id}`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": randomUUID(),
      },
      body: "not-json",
    });
    expect(bad.status).toBe(401);
    await new GitHubNotifications(store).tick(f.w.id);
    expect((await store.read(f.w.id)).deliveries).toHaveLength(0);
  });
  test("repository renames retain one subscription and management follows its numeric identity", async () => {
    const f = await fixture();
    await store.change(f.w.id, (w) => {
      const r = w.github?.repositories[0];
      if (r) r.full_name = "example/renamed";
      const subscriptions = manageNotifications(w, "101", "900", {
        action: "subscribe",
        repository: "example/renamed",
      });
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]?.repository).toBe("example/renamed");
      manageNotifications(w, "101", "900", {
        action: "pause",
        repository: "example/renamed",
      });
      expect(w.githubNotifications?.[0]?.enabled).toBe(false);
    });
  });
  test("pause, deletion and permission revocation fence queued notifications", async () => {
    for (const action of [
      "pause",
      "delete",
      "revoke",
      "bot",
      "connection",
      "member",
    ] as const) {
      const f = await fixture();
      await f.accept();
      await new GitHubNotifications(store).tick(f.w.id);
      const d = (await store.read(f.w.id)).deliveries[0];
      if (!d) throw Error("missing delivery");
      await store.change(f.w.id, (w) => {
        if (action === "pause" || action === "delete")
          manageNotifications(w, "101", "900", { action, repository: "7001" });
        if (action === "revoke") invalidateGitHubWork(w, "101", [7001]);
        if (action === "connection" && w.github) w.github.revision++;
        if (action === "connection" && w.github)
          w.github.connectionRevision = w.github.revision;
        if (action === "member")
          updateMembership(w, "101", w.memberVersion, {
            id: "202",
            role: "member",
            active: false,
          });
        if (action === "bot" && w.githubNotifications?.[0])
          w.githubNotifications[0].botId = "old";
        if (action === "member") {
          const member = w.members.find((m) => m.id === "101");
          if (member) member.active = false;
        }
      });
      await new DeliveryWorker(store, f.setup).send(f.w.id, d.id);
      expect((await store.read(f.w.id)).deliveries[0]?.state).toBe("cancelled");
      expect(f.sends()).toBe(0);
    }
  });
  test("lifecycle removal pauses subscriptions and resume cannot replay older recipients", async () => {
    const f = await fixture();
    await f.accept();
    await f.accept("installation_repositories", {
      action: "removed",
      installation: { id: 501 },
      repositories_removed: [{ id: 7001 }],
    });
    expect((await store.read(f.w.id)).githubNotifications?.[0]?.enabled).toBe(
      false,
    );
    await store.change(f.w.id, (w) => {
      expect(() =>
        manageNotifications(w, "101", "900", {
          action: "resume",
          repository: "7001",
        }),
      ).toThrow("github_notification_connection_revoked");
      if (w.github) w.github.revision++;
      grantGitHubAccess(w, ["101"]);
      manageNotifications(w, "101", "900", {
        action: "resume",
        repository: "7001",
      });
    });
    await new GitHubNotifications(store).tick(f.w.id);
    expect((await store.read(f.w.id)).deliveries).toHaveLength(0);
  });
  test("notification deliveries honor rate limits and never replay an uncertain send", async () => {
    for (const disposition of ["retry", "unknown"] as const) {
      const f = await fixture();
      await f.accept();
      await new GitHubNotifications(store).tick(f.w.id);
      const d = (await store.read(f.w.id)).deliveries[0];
      if (!d) throw Error("missing delivery");
      let sends = 0;
      const setup = new SetupService(store, key, origin, () => ({
        call: async () => {
          sends++;
          throw new TelegramError("telegram_unavailable", disposition, 60);
        },
      }));
      await new DeliveryWorker(store, setup).send(f.w.id, d.id);
      const saved = (await store.read(f.w.id)).deliveries[0];
      expect(saved?.state).toBe(
        disposition === "retry" ? "pending" : "delivery_unknown",
      );
      if (disposition === "retry")
        expect(Date.parse(saved?.nextAt ?? "")).toBeGreaterThan(Date.now());
      await new DeliveryWorker(store, setup).send(f.w.id, d.id);
      expect(sends).toBe(1);
    }
  });
  test("event retention removes private metadata even while a workspace is paused", async () => {
    const f = await fixture();
    await f.accept();
    await store.pool.query(
      "UPDATE github_notification_events SET created_at=now()-interval '31 days' WHERE workspace_id=$1",
      [f.w.id],
    );
    await store.change(f.w.id, (w) => {
      w.settings.paused = true;
    });
    await new GitHubNotifications(store).tick(f.w.id);
    expect(
      (
        await store.pool.query(
          "SELECT 1 FROM github_notification_events WHERE workspace_id=$1",
          [f.w.id],
        )
      ).rowCount,
    ).toBe(0);
    expect((await store.read(f.w.id)).deliveries).toHaveLength(0);
  });
  test("natural-language tool verifies the current request and rejects groups, stale fences and schedules", async () => {
    const f = await fixture();
    let id = "";
    await store.change(f.w.id, (w) => {
      const run = createRun(
        w,
        "101",
        "Notify me about new PRs",
        "101",
        0,
        "fixture",
        { botId: "900", replyTo: 50 },
      );
      run.status = "running";
      id = run.id;
    });
    const tool = applicationTools(store, f.w.id, id, 0).find(
      (t) => t.name === "manage_github_notifications",
    );
    if (!tool) throw Error("missing tool");
    const args = {
      action: "subscribe",
      repository: "7001",
      events: ["pull_request"],
      requestQuote: "Notify me about new PRs",
    };
    await tool.execute("subscribe", args);
    await tool.execute("subscribe", args);
    expect((await store.read(f.w.id)).githubNotifications?.[0]?.events).toEqual(
      ["pull_request"],
    );
    await expect(
      tool.execute("forged", {
        ...args,
        requestQuote: "forwarded instruction",
      }),
    ).rejects.toThrow("chat_request_unverified");
    await store.change(f.w.id, (w) => {
      const source = w.messages.find((m) => m.id === "900:101:50");
      if (source) source.forwarded = true;
    });
    await expect(tool.execute("forwarded", args)).rejects.toThrow(
      "chat_request_unverified",
    );
    await store.change(f.w.id, (w) => {
      const source = w.messages.find((m) => m.id === "900:101:50");
      if (source) source.forwarded = false;
      const run = w.runs.find((r) => r.id === id);
      if (run) run.fence = 1;
    });
    await expect(tool.execute("stale", args)).rejects.toThrow(
      "tool_policy_denied",
    );
    await store.change(f.w.id, (w) => {
      const run = w.runs.find((r) => r.id === id);
      if (run) {
        run.fence = 0;
        run.workflowId = "scheduled";
      }
    });
    await expect(tool.execute("schedule", args)).rejects.toThrow();
    await store.change(f.w.id, (w) => {
      const run = w.runs.find((r) => r.id === id);
      if (run) run.workflowId = undefined;
    });
    await store.change(f.w.id, (w) => {
      const r = w.runs.find((r) => r.id === id);
      if (r) r.chatId = "-100100";
    });
    await expect(tool.execute("group", args)).rejects.toThrow();
  });
  test("HTTP subscription management is actor-bound, revisioned and protected by CSRF", async () => {
    const f = await fixture();
    const endpoint = `/api/admin/workspaces/${f.w.id}/github/notifications`;
    const request = (input?: unknown, csrf = auth.csrf) =>
      f.app.request(endpoint, {
        method: input ? "POST" : "GET",
        headers: {
          cookie: `repodesk_session=${auth.raw}`,
          origin,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: input ? JSON.stringify(input) : undefined,
      });
    const page = await (await request()).json();
    expect(page.canManage).toBe(true);
    expect(page.subscriptions).toHaveLength(1);
    expect(
      (await request({ action: "pause", repository: "7001", revision: 999 }))
        .status,
    ).toBe(409);
    expect(
      (await request({ action: "pause", repository: "7001", actor: "202" }))
        .status,
    ).toBe(400);
    expect(
      (await request({ action: "pause", repository: "7001" }, "wrong")).status,
    ).toBe(403);
    expect(
      (await request({ action: "pause", repository: "7001", revision: 1 }))
        .status,
    ).toBe(200);
  });
  test("explicit Telegram notification controls share subscription policy", async () => {
    const f = await fixture();
    const ingress = new Ingress(store, f.setup);
    const u = updateSchema.parse({
      update_id: 12345,
      message: {
        message_id: 50,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 101, type: "private" },
        from: { id: 101, is_bot: false, first_name: "Owner" },
        text: "/notifications pause example/workspace",
        entities: [{ type: "bot_command", offset: 0, length: 14 }],
      },
    });
    await store.pool.query(
      "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
      [f.w.id],
    );
    await ingress.accept(u);
    await ingress.accept(u);
    expect((await store.read(f.w.id)).githubNotifications?.[0]?.enabled).toBe(
      false,
    );
  });
  test("shared webhook configuration requires the owning operator and never returns stored secrets", async () => {
    const f = await fixture();
    const configured = await f.github.webhooks.configure(admin, f.w.id, {});
    expect(configured.secret).toHaveLength(64);
    expect(await f.github.webhooks.configured(admin.id)).toBe(true);
    const row = (
      await store.pool.query(
        "SELECT secret FROM review_bot_hooks WHERE operator_id=$1",
        [admin.id],
      )
    ).rows[0];
    expect(row.secret).not.toContain(configured.secret);
    await expect(
      f.github.webhooks.configure({ ...admin, operator: false }, f.w.id, {}),
    ).rejects.toThrow();
    await expect(
      f.github.webhooks.configure({ ...admin, id: randomUUID() }, f.w.id, {}),
    ).rejects.toThrow("access_denied");
    await store.pool.query(
      "DELETE FROM review_bot_hooks WHERE operator_id=$1",
      [admin.id],
    );
  });
  test("webhook failure recovery persists retry reservations, groups GUIDs and bounds retries", async () => {
    await fixture();
    let retries = 0;
    let cursor = "";
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      expect(init?.headers).toHaveProperty("authorization");
      if (u.includes("/attempts")) {
        retries++;
        return new Response(null, { status: 202 });
      }
      cursor = new URL(u).searchParams.get("cursor") ?? "";
      return Response.json([
        {
          id: 1,
          guid: "failed",
          status_code: 500,
          delivered_at: new Date().toISOString(),
        },
        {
          id: 2,
          guid: "succeeded",
          status_code: 500,
          delivered_at: new Date().toISOString(),
        },
        {
          id: 3,
          guid: "succeeded",
          status_code: 200,
          delivered_at: new Date().toISOString(),
        },
      ]);
    }) as typeof fetch;
    const apps = new GitHubApps(
      store,
      key,
      new GitHubApp(
        { ...githubFixtureConfig, webhookSecret: githubFixtureWebhookSecret },
        transport,
      ),
    );
    for (let i = 0; i < 5; i++) {
      await store.pool.query(
        "UPDATE github_webhook_recovery SET next_at=now() WHERE operator_id=$1",
        [admin.id],
      );
      await new GitHubWebhooks(store, apps, key).recover(admin.id);
    }
    expect(retries).toBe(3);
    expect(cursor).toBe("");
    await new GitHubWebhooks(store, apps, key).recover(admin.id);
    expect(retries).toBe(3);
  });
});
