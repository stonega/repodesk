import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.ts";
import { askTask, saveExchange } from "../../src/coding/conversation-store.ts";
import { developmentPolicy } from "../../src/coding/development.ts";
import type { LocalRunner } from "../../src/coding/local/protocol.ts";
import { taskGet, taskSave } from "../../src/coding/task-store.ts";
import { startDevelopment } from "../../src/coding/tasks.ts";
import { captureRunnerStatus } from "../../src/coding/transcript-store.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { taskReference } from "../../src/miniapp/auth.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";
import { signedMiniAppData } from "../miniapp-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Telegram Mini App task history", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `miniapp_${randomUUID().replaceAll("-", "")}`;
  const operator = randomUUID(),
    key = "ab".repeat(32),
    token = "123456:fixture-bot-token";
  let store: Store;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const target = new URL(url as string);
    target.pathname = `/${name}`;
    store = new Store(database(target.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'mini','unused',true)",
      [operator],
    );
    const d = await store.deployment();
    d.bot = { id: "999", username: "fixture_bot", visibleAll: true };
    d.credentials.bot = encrypt(key, "bot", token);
    await store.saveDeployment(store.pool, d);
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function fixture(chatId = "101") {
    const w = workspace();
    w.operatorId = operator;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [
        {
          id: 7001,
          full_name: "example/workspace",
          default_branch: "main",
          private: false,
        },
      ],
    };
    w.coding = {
      revision: 1,
      settings: {
        enabled: true,
        backend: "podman",
        authMode: "provider_key",
        development: developmentPolicy.parse({}),
      },
    };
    grantGitHubAccess(w, ["101", "202"]);
    const run = createRun(
      w,
      "101",
      "Show the actual coding conversation",
      chatId,
      3,
      "gpt-4.1-mini",
      { replyTo: 10, botId: "999" },
    );
    run.status = "running";
    const source = w.messages.find(
      (s) => s.runId === run.id && s.role === "user",
    );
    if (!source) throw Error("fixture source");
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operator, JSON.stringify(w)],
    );
    const task = await store.change(w.id, (current, sql) =>
      startDevelopment(sql, current, run.id, "101", 7001, [source.id], "999"),
    );
    let membership = "member";
    const setup = new SetupService(store, key, "http://localhost:3000", () => ({
      async call<T>() {
        return { status: membership } as T;
      },
    }));
    const app = createApp(
      store,
      setup,
      "http://localhost:3000",
      undefined,
      undefined,
      key,
    );
    const request = (actor = 101, paging: Record<string, string> = {}) =>
      app.request("/mini-api/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initData: signedMiniAppData(token, actor),
          reference: taskReference(w.id, task.id),
          ...paging,
        }),
      });
    return {
      w,
      task,
      app,
      request,
      source,
      setMembership: (value: string) => {
        membership = value;
      },
    };
  }
  test("private history cannot be opened by another authorized workspace member; revocation clears access", async () => {
    const f = await fixture();
    const allowed = await f.request();
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect((await allowed.json()).items[0].text).toBe(
      "Show the actual coding conversation",
    );
    expect((await f.request(202)).status).toBe(403);
    await store.change(f.w.id, (w) => {
      const m = w.members.find((m) => m.id === "101");
      if (m) m.active = false;
    });
    expect((await f.request()).status).toBe(403);
  });
  test("group history checks current original-group membership and retained Topic sources", async () => {
    const f = await fixture("-100100");
    expect((await f.request(202)).status).toBe(200);
    f.setMembership("left");
    expect((await f.request(202)).status).toBe(403);
    f.setMembership("member");
    await store.change(f.w.id, (w) => {
      const s = w.messages.find((s) => s.id === f.source.id);
      if (s) s.topicId = 99;
    });
    expect((await f.request(202)).status).toBe(410);
  });
  test("expired or removed sources hide native history even before cleanup runs", async () => {
    const f = await fixture();
    await store.change(f.w.id, (w) => {
      const s = w.messages.find((s) => s.id === f.source.id);
      if (s) s.expiresAt = new Date(0).toISOString();
    });
    expect((await f.request()).status).toBe(410);
    await store.change(f.w.id, async (_w, sql) => {
      const t = await taskGet(sql, f.w.id, f.task.id);
      t.contentRemoved = true;
      await taskSave(sql, t);
    });
    expect((await f.request()).status).toBe(404);
  });
  test("deleted factual-question sources hide their retained answers before cleanup", async () => {
    const f = await fixture();
    await store.pool.query(
      "INSERT INTO coding_task_events(workspace_id,task_id,id,data) VALUES($1,$2,$3,$4)",
      [
        f.w.id,
        f.task.id,
        `conversation:message:${randomUUID()}`,
        JSON.stringify({
          sourceIds: ["deleted-question-source"],
          question: "Private question",
          answer: "Private answer",
          createdAt: new Date().toISOString(),
        }),
      ],
    );
    expect((await f.request()).status).toBe(410);
  });
  test("worker captures pages transactionally and deduplicates native items across retries; API pages and catches up", async () => {
    const f = await fixture();
    const attempt = randomUUID();
    const entries = Array.from({ length: 120 }, (_, i) => ({
      id: `thread:turn:${i}`,
      at: new Date(Date.now() + i * 1000).toISOString(),
      role: "codex" as const,
      text: `Actual Codex message ${i}`,
    }));
    const runner = {
      async status(_w: string, _t: string, offset = 0) {
        const page = entries.slice(offset, offset + 64);
        return {
          state: "ready" as const,
          transcript: {
            entries: page,
            offset: offset + page.length,
            hasMore: offset + page.length < entries.length,
          },
        };
      },
    } as LocalRunner;
    await captureRunnerStatus(store, runner, f.task, attempt);
    await captureRunnerStatus(store, runner, f.task, attempt);
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS n FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'transcript:item:%'",
          [f.w.id, f.task.id],
        )
      ).rows[0].n,
    ).toBe(120);
    const first = await (await f.request()).json();
    expect(first.items).toHaveLength(50);
    expect(first.recordingAvailable).toBe(true);
    expect(first.hasMore).toBe(true);
    const second = await (
      await f.request(101, { before: first.before })
    ).json();
    expect(second.items).toHaveLength(50);
    expect(second.items.at(-1).at <= first.items[0].at).toBe(true);
    const third = await (
      await f.request(101, { before: second.before })
    ).json();
    expect(third.items).toHaveLength(21);
    expect(third.hasMore).toBe(false);
    expect(
      (await (await f.request(101, { after: first.after })).json()).items,
    ).toHaveLength(0);
    entries.push({
      id: "thread:turn:late",
      at: entries[20]?.at ?? new Date().toISOString(),
      role: "codex",
      text: "Late captured message",
    });
    await captureRunnerStatus(store, runner, f.task, attempt);
    const catchup = await (await f.request(101, { after: first.after })).json();
    expect(catchup.items.map((item: { text: string }) => item.text)).toEqual([
      "Late captured message",
    ]);
    expect(
      (await (await f.request(101, { after: catchup.after })).json()).items,
    ).toHaveLength(0);
    expect((await f.request(101, { before: "invalid" })).status).toBe(400);
  });
  test("a completed factual answer is delivered after the question's original history cursor", async () => {
    const f = await fixture();
    const exchange = await store.change(f.w.id, async (w, sql) => {
      const run = createRun(
        w,
        "101",
        "Why this approach?",
        "101",
        3,
        "gpt-4.1-mini",
        { replyTo: 12, botId: "999" },
      );
      run.status = "running";
      return askTask(sql, w, f.task, run, randomUUID(), "Why this approach?");
    });
    const initial = await (await f.request()).json();
    await store.change(f.w.id, async (_w, sql) => {
      await saveExchange(sql, f.task, {
        ...exchange,
        state: "answered",
        answer: "It preserves ordered history.",
        answeredAt: new Date().toISOString(),
      });
    });
    const updated = await (
      await f.request(101, { after: initial.after })
    ).json();
    expect(updated.items.map((item: { text: string }) => item.text)).toEqual([
      "It preserves ordered history.",
    ]);
  });
  test("Mini App embedding policy is scoped to its page and tampered launch data is denied", async () => {
    const f = await fixture();
    const mini = await f.app.request("/mini");
    expect(mini.headers.get("content-security-policy")).toContain(
      "https://web.telegram.org",
    );
    expect(mini.headers.get("x-frame-options")).toBeNull();
    const admin = await f.app.request("/admin");
    expect(admin.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const denied = await f.app.request("/mini-api/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initData: signedMiniAppData(token).replace("101", "202"),
        reference: taskReference(f.w.id, f.task.id),
      }),
    });
    expect(denied.status).toBe(401);
  });
});
