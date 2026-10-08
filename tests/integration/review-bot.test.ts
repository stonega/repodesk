import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { createApp } from "../../src/app.ts";
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
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { type Admin, Fault, type Workspace } from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { sweep } from "../../src/privacy/service.ts";
import { ReviewExecutor } from "../../src/review-bot/executor.ts";
import { ReviewService } from "../../src/review-bot/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

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
    if (!input?.development?.pr) throw Error("Missing PR");
    this.states.set(id, {
      state: "succeeded",
      result: {
        ...analysis,
        status: "completed",
        intent: "implement",
        verificationCommands: ["bun test"],
      },
      checkPassed: true,
      publishedSha: published,
      prUrl: input.development.pr.url,
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
      repositories: [{ id: 7001, full_name: "example/workspace" }],
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
        repositories: [
          {
            repositoryId: 7001,
            baseBranch: "main",
            maintainers: ["101"],
            development: { executionMode: "direct", publishByDefault: false },
          },
        ],
      },
    };
    w.reviewBot = {
      revision: 1,
      settings: {
        enabled: true,
        repositories: [
          {
            repositoryId: 7001,
            reviewer: "101",
            autoReview: true,
            acceptRequests: true,
            allowFixes: true,
          },
        ],
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
      loseProgress = false;
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
      loseReview: () => {
        loseReview = true;
      },
      loseProgress: () => {
        loseProgress = true;
      },
    };
  }
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
  test("explicit fixes run checks and update the existing PR without creating an issue or PR", async () => {
    const f = await fixture();
    await f.mention();
    const t = await f.task();
    await f.executor.advance(f.w.id, t.id);
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
        settings: { enabled: false, repositories: [] },
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
      policy: { executionMode: "direct", publishByDefault: false },
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
