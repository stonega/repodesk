import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { createApp } from "../../src/app.ts";
import { askTask } from "../../src/coding/conversation-store.ts";
import type {
  DevelopmentResult,
  DevelopmentTask,
} from "../../src/coding/development.ts";
import { DevelopmentExecutor } from "../../src/coding/executor.ts";
import type {
  LocalRunner,
  LocalStart,
  LocalStatus,
} from "../../src/coding/local/protocol.ts";
import { codingTaskContext } from "../../src/coding/task-context.ts";
import { taskGet, taskInputs, taskSave } from "../../src/coding/task-store.ts";
import { pruneDevelopment, startDevelopment } from "../../src/coding/tasks.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { type Admin, Fault, type Workspace } from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { taskReference } from "../../src/miniapp/auth.ts";
import { miniAppRoutes } from "../../src/miniapp/history.ts";
import { sweep } from "../../src/privacy/service.ts";
import { ReviewExecutor } from "../../src/review-bot/executor.ts";
import { ReviewService } from "../../src/review-bot/service.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";
import { signedMiniAppData } from "../miniapp-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
const secret = "review-fixture-webhook-secret-32-characters";
const head = "a".repeat(40),
  base = "b".repeat(40),
  published = "c".repeat(40);
const analysis: DevelopmentResult = {
  status: "analysis",
  intent: "analyze",
  evidenceRevision: 1,
  evidence: "Review this pull request.",
  publishRequested: false,
  summary: "A missing permission check allows unauthorized updates.",
  question: null,
  title: "Review",
  body: "",
  verificationCommands: [],
  reviewFindings: [
    {
      path: "src/api.ts",
      line: 1,
      side: "RIGHT",
      severity: "high",
      body: "Check the actor before applying the update.",
    },
  ],
};
class Runner implements LocalRunner {
  starts: LocalStart[] = [];
  states = new Map<string, LocalStatus>();
  pushes: string[] = [];
  cancels: string[] = [];
  erased: string[] = [];
  loseStart = false;
  available = true;
  nextPublishedSha = published;
  async start(input: LocalStart) {
    if (this.states.has(input.taskId)) return;
    this.starts.push(structuredClone(input));
    this.states.set(input.taskId, { state: "running" });
    if (this.loseStart) {
      this.loseStart = false;
      throw new Fault("coding_runner_unavailable", 503);
    }
  }
  async status(_w: string, id: string) {
    const status = this.states.get(id);
    if (!status) throw new Fault("coding_task_not_found", 404);
    return status;
  }
  async publish(_w: string, id: string, token: string) {
    this.pushes.push(id);
    expect(token).toBe("ghs_fixture_installation_secret");
    const input = this.starts.find((s) => s.taskId === id);
    if (!input?.development) throw Error("Missing development task");
    this.states.set(id, {
      state: "succeeded",
      result: {
        ...analysis,
        status: "completed",
        intent: "implement",
        verificationCommands: ["bun test"],
      },
      checkPassed: true,
      publishedSha: this.nextPublishedSha,
      prUrl:
        input.development.pr?.url ??
        "https://github.com/example/workspace/pull/23",
    });
  }
  async cancel(_w: string, id: string) {
    if (!this.available) throw new Fault("coding_runner_unavailable", 503);
    this.cancels.push(id);
    this.states.set(id, { state: "cancelled" });
  }
  async erase(_w: string, id: string) {
    this.erased.push(id);
  }
}
(url ? describe : describe.skip)("Review Bot", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const dbName = `review_${randomUUID().replaceAll("-", "")}`;
  let store: Store;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${dbName}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${dbName}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "UPDATE deployment SET data=jsonb_set(data,'{active}','true')",
    );
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  async function fixture() {
    const operatorId = randomUUID();
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
      [operatorId, `rb-${operatorId}`],
    );
    const admin: Admin = { id: operatorId, username: "review", operator: true };
    const w = workspace();
    w.operatorId = operatorId;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [
        { id: 7001, full_name: "example/workspace", default_branch: "main" },
      ],
    };
    const member = w.members.find((m) => m.id === "101");
    if (!member) throw Error("Missing member");
    member.github = {
      id: 42,
      login: "fixture-user",
      status: "connected",
      connectionRevision: 1,
      syncedAt: new Date().toISOString(),
      repositories: [
        {
          id: 7001,
          full_name: "example/workspace",
          permissions: { pull: true, push: true, admin: false },
        },
      ],
    };
    w.coding = {
      revision: 1,
      settings: {
        enabled: true,
        backend: "podman",
        authMode: "provider_key",
        development: { publishByDefault: true },
      },
    };
    w.reviewBot = {
      revision: 1,
      settings: {
        enabled: true,
        autoReview: true,
        acceptRequests: true,
        allowFixes: true,
      },
    };
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, w.operatorId, JSON.stringify(w)],
    );
    const pull = {
      number: 23,
      state: "open",
      merged: false,
      draft: false,
      title: "Improve API",
      body: "PR reference only",
      head: {
        sha: head,
        ref: "feature/api",
        repo: { full_name: "example/workspace" },
      },
      base: { sha: base, ref: "main" },
    };
    const comments = new Map<
      number,
      {
        id: number;
        body: string;
        user: { id: number; type: string; login: string };
        pull_request_url?: string;
        issue_url?: string;
        in_reply_to_id?: number;
        path?: string;
        line?: number;
      }
    >();
    const reviews: {
      id: number;
      body: string;
      user: { type: string; login: string };
    }[] = [];
    const writes: { url: string; method: string; body: unknown }[] = [];
    const permissions: unknown[] = [];
    let loseReview = false,
      loseProgress = false,
      sourceAvailable = true;
    let onSourceRead: (() => Promise<void>) | undefined;
    const transport = (async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const address = String(input),
        path = new URL(address).pathname;
      if (path.endsWith("/access_tokens"))
        permissions.push(JSON.parse(String(init.body)).permissions);
      const data = init.body ? JSON.parse(String(init.body)) : undefined;
      if (
        address.startsWith("https://api.github.com/repos/example/workspace/")
      ) {
        if (init.method === "POST" && path.endsWith("/reviews")) {
          writes.push({ url: address, method: "POST", body: data });
          const r = {
            commit_id: data.commit_id,
            id: reviews.length + 1,
            body: data.body,
            user: { type: "Bot", login: "deepx-fixture[bot]" },
          };
          reviews.push(r);
          if (loseReview) {
            loseReview = false;
            throw Error("Lost response");
          }
          return Response.json(r);
        }
        if (init.method === "POST" && path.endsWith("/comments")) {
          writes.push({ url: address, method: "POST", body: data });
          const c = {
            id: 1000 + comments.size,
            body: data.body,
            user: { id: 500, type: "Bot", login: "deepx-fixture[bot]" },
          };
          comments.set(c.id, c);
          if (loseProgress) {
            loseProgress = false;
            throw Error("Lost progress response");
          }
          return Response.json(c);
        }
        if (init.method === "PATCH") {
          const id = Number(path.split("/").at(-1));
          const c = comments.get(id);
          if (!c) return Response.json({}, { status: 404 });
          c.body = data.body;
          writes.push({ url: address, method: "PATCH", body: data });
          return Response.json(c);
        }
        if (path.endsWith("/pulls/23")) return Response.json(pull);
        if (path.endsWith("/files"))
          return Response.json([
            {
              filename: "src/api.ts",
              patch: "@@ -1,2 +1,2 @@\n-old\n+new\n context",
            },
          ]);
        if (path.endsWith("/reviews")) return Response.json(reviews);
        if (path.endsWith("/issues/23/comments"))
          return Response.json([...comments.values()]);
        if (/\/(?:issues|pulls)\/comments\/\d+$/.test(path)) {
          if (!sourceAvailable) return Response.json({}, { status: 503 });
          await onSourceRead?.();
          const c = comments.get(Number(path.split("/").at(-1)));
          return c ? Response.json(c) : Response.json({}, { status: 404 });
        }
      }
      return githubTransport()(input, init);
    }) as typeof fetch;
    const app = new GitHubApp(
      { ...githubFixtureConfig, webhookSecret: secret },
      transport,
    );
    const apps = new GitHubApps(store, "ab".repeat(32), app);
    const service = new ReviewService(
      store,
      apps,
      "ab".repeat(32),
      "https://repodesk.example",
    );
    const runner = new Runner();
    const executor = new ReviewExecutor(store, apps, runner, "ab".repeat(32));
    async function accept(
      event = "pull_request",
      extra: Record<string, unknown> = {},
      delivery = randomUUID(),
    ) {
      const payload = {
        action: event === "pull_request" ? "opened" : "created",
        installation: { id: 501 },
        repository: { id: 7001, full_name: "example/workspace" },
        sender: { id: 42, type: "User" },
        ...(event === "pull_request"
          ? {
              pull_request: {
                number: 23,
                draft: false,
                head: { sha: pull.head.sha },
              },
            }
          : { issue: { number: 23, pull_request: {} } }),
        ...extra,
      };
      const body = Buffer.from(JSON.stringify(payload));
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      await service.accept(operatorId, event, delivery, signature, body);
    }
    async function mention(
      text = "@deepx-fixture[bot] fix this",
      id = 90,
      user = 42,
    ) {
      const comment = {
        issue_url: "https://api.github.com/repos/example/workspace/issues/23",
        id,
        body: text,
        user: { id: user, type: "User", login: "fixture-user" },
      };
      comments.set(id, comment);
      await accept("issue_comment", {
        sender: { id: user, type: "User" },
        comment,
      });
    }
    async function task(index = 0) {
      const t = (await store.read(w.id)).reviewTasks?.[index];
      if (!t) throw Error("Missing task");
      return t;
    }
    return {
      w,
      admin,
      service,
      runner,
      executor,
      pull,
      comments,
      reviews,
      writes,
      permissions,
      accept,
      mention,
      task,
      sourceAvailable: (available: boolean) => {
        sourceAvailable = available;
      },
      onSourceRead: (action: () => Promise<void>) => {
        onSourceRead = action;
      },
      loseReview: () => {
        loseReview = true;
      },
      loseProgress: () => {
        loseProgress = true;
      },
    };
  }
  async function telegramFixture() {
    const f = await fixture();
    const d = await store.deployment();
    d.bot = { id: "999", username: "fixture", visibleAll: true };
    d.credentials.bot = encrypt("ab".repeat(32), "bot", "123456:fixture-token");
    await store.saveDeployment(store.pool, d);
    const original = "Fix pagination and open a PR";
    const task = await store.change(f.w.id, async (w, sql) => {
      const run = createRun(w, "101", original, "101", 0, "fixture-model", {
        replyTo: 10,
        botId: "999",
      });
      run.status = "running";
      const source = w.messages.find(
        (message) => message.runId === run.id && message.role === "user",
      );
      if (!source) throw Error("Missing Telegram requirement");
      return startDevelopment(sql, w, run.id, "101", 7001, [source.id], "999");
    });
    f.pull.head.ref = `codex/repodesk-${task.id}`;
    const executor = () =>
      new DevelopmentExecutor(store, f.service.apps, f.runner, "ab".repeat(32));
    const read = () => taskGet(store.pool, f.w.id, task.id);
    const tick = async (status?: LocalStatus) => {
      const current = await read();
      if (status && current.attemptId)
        f.runner.states.set(current.attemptId, status);
      await store.change(f.w.id, async (_w, sql) => {
        const current = await taskGet(sql, f.w.id, task.id);
        current.nextPollAt = undefined;
        await taskSave(sql, current);
      });
      await executor().advance(f.w.id, task.id);
      return read();
    };
    const outcome = (
      revision: number,
      evidence: string,
      status: "intent" | "completed",
    ): DevelopmentResult => ({
      ...analysis,
      status,
      intent: "implement",
      evidenceRevision: revision,
      evidence,
      summary: "Pagination fixed and checked.",
      publishRequested: true,
      verificationCommands: ["bun test"],
    });
    await tick();
    await tick({
      state: "succeeded",
      result: outcome(1, original, "intent"),
      tokens: 10,
    });
    await tick();
    await tick({
      state: "ready",
      checkPassed: true,
      result: outcome(1, original, "completed"),
      tokens: 10,
    });
    await tick();
    f.pull.head.sha = published;
    expect((await read()).pullBinding).toEqual({
      installationId: 501,
      repositoryId: 7001,
      number: 23,
      branch: f.pull.head.ref,
    });
    return { ...f, task, read, tick, outcome };
  }
  test("GitHub fixes continue the published Telegram task and PR across executor reconstruction", async () => {
    const f = await telegramFixture();
    const text = "fix the remaining pagination edge case";
    await f.mention(`@deepx-fixture[bot] ${text}`);
    await f.mention(`@deepx-fixture[bot] ${text}`);
    expect((await f.read()).revision).toBe(2);
    expect((await store.read(f.w.id)).reviewTasks ?? []).toHaveLength(0);
    expect(
      await store.pool
        .query("SELECT id FROM coding_tasks WHERE workspace_id=$1", [f.w.id])
        .then((r) => r.rowCount),
    ).toBe(1);
    const inputs = await taskInputs(store.pool, f.task);
    expect(inputs[1]).toMatchObject({
      actor: "101",
      sourceId: "github:issue:90",
      text,
      github: { githubId: 42, kind: "issue", id: 90 },
    });
    expect(
      (await store.read(f.w.id)).messages.some(
        (message) => message.id === "github:issue:90",
      ),
    ).toBe(false);
    await f.tick();
    expect(f.runner.starts.at(-1)?.development).toMatchObject({
      taskId: f.task.id,
      revision: 2,
      mode: "intake",
      pr: { number: 23 },
    });
    await f.tick({
      state: "succeeded",
      result: f.outcome(2, text, "intent"),
      tokens: 10,
    });
    await f.tick();
    f.runner.nextPublishedSha = "d".repeat(40);
    await f.tick({
      state: "ready",
      checkPassed: true,
      result: f.outcome(2, text, "completed"),
      tokens: 10,
    });
    await f.tick();
    const saved = await f.read();
    expect(saved).toMatchObject({
      state: "review",
      revision: 2,
      verifiedRevision: 2,
      pr: { number: 23, headSha: "d".repeat(40) },
    });
    expect(f.runner.pushes).toHaveLength(2);
    f.pull.head.sha = "d".repeat(40);
    const w = await store.read(f.w.id);
    expect(
      w.deliveries.some(
        (delivery) =>
          delivery.id === `development:${f.task.id}:published:${saved.fence}` &&
          delivery.chatId === "101" &&
          delivery.text.includes(saved.pr?.url ?? "missing"),
      ),
    ).toBe(true);
    expect(f.writes).toHaveLength(0);
    const run = w.runs.find((run) => run.codingTaskId === f.task.id);
    if (!run) throw Error("Missing original run");
    expect(await codingTaskContext(store.pool, w, run, "999")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: f.task.id, state: "review" }),
      ]),
    );
    const history = miniAppRoutes(store, {} as SetupService, "ab".repeat(32));
    const response = await history.request("/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initData: signedMiniAppData("123456:fixture-token"),
        reference: taskReference(f.w.id, f.task.id),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      task: { state: "review" },
      items: expect.arrayContaining([expect.objectContaining({ text })]),
    });
    await store.change(f.w.id, async (current, sql) => {
      const run = createRun(
        current,
        "101",
        "Which checks passed?",
        "101",
        0,
        "fixture-model",
        { replyTo: 11, botId: "999" },
      );
      run.status = "running";
      await askTask(
        sql,
        current,
        await taskGet(sql, current.id, f.task.id),
        run,
        "latest-checks",
        "Which checks passed?",
      );
    });
    await f.tick();
    expect(f.runner.starts.at(-1)?.development).toMatchObject({
      taskId: f.task.id,
      mode: "analysis",
      pr: { number: 23, headSha: "d".repeat(40) },
    });
    expect(f.runner.starts.at(-1)?.messages).toEqual([
      expect.objectContaining({ question: "Which checks passed?" }),
    ]);
    await store.change(f.w.id, (current, sql) =>
      pruneDevelopment(sql, current),
    );
    expect((await f.read()).contentRemoved).toBeUndefined();
  });
  test("edited, deleted and foreign-PR GitHub inputs cannot execute a bound Telegram task", async () => {
    for (const change of ["edit", "delete", "foreign"] as const) {
      const f = await telegramFixture();
      await f.mention();
      const comment = f.comments.get(90);
      if (!comment) throw Error("Missing source");
      if (change === "edit") comment.body += " changed";
      if (change === "delete") f.comments.delete(90);
      if (change === "foreign")
        comment.issue_url =
          "https://api.github.com/repos/example/workspace/issues/24";
      await f.tick();
      expect({
        change,
        state: (await f.read()).state,
        error: (await f.read()).error,
      }).toEqual({
        change,
        state: "failed",
        error: "coding_github_source_changed",
      });
      expect(f.runner.starts).toHaveLength(2);
      expect(f.runner.pushes).toHaveLength(1);
    }
  });
  test("a GitHub follow-up cannot reuse the previous revision's grant to publish during intake", async () => {
    const f = await telegramFixture();
    await f.mention();
    await f.tick();
    await f.tick({
      state: "ready",
      checkPassed: true,
      result: f.outcome(2, "fix this", "completed"),
      tokens: 10,
    });
    expect((await f.read()).state).toBe("failed");
    expect((await f.read()).error).toBe("coding_unverified_artifact");
    expect(f.runner.pushes).toHaveLength(1);
  });
  test("GitHub source outages retain the task and retry without duplicate execution", async () => {
    const f = await telegramFixture();
    await f.mention();
    f.sourceAvailable(false);
    await f.tick();
    expect(await f.read()).toMatchObject({
      state: "queued",
      error: "coding_github_source_unavailable",
      revision: 2,
      attempts: 2,
    });
    expect(f.runner.starts).toHaveLength(2);
    f.sourceAvailable(true);
    await f.tick();
    expect(await f.read()).toMatchObject({
      state: "working",
      revision: 2,
      attempts: 3,
    });
    expect((await f.read()).error).toBeUndefined();
    expect(f.runner.starts).toHaveLength(3);
  });
  test("GitHub source edits and permission revocation block publication of completed follow-up work", async () => {
    for (const change of [
      "edit",
      "member",
      "settings",
      "settingsDuringRead",
      "destination",
    ] as const) {
      const f = await telegramFixture();
      const text = "fix this";
      await f.mention();
      await f.tick();
      await f.tick({
        state: "succeeded",
        result: f.outcome(2, text, "intent"),
        tokens: 10,
      });
      await f.tick();
      if (change === "edit") {
        const comment = f.comments.get(90);
        if (!comment) throw Error("Missing source");
        comment.body += " changed";
      } else if (change === "settingsDuringRead") {
        f.onSourceRead(async () => {
          await store.change(f.w.id, (w) => {
            if (w.reviewBot) w.reviewBot.settings.allowFixes = false;
          });
        });
      } else if (change === "destination") {
        const other = structuredClone(await store.read(f.w.id));
        other.id = "00000000-0000-4000-8000-000000000001";
        await store.pool.query(
          "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
          [other.id, other.operatorId, JSON.stringify(other)],
        );
      } else
        await store.change(f.w.id, (w) => {
          if (change === "member") {
            const member = w.members.find((member) => member.id === "101");
            if (member) member.active = false;
          } else if (w.reviewBot) w.reviewBot.settings.allowFixes = false;
        });
      await f.tick({
        state: "ready",
        checkPassed: true,
        result: f.outcome(2, text, "completed"),
        tokens: 10,
      });
      expect(["failed", "cancelled"]).toContain((await f.read()).state);
      expect(f.runner.pushes).toHaveLength(1);
      expect(f.runner.cancels.length).toBeGreaterThan(0);
    }
  });
  test("inline GitHub fixes carry parent review evidence into the original task", async () => {
    const f = await telegramFixture();
    const pullUrl = "https://api.github.com/repos/example/workspace/pulls/23";
    f.comments.set(80, {
      id: 80,
      body: "Validate the cursor before incrementing.",
      user: { id: 500, type: "Bot", login: "reviewer" },
      pull_request_url: pullUrl,
      path: "src/api.ts",
      line: 2,
    });
    const comment = {
      id: 91,
      body: "@deepx-fixture[bot] fix this",
      user: { id: 42, type: "User", login: "fixture-user" },
      pull_request_url: pullUrl,
      in_reply_to_id: 80,
    };
    f.comments.set(91, comment);
    await f.accept("pull_request_review_comment", { comment });
    await f.tick();
    const run = f.runner.starts.at(-1)?.development;
    expect(run?.inputs.at(-1)?.github).toMatchObject({
      kind: "review",
      id: 91,
    });
    expect(run?.context).toContain("Validate the cursor before incrementing.");
    expect((await store.read(f.w.id)).reviewTasks ?? []).toHaveLength(0);
  });
  test("GitHub inputs are erased with original task sources", async () => {
    const f = await telegramFixture();
    await f.mention();
    await store.change(f.w.id, async (w, sql) => {
      const task = await taskGet(sql, w.id, f.task.id);
      const source = w.messages.find((message) => message.id === task.sourceId);
      if (source) source.expiresAt = new Date(0).toISOString();
      await pruneDevelopment(sql, w);
    });
    expect((await f.read()).contentRemoved).toBe(true);
    expect(await taskInputs(store.pool, f.task)).toHaveLength(0);
    expect((await f.read()).pullBinding).toBeUndefined();
  });
  test("GitHub fixes cannot revive a stopped bound Telegram task", async () => {
    const f = await telegramFixture();
    await store.change(f.w.id, async (_w, sql) => {
      const task = await taskGet(sql, f.w.id, f.task.id);
      task.state = "cancelled";
      task.cancelRequested = true;
      await taskSave(sql, task);
    });
    await expect(f.mention()).rejects.toThrow("coding_cancelled");
    expect((await f.read()).state).toBe("cancelled");
    expect((await f.read()).revision).toBe(1);
    expect((await store.read(f.w.id)).reviewTasks ?? []).toHaveLength(0);
  });
  test("unbound historical PRs retain independent Review Bot routing", async () => {
    const f = await telegramFixture();
    await store.change(f.w.id, async (_w, sql) => {
      const task = await taskGet(sql, f.w.id, f.task.id);
      task.pullBinding = undefined;
      await taskSave(sql, task);
    });
    await f.mention();
    expect((await f.read()).revision).toBe(1);
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(1);
  });
  test("read-only comments and other verified collaborators keep separate Review Bot routing", async () => {
    const f = await telegramFixture();
    await f.mention("@deepx-fixture[bot] explain this finding");
    expect((await f.read()).revision).toBe(1);
    expect((await store.read(f.w.id)).reviewTasks?.[0]?.mode).toBe("answer");
    await store.change(f.w.id, (w) => {
      const owner = w.members.find((member) => member.id === "101");
      const other = w.members.find((member) => member.id === "202");
      if (!owner?.github || !other) throw Error("Missing members");
      other.github = {
        ...structuredClone(owner.github),
        id: 43,
        login: "other",
      };
    });
    await f.mention("@deepx-fixture[bot] fix this", 91, 43);
    expect((await f.read()).revision).toBe(1);
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(2);
  });
  test("review source preparation failures stop the task without a question or publication", async () => {
    const f = await fixture();
    await f.accept();
    const task = await f.task();
    await f.executor.advance(f.w.id, task.id);
    f.runner.states.set(task.attemptId, {
      state: "failed",
      error: "coding_review_preparation_failed",
    });
    await f.executor.advance(f.w.id, task.id);
    await f.executor.advance(f.w.id, task.id);
    expect(await f.task()).toMatchObject({
      state: "failed",
      error: "coding_review_preparation_failed",
    });
    expect((await f.task()).result).toBeUndefined();
    expect(f.reviews).toHaveLength(0);
    expect(f.runner.pushes).toHaveLength(0);
    expect(f.runner.starts).toHaveLength(1);
  });
  test("selected PR events deduplicate semantically and produce one commit-pinned review", async () => {
    const f = await fixture();
    const delivery = randomUUID();
    await f.accept("pull_request", {}, delivery);
    await f.accept("pull_request", {}, delivery);
    await f.accept();
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(1);
    await f.executor.advance(f.w.id, (await f.task()).id);
    expect(f.runner.starts[0]?.development?.mode).toBe("analysis");
    expect(f.runner.starts[0]?.development?.review).toEqual({
      number: 23,
      headSha: head,
      baseSha: base,
      action: "review",
    });
    const t = await f.task();
    f.runner.states.set(t.attemptId, { state: "succeeded", result: analysis });
    await f.executor.advance(f.w.id, t.id);
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("completed");
    expect(f.reviews).toHaveLength(1);
    const write = f.writes.find((r) => r.url.endsWith("/reviews"));
    expect(write?.body).toMatchObject({
      commit_id: head,
      event: "COMMENT",
      comments: [{ path: "src/api.ts", line: 1, side: "RIGHT" }],
    });
    expect(f.permissions).toContainEqual({
      contents: "read",
      pull_requests: "read",
    });
    expect(f.permissions).toContainEqual({
      pull_requests: "write",
      issues: "write",
    });
    expect(f.runner.pushes).toHaveLength(0);
  });
  test("automatic reviews use the App policy without a member's private grant", async () => {
    const f = await fixture();
    await store.change(f.w.id, (w) => {
      w.members = [];
    });
    await f.accept();
    const task = await f.task();
    expect(task.actor).toBe(f.w.operatorId);
    await f.executor.advance(f.w.id, task.id);
    expect(f.runner.starts).toHaveLength(1);
    expect(f.runner.starts[0]?.development?.mode).toBe("analysis");
    expect(f.runner.starts[0]?.development?.review?.action).toBe("review");
    expect(f.runner.pushes).toHaveLength(0);
  });
  test("publication preserves both assessment axes for inline and unanchored findings", async () => {
    const f = await fixture();
    await f.accept();
    await f.executor.advance(f.w.id, (await f.task()).id);
    const t = await f.task();
    const summary =
      "## Standards\n1 advisory finding.\n\n## Spec\n2 requirements are incomplete.";
    const finding = {
      path: "src/api.ts",
      line: 1,
      side: "RIGHT" as const,
      severity: "low" as const,
      body: "Possible duplication: two update paths can drift apart.",
    };
    f.runner.states.set(t.attemptId, {
      state: "succeeded",
      result: {
        ...analysis,
        summary,
        reviewFindings: [
          { ...finding, axis: "standards" },
          {
            ...finding,
            axis: "spec",
            severity: "high",
            body: "The requested permission check is absent.",
          },
          {
            ...finding,
            axis: "spec",
            path: "src/missing.ts",
            body: "The required error response is missing.",
          },
        ],
      },
    });
    await f.executor.advance(f.w.id, t.id);
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("completed");
    const write = f.writes.find((r) => r.url.endsWith("/reviews"));
    expect(JSON.stringify(write?.body)).toContain(
      "src/missing.ts:1 — **Spec · low**: The required error response is missing.",
    );
    expect(write?.body).toMatchObject({
      commit_id: head,
      event: "COMMENT",
      body: expect.stringContaining(summary),
      comments: [
        {
          path: "src/api.ts",
          body: expect.stringContaining("**Standards · low**"),
        },
        {
          path: "src/api.ts",
          body: expect.stringContaining("**Spec · high**"),
        },
      ],
    });
    expect(f.reviews).toHaveLength(1);
    expect(f.runner.pushes).toHaveLength(0);
  });
  test("tagged reviews use GitHub read access and never acquire a fix grant", async () => {
    const f = await fixture();
    await store.change(f.w.id, (w) => {
      const access = w.members.find((m) => m.id === "101")?.github;
      if (!access?.repositories[0]?.permissions) throw Error("Missing access");
      access.repositories[0].permissions.push = false;
    });
    await f.mention("@deepx-fixture[bot] review");
    expect((await f.task()).mode).toBe("review");
    await f.mention("@deepx-fixture[bot] fix this", 97);
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(1);
  });
  test("connection overlap routes each PR once and revokes the losing workspace's task", async () => {
    const first = await fixture(),
      second = await fixture();
    await store.pool.query(
      "UPDATE workspaces SET operator_id=$2::uuid,data=jsonb_set(data,'{operatorId}',to_jsonb(($2::uuid)::text)) WHERE id=$1",
      [second.w.id, first.w.operatorId],
    );
    const [winner, loser] = [first.w.id, second.w.id].sort();
    if (!winner || !loser) throw Error("Missing workspace");
    await store.change(winner, (w) => {
      if (w.github) w.github.repositories = [];
    });
    await first.accept();
    const prior = (await store.read(loser)).reviewTasks?.[0];
    if (!prior) throw Error("Missing original task");
    await store.change(winner, (w) => {
      if (w.github) {
        w.github.repositories = first.w.github?.repositories ?? [];
        w.github.revision++;
      }
    });
    await first.accept();
    expect((await store.read(winner)).reviewTasks).toHaveLength(1);
    expect((await store.read(loser)).reviewTasks).toHaveLength(1);
    await first.executor.advance(loser, prior.id);
    expect((await store.read(loser)).reviewTasks?.[0]?.state).toBe("cancelled");
    expect(first.runner.starts).toHaveLength(0);
    await first.accept();
    expect((await store.read(winner)).reviewTasks).toHaveLength(1);
  });
  test("drafts, unselected repositories and ordinary issue comments do not run", async () => {
    const f = await fixture();
    await f.accept("pull_request", {
      pull_request: { number: 23, draft: true, head: { sha: head } },
    });
    await f.accept("pull_request", {
      repository: { id: 7002, full_name: "example/second" },
    });
    await f.accept("issue_comment", {
      issue: { number: 23 },
      comment: {
        id: 1,
        body: "@deepx-fixture[bot] fix this",
        user: { id: 42, type: "User" },
      },
    });
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(0);
  });
  test("tagged fixes require verified ownership and a current maintainer write grant", async () => {
    const f = await fixture();
    await store.change(f.w.id, (w) => {
      const m = w.members.find((m) => m.id === "101");
      if (m) {
        delete m.github;
        m.githubAccount = { id: 42, login: "fixture-user" };
      }
    });
    await f.mention();
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(0);
    await store.change(f.w.id, (w) => {
      w.members = f.w.members;
      const access = w.members[0]?.github;
      if (access?.repositories[0]?.permissions)
        access.repositories[0].permissions.push = false;
    });
    await f.mention("@deepx-fixture[bot] fix this", 91);
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(0);
  });
  test("removing coding modes keeps Review Bot fix permission enforced", async () => {
    const f = await fixture();
    await f.mention();
    const task = await f.task();
    await store.change(f.w.id, (w) => {
      if (!w.reviewBot) throw Error("Missing review settings");
      w.reviewBot.settings.allowFixes = false;
    });
    await f.executor.advance(f.w.id, task.id);
    expect(f.runner.starts).toHaveLength(0);
    expect(f.runner.pushes).toHaveLength(0);
    expect((await f.task()).error).toBe("review_fixes_disabled");
    await f.mention("@deepx-fixture[bot] fix this", 101);
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(1);
  });
  test("explicit fixes run checks and update the existing PR without creating an issue or PR", async () => {
    const f = await fixture();
    f.pull.base.ref = "release/maintenance";
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    expect(f.runner.starts[0]?.payload.baseBranch).toBe("release/maintenance");
    expect(f.runner.starts[0]?.development?.mode).toBe("work");
    expect(f.runner.starts[0]?.development?.pr?.branch).toBe("feature/api");
    f.runner.states.set(t.attemptId, {
      state: "ready",
      checkPassed: true,
      result: {
        ...analysis,
        status: "completed",
        intent: "implement",
        verificationCommands: ["bun test"],
      },
    });
    await f.executor.advance(f.w.id, t.id);
    await f.executor.advance(f.w.id, t.id);
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("completed");
    expect(f.runner.pushes).toHaveLength(1);
    expect((await f.task()).publishedSha).toBe(published);
    expect(
      f.writes.filter(
        (r) => r.method === "POST" && r.url.endsWith("/comments"),
      ),
    ).toHaveLength(1);
    expect(f.writes.some((r) => r.method === "PATCH")).toBe(true);
    expect(
      f.writes.some(
        (r) => r.url.endsWith("/issues") || r.url.endsWith("/pulls"),
      ),
    ).toBe(false);
  });
  test("a failed check cannot publish a fix", async () => {
    const f = await fixture();
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    f.runner.states.set(t.attemptId, {
      state: "ready",
      checkPassed: false,
      result: {
        ...analysis,
        status: "completed",
        verificationCommands: ["bun test"],
      },
    });
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("failed");
    expect(f.runner.pushes).toHaveLength(0);
  });
  test("fork PRs can be reviewed but cannot receive direct fixes", async () => {
    const f = await fixture();
    f.pull.head.repo.full_name = "contributor/fork";
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("failed");
    expect(f.runner.starts).toHaveLength(0);
    await f.accept();
    const review = await f.task(1);
    await f.executor.advance(f.w.id, review.id);
    expect(f.runner.starts[0]?.development?.review?.headSha).toBe(head);
  });
  test("new commits discard stale review findings and concurrent PR jobs serialize", async () => {
    const f = await fixture();
    await f.accept();
    const first = await f.task();
    await f.executor.advance(f.w.id, first.id);
    await f.mention("@deepx-fixture[bot] review");
    const second = await f.task(1);
    await f.executor.advance(f.w.id, second.id);
    expect(f.runner.starts).toHaveLength(1);
    f.runner.states.set(first.attemptId, {
      state: "succeeded",
      result: analysis,
    });
    await f.executor.advance(f.w.id, first.id);
    f.pull.head.sha = "d".repeat(40);
    await f.executor.advance(f.w.id, first.id);
    expect((await f.task()).state).toBe("cancelled");
    expect(f.reviews).toHaveLength(0);
    await f.executor.advance(f.w.id, second.id);
    expect(f.runner.starts).toHaveLength(2);
  });
  test("a maintainer push makes a fix restart from current code instead of overwriting it", async () => {
    const f = await fixture();
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    f.runner.states.set(t.attemptId, {
      state: "ready",
      checkPassed: true,
      result: {
        ...analysis,
        status: "completed",
        verificationCommands: ["bun test"],
      },
    });
    await f.executor.advance(f.w.id, t.id);
    f.pull.head.sha = "d".repeat(40);
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("queued");
    await f.executor.advance(f.w.id, t.id);
    expect(f.runner.starts.at(-1)?.development?.pr?.headSha).toBe(
      f.pull.head.sha,
    );
    expect(f.runner.pushes).toHaveLength(0);
  });
  test("lost runner start responses reconcile the stable attempt without running twice", async () => {
    const f = await fixture();
    await f.accept();
    const t = await f.task();
    f.runner.loseStart = true;
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("starting");
    await new ReviewExecutor(
      store,
      f.service.apps,
      f.runner,
      "ab".repeat(32),
    ).advance(f.w.id, t.id);
    expect(f.runner.starts).toHaveLength(1);
  });
  test("lost review responses reconcile their marker without another POST", async () => {
    const f = await fixture();
    await f.accept();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    f.runner.states.set(t.attemptId, { state: "succeeded", result: analysis });
    await f.executor.advance(f.w.id, t.id);
    f.loseReview();
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("unknown");
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("completed");
    expect(f.reviews).toHaveLength(1);
  });
  test("unknown progress sends recover their comment ID before editing", async () => {
    const f = await fixture();
    await f.mention("@deepx-fixture[bot] explain this PR");
    f.loseProgress();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    await f.executor.advance(f.w.id, t.id);
    expect(
      f.writes.filter(
        (r) => r.method === "POST" && r.url.endsWith("/comments"),
      ),
    ).toHaveLength(1);
    expect((await f.task()).progress?.id).toBeDefined();
  });
  test("edited instructions and revoked membership stop work before publication", async () => {
    for (const revoke of [false, true]) {
      const f = await fixture();
      await f.mention();
      const t = await f.task();
      await f.executor.advance(f.w.id, t.id);
      f.runner.states.set(t.attemptId, {
        state: "ready",
        checkPassed: true,
        result: {
          ...analysis,
          status: "completed",
          verificationCommands: ["bun test"],
        },
      });
      await f.executor.advance(f.w.id, t.id);
      if (revoke)
        await store.change(f.w.id, (w) => {
          const member = w.members.find((m) => m.id === "101");
          if (member) member.active = false;
        });
      else {
        const c = f.comments.get(90);
        if (c) c.body = "Changed request";
      }
      await f.executor.advance(f.w.id, t.id);
      expect((await f.task()).state).toBe("cancelled");
      expect(f.runner.pushes).toHaveLength(0);
    }
  });
  test("questions and tagged answers continue the same durable task", async () => {
    const f = await fixture();
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    f.runner.states.set(t.attemptId, {
      state: "succeeded",
      result: {
        ...analysis,
        status: "needs_input",
        intent: "implement",
        question: "Which sort order?",
      },
    });
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("waiting");
    await f.mention("@deepx-fixture[bot] ascending order", 91);
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(1);
    await f.executor.advance(f.w.id, t.id);
    expect(f.runner.starts.at(-1)?.development?.inputs.at(-1)?.text).toBe(
      "ascending order",
    );
    expect(f.runner.starts.at(-1)?.development?.previousAttemptId).toBe(
      t.attemptId,
    );
  });
  test("cancel is accepted from an authorized tag and stops the runner", async () => {
    const f = await fixture();
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    await f.mention("@deepx-fixture[bot] cancel", 91);
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("cancelled");
    expect(f.runner.cancels).toContain(t.attemptId);
  });
  test("settings are operator-only, revisioned and exclusive per App repository", async () => {
    const f = await fixture();
    await expect(
      f.service.view({ ...f.admin, id: randomUUID() }, f.w.id),
    ).rejects.toThrow("access_denied");
    await expect(
      f.service.save(f.admin, f.w.id, {
        revision: 0,
        settings: f.w.reviewBot?.settings,
      }),
    ).rejects.toThrow("version_conflict");
    const other: Workspace = {
      ...structuredClone(f.w),
      id: randomUUID(),
      reviewBot: {
        revision: 0,
        settings: {
          enabled: false,
          autoReview: true,
          acceptRequests: true,
          allowFixes: false,
        },
      },
    };
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [other.id, other.operatorId, JSON.stringify(other)],
    );
    await expect(
      f.service.save(f.admin, other.id, {
        revision: 0,
        settings: f.w.reviewBot?.settings,
      }),
    ).rejects.toThrow("review_repository_already_configured");
    await f.service.configureHook(f.admin, f.w.id, {});
    const hook = (
      await store.pool.query(
        "SELECT secret FROM review_bot_hooks WHERE operator_id=$1",
        [f.admin.id],
      )
    ).rows[0];
    expect(hook.secret).not.toContain(secret);
    expect(JSON.stringify(await f.service.view(f.admin, f.w.id))).not.toContain(
      "webhookSecret",
    );
  });
  test("HTTP ingress validates the signature before parsing or accepting events", async () => {
    const f = await fixture();
    const app = createApp(
      store,
      new SetupService(store, "ab".repeat(32), "https://repodesk.example"),
      "https://repodesk.example",
      undefined,
      undefined,
      "ab".repeat(32),
      undefined,
      f.service,
    );
    const response = await app.request(`/github/webhook/${f.admin.id}`, {
      method: "POST",
      headers: {
        "x-github-delivery": randomUUID(),
        "x-github-event": "pull_request",
      },
      body: "not-json",
    });
    expect(response.status).toBe(401);
    expect((await store.read(f.w.id)).reviewTasks).toBeUndefined();
  });
  test("deletion clears review content and retries runner cleanup after an outage", async () => {
    const f = await fixture();
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    await store.change(f.w.id, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "pending",
      };
      sweep(w);
    });
    f.runner.available = false;
    await f.executor.tick(f.w.id);
    expect((await store.read(f.w.id)).reviewTasks).toBeUndefined();
    f.runner.available = true;
    await f.executor.tick(f.w.id);
    expect(f.runner.erased).toContain(t.attemptId);
    expect((await store.read(f.w.id)).reviewCleanup).toEqual([]);
  });
  test("status replies bypass a busy fix without starting another model task", async () => {
    const f = await fixture();
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    await f.mention("@deepx-fixture status", 91);
    const status = await f.task(1);
    await f.executor.advance(f.w.id, status.id);
    expect((await f.task(1)).state).toBe("completed");
    expect((await f.task(1)).result?.summary).toContain("fix task is running");
    expect(f.runner.starts).toHaveLength(1);
  });
  test("inline fix replies bind the original finding to the same PR", async () => {
    const f = await fixture();
    f.comments.set(89, {
      id: 89,
      body: "Missing actor authorization in this line.",
      user: { id: 500, type: "Bot", login: "deepx-fixture[bot]" },
      pull_request_url:
        "https://api.github.com/repos/example/workspace/pulls/23",
      path: "src/api.ts",
      line: 1,
    });
    const comment = {
      id: 90,
      body: "@deepx-fixture fix this",
      user: { id: 42, type: "User", login: "fixture-user" },
      in_reply_to_id: 89,
      pull_request_url:
        "https://api.github.com/repos/example/workspace/pulls/23",
    };
    f.comments.set(90, comment);
    await f.accept("pull_request_review_comment", {
      comment,
      pull_request: { number: 23, draft: false, head: { sha: head } },
    });
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    expect(f.runner.starts[0]?.development?.context).toContain(
      "Missing actor authorization in this line.",
    );
  });
  test("a comment from another PR cannot authorize work", async () => {
    const f = await fixture();
    await f.mention();
    const comment = f.comments.get(90);
    if (comment)
      comment.issue_url =
        "https://api.github.com/repos/example/workspace/issues/24";
    await f.executor.advance(f.w.id, (await f.task()).id);
    expect((await f.task()).state).toBe("cancelled");
    expect(f.runner.starts).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
  });
  test("Telegram follow-ups wait for a Review Bot fix on the same PR", async () => {
    const f = await fixture();
    await f.mention();
    const review = await f.task();
    await f.executor.advance(f.w.id, review.id);
    await store.pool.query(
      'UPDATE deployment SET data=jsonb_set(data,\'{bot}\',\'{"id":"999","username":"fixture"}\')',
    );
    const task: DevelopmentTask = {
      id: randomUUID(),
      workspaceId: f.w.id,
      actor: "101",
      botId: "999",
      chatId: "101",
      topicId: 0,
      sourceId: "fixture",
      payload: review.payload,
      policy: { publishByDefault: true },
      state: "queued",
      phase: "intake",
      revision: 1,
      consumedRevision: 0,
      verifiedRevision: 0,
      fence: 0,
      attempts: 0,
      tokens: 0,
      activeMs: 0,
      canImplement: false,
      canPublish: false,
      cancelRequested: false,
      pr: {
        number: 23,
        url: "https://github.com/example/workspace/pull/23",
        branch: "feature/api",
        headSha: head,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.pool.query(
      "INSERT INTO coding_tasks(workspace_id,id,data) VALUES($1,$2,$3)",
      [f.w.id, task.id, JSON.stringify(task)],
    );
    await store.change(f.w.id, (w) => {
      w.messages.push({
        id: "legacy-source",
        chatId: "101",
        topicId: 0,
        author: "101",
        role: "user",
        text: "Continue the PR",
        at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        directed: true,
      });
    });
    await store.pool.query(
      "INSERT INTO coding_task_inputs(workspace_id,task_id,revision,source_key,data) VALUES($1,$2,1,$3,$4)",
      [
        f.w.id,
        task.id,
        "legacy-source",
        JSON.stringify({
          revision: 1,
          actor: "101",
          sourceId: "legacy-source",
          text: "Continue the PR",
          kind: "request",
        }),
      ],
    );
    await new DevelopmentExecutor(
      store,
      f.service.apps,
      f.runner,
      "ab".repeat(32),
    ).advance(f.w.id, task.id);
    const saved = (
      await store.pool.query(
        "SELECT data FROM coding_tasks WHERE workspace_id=$1 AND id=$2",
        [f.w.id, task.id],
      )
    ).rows[0].data;
    expect(saved.state).toBe("queued");
    expect(saved.cancelRequested).toBe(false);
    expect(f.runner.starts).toHaveLength(1);
  });
  test("explicit requests work on drafts and readiness can replace a cancelled automatic review", async () => {
    const f = await fixture();
    f.pull.draft = true;
    await f.mention();
    const manual = await f.task();
    await f.executor.advance(f.w.id, manual.id);
    expect(f.runner.starts).toHaveLength(1);
    await f.mention("@deepx-fixture cancel", 91);
    await f.executor.advance(f.w.id, manual.id);
    f.pull.draft = false;
    await f.accept();
    const automatic = await f.task(1);
    await f.accept("pull_request", {
      action: "converted_to_draft",
      pull_request: { number: 23, draft: true, head: { sha: head } },
    });
    await f.executor.advance(f.w.id, automatic.id);
    await f.accept("pull_request", { action: "ready_for_review" });
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(3);
    await f.accept("pull_request", { action: "ready_for_review" });
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(3);
  });
  test("signed HTTP webhook bodies retain their bytes and have their own size limit", async () => {
    const f = await fixture();
    const app = createApp(
      store,
      new SetupService(store, "ab".repeat(32), "https://repodesk.example"),
      "https://repodesk.example",
      undefined,
      undefined,
      "ab".repeat(32),
      undefined,
      f.service,
    );
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 501 },
      repository: { id: 7001, full_name: "example/workspace" },
      sender: { id: 42, type: "User" },
      pull_request: { number: 23, draft: false, head: { sha: head } },
      padding: "你好".repeat(40000),
    });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const response = await app.request(`/github/webhook/${f.admin.id}`, {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": signature,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect((await store.read(f.w.id)).reviewTasks).toHaveLength(1);
    const ordinary = await app.request("/api/admin/example", {
      method: "POST",
      body,
    });
    expect(ordinary.status).toBe(413);
  });
  test("confirmed stale-head push rejections restart work; unknown writes do not", async () => {
    const f = await fixture();
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
    f.runner.states.set(t.attemptId, {
      state: "failed",
      error: "coding_remote_head_changed",
    });
    f.pull.head.sha = "d".repeat(40);
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("queued");
    await f.executor.advance(f.w.id, t.id);
    expect(f.runner.starts.at(-1)?.development?.pr?.headSha).toBe(
      f.pull.head.sha,
    );
    const next = await f.task();
    f.runner.states.set(next.attemptId, {
      state: "unknown",
      error: "coding_publication_unknown",
    });
    await f.executor.advance(f.w.id, t.id);
    expect((await f.task()).state).toBe("unknown");
    expect(f.runner.pushes).toHaveLength(0);
  });
});
