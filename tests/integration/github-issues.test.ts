import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import {
  type Approval,
  requireThat,
  type Workspace,
} from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { githubExtension } from "../../src/github/extension.ts";
import { GitHubIssues, issueApproval } from "../../src/github/issues.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { sweep } from "../../src/privacy/service.ts";
import { decide } from "../../src/workflows/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("GitHub issue approval and delivery", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `deepx_issues_${randomUUID().replaceAll("-", "")}`;
  let store: Store;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'issues','unused',true)",
      [operatorId],
    );
    await store.pool.query(
      "UPDATE deployment SET data=jsonb_set(data,'{active}','true')",
    );
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  const operatorId = randomUUID();
  const args = {
    repositoryId: 7001,
    title: "Fix recap",
    body: "Steps to reproduce\nExpected output",
    revision: 1,
  };
  async function fixture() {
    const w = workspace();
    w.operatorId = operatorId;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [{ id: 7001, full_name: "example/workspace" }],
    };
    const run = createRun(
      w,
      "101",
      "File an issue",
      "-100100",
      3,
      "gpt-4.1-mini",
    );
    run.status = "running";
    run.fence = 1;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    return { w, run };
  }
  async function proposal(w: Workspace, runId: string) {
    return store.change(w.id, (current) => {
      const a = issueApproval(current, "101", args);
      a.runId = runId;
      return structuredClone(a);
    });
  }
  function provider(
    response: () => Promise<Response> = async () =>
      Response.json({ number: 42 }, { status: 201 }),
    onToken?: () => Promise<void>,
  ) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fallback = githubTransport();
    const transport = (async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/issues")) return response();
      if (url.endsWith("/access_tokens")) await onToken?.();
      return fallback(input, init);
    }) as typeof fetch;
    const app = new GitHubApp(githubFixtureConfig, transport);
    return {
      requests,
      service: new GitHubIssues(
        store,
        new GitHubApps(store, "ab".repeat(32), app),
      ),
    };
  }
  const readApproval = async (id: string, a: Approval) =>
    (await store.read(id)).approvals.find((item) => item.id === a.id);

  test("real Pi factory creates a complete review once; connected repository and actor guards apply", async () => {
    const { w, run } = await fixture();
    const input: AgentInput = {
      workspaceId: w.id,
      actor: "101",
      runId: run.id,
      model: selectedModel("gpt-4.1-mini"),
      apiKey: "fake",
      system: "",
      prompt: "",
      transcript: [],
      tools: [],
      maxTurns: 2,
      maxTools: 3,
      signal: new AbortController().signal,
      guard: async () => {},
      reserve: async () => "attempt",
      checkpoint: async () => {},
    };
    requireThat(w.github, "missing fixture connection");
    const catalog = ExtensionCatalog.fromSnapshot(
      [],
      [githubExtension(store, w.id, w.github)],
    );
    const host = await catalog.open(input);
    try {
      const tool = host?.tools.find((t) => t.name === "propose_github_issue");
      requireThat(tool, "missing tool");
      const find = host?.tools.find(
        (t) => t.name === "find_connected_repository",
      );
      requireThat(find, "missing repository lookup");
      expect(
        JSON.stringify(
          await find.execute("lookup", { query: "workspace" }, input.signal),
        ),
      ).toContain("example/workspace");
      expect(tool.description).toContain("find_connected_repository");
      const payload = {
        repositoryId: args.repositoryId,
        title: args.title,
        body: args.body,
      };
      await tool.execute("call1", payload, input.signal);
      await tool.execute("call1", payload, input.signal);
      const current = await store.read(w.id);
      expect(current.approvals).toHaveLength(1);
      expect(current.approvals[0]?.decision).toBeUndefined();
      expect(current.deliveries).toHaveLength(1);
      expect(current.deliveries[0]?.text).toContain(args.body);
      expect(current.deliveries[0]?.text).toContain("example/workspace");
      expect(current.deliveries[0]?.buttons?.[0]).toHaveLength(2);
      await store.change(w.id, (current) => {
        requireThat(current.github, "missing fixture connection");
        current.github.revision++;
      });
      await expect(
        tool.execute("call2", payload, input.signal),
      ).rejects.toThrow();
      await expect(
        find.execute("lookup2", { query: "workspace" }, input.signal),
      ).rejects.toThrow();
    } finally {
      await host?.close();
    }
  });

  test("approval is required, bound to the actor, exact contents, repository, and expiry", async () => {
    const { w, run } = await fixture();
    const a = await proposal(w, run.id);
    const { service, requests } = provider();
    await service.send(w.id, a.id);
    expect(requests).toHaveLength(0);
    await expect(
      store.change(w.id, (w) => decide(w, "202", a.id, true)),
    ).rejects.toThrow("approval_denied");
    await expect(
      store.change(w.id, (w) => {
        (w.approvals[0]?.payload as { title: string }).title = "changed";
        decide(w, "101", a.id, true);
      }),
    ).rejects.toThrow("approval_changed");
    await expect(
      store.change(w.id, (w) => {
        requireThat(w.github, "missing fixture connection");
        w.github.revision++;
        decide(w, "101", a.id, true);
      }),
    ).rejects.toThrow("version_conflict");
    await expect(
      store.change(w.id, (w) => {
        requireThat(w.approvals[0], "missing fixture approval");
        w.approvals[0].expiresAt = new Date(0).toISOString();
        decide(w, "101", a.id, true);
      }),
    ).rejects.toThrow("approval_expired");
    await expect(
      store.change(w.id, (w) =>
        issueApproval(w, "101", { ...args, repositoryId: 7002 }),
      ),
    ).rejects.toThrow("github_repository_not_connected");
    await store.change(w.id, (w) => decide(w, "101", a.id, false));
    await service.send(w.id, a.id);
    expect(requests).toHaveLength(0);
  });

  test("concurrent workers submit once with Issues-only token and return the issue link", async () => {
    const { w, run } = await fixture();
    const a = await proposal(w, run.id);
    await store.change(w.id, (w) => decide(w, "101", a.id, true));
    const { service, requests } = provider();
    await Promise.all([service.send(w.id, a.id), service.send(w.id, a.id)]);
    await service.send(w.id, a.id);
    const post = requests.filter((r) => r.url.endsWith("/issues"));
    expect(post).toHaveLength(1);
    expect(JSON.parse(String(post[0]?.init.body))).toEqual({
      title: args.title,
      body: args.body,
    });
    expect(post[0]?.init.redirect).toBe("error");
    for (const token of requests.filter((r) =>
      r.url.endsWith("/access_tokens"),
    ))
      expect(JSON.parse(String(token.init.body))).toEqual({
        repository_ids: [7001],
        permissions: { issues: "write" },
      });
    const saved = await store.read(w.id);
    expect(saved.approvals[0]?.issue).toMatchObject({
      state: "created",
      number: 42,
      url: "https://github.com/example/workspace/issues/42",
    });
    expect(saved.deliveries[0]?.text).toContain(
      "https://github.com/example/workspace/issues/42",
    );
    expect(saved.deliveries[0]?.topicId).toBe(3);
    expect(JSON.stringify(saved)).not.toContain("ghs_fixture");
  });

  test("another tenant's approval cannot be sent; revocation during token minting prevents POST", async () => {
    const { w, run } = await fixture();
    const a = await proposal(w, run.id);
    await store.change(w.id, (w) => decide(w, "101", a.id, true));
    const other = await fixture();
    const { service, requests } = provider(undefined, async () => {
      await store.change(w.id, (w) => {
        w.github = { revision: 2, repositories: [] };
      });
    });
    await service.send(other.w.id, a.id);
    expect(requests).toHaveLength(0);
    await service.send(w.id, a.id);
    expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(0);
    expect((await readApproval(w.id, a))?.issue?.state).toBe("failed");
  });

  test("access revocation, cancellation and deployment pause prevent submission", async () => {
    for (const revoke of [
      (w: Workspace) => {
        requireThat(w.members[0], "missing fixture member");
        w.members[0].active = false;
      },
      (w: Workspace) => {
        requireThat(w.runs[0], "missing fixture run");
        w.runs[0].cancelled = true;
      },
      (w: Workspace) => {
        w.settings.paused = true;
      },
    ]) {
      const { w, run } = await fixture();
      const a = await proposal(w, run.id);
      await store.change(w.id, (w) => {
        decide(w, "101", a.id, true);
        revoke(w);
      });
      const { service, requests } = provider();
      await service.send(w.id, a.id);
      expect(requests).toHaveLength(0);
      expect((await readApproval(w.id, a))?.issue?.state).toBe("failed");
    }
    const { w, run } = await fixture();
    const a = await proposal(w, run.id);
    await store.change(w.id, (w) => decide(w, "101", a.id, true));
    const { service, requests } = provider(undefined, async () => {
      await store.pool.query(
        "UPDATE deployment SET data=jsonb_set(data,'{paused}','true')",
      );
    });
    try {
      await service.send(w.id, a.id);
      expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(0);
    } finally {
      await store.pool.query(
        "UPDATE deployment SET data=jsonb_set(data,'{paused}','false')",
      );
    }
  });

  test("ambiguous sends and interrupted reservations are never replayed, including after restart", async () => {
    const { w, run } = await fixture();
    const a = await proposal(w, run.id);
    await store.change(w.id, (w) => decide(w, "101", a.id, true));
    const { service, requests } = provider(async () => {
      throw new Error("private response text");
    });
    await service.send(w.id, a.id);
    await service.send(w.id, a.id);
    expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(1);
    expect((await readApproval(w.id, a))?.issue).toMatchObject({
      state: "unknown",
      error: "github_issue_outcome_unknown",
    });
    expect(JSON.stringify(await store.read(w.id))).not.toContain(
      "private response text",
    );
    const next = await proposal(w, run.id);
    await store.change(w.id, (w) => {
      decide(w, "101", next.id, true);
      const pending = w.approvals.find((item) => item.id === next.id);
      requireThat(pending, "missing fixture approval");
      pending.issue = {
        state: "sending",
        startedAt: new Date(Date.now() - 120000).toISOString(),
      };
    });
    const restarted = provider();
    await restarted.service.send(w.id, next.id);
    expect(restarted.requests).toHaveLength(0);
    expect((await readApproval(w.id, next))?.issue?.state).toBe("unknown");
  });

  test("GitHub rejection, disabled issues, and server errors have safe durable outcomes", async () => {
    for (const [status, state] of [
      [403, "failed"],
      [410, "failed"],
      [422, "failed"],
      [503, "unknown"],
    ] as const) {
      const { w, run } = await fixture();
      const a = await proposal(w, run.id);
      await store.change(w.id, (w) => decide(w, "101", a.id, true));
      const { service, requests } = provider(async () =>
        Response.json({ message: "private" }, { status }),
      );
      await service.send(w.id, a.id);
      await service.send(w.id, a.id);
      expect((await readApproval(w.id, a))?.issue?.state).toBe(state);
      expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(1);
      expect(JSON.stringify(await store.read(w.id))).not.toContain('"private"');
    }
  });

  test("workspace deletion purges issue drafts, results and delivery content", async () => {
    const { w, run } = await fixture();
    await proposal(w, run.id);
    await store.change(w.id, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "none",
      };
      sweep(w);
    });
    expect((await store.read(w.id)).approvals).toHaveLength(0);
  });
});
