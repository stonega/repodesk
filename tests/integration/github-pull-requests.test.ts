import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { emptyCoding } from "../../src/coding/config.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { requireThat, type Workspace } from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { githubExtension } from "../../src/github/extension.ts";
import { GitHubPullRequests } from "../../src/github/pull-requests.ts";
import { invalidateGitHubWork } from "../../src/github/user-access.ts";
import { sweep } from "../../src/privacy/service.ts";
import { decide } from "../../src/workflows/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("GitHub PR actions", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `repodesk_pulls_${randomUUID().replaceAll("-", "")}`;
  const operatorId = randomUUID();
  let store: Store;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'pulls','unused',true)",
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
  const args = {
    repositoryId: 7001,
    number: 233,
    action: "merge" as const,
    mergeMethod: "squash" as const,
  };
  const signal = () => new AbortController().signal;
  const guard = async () => {};
  async function fixture(actor = "101", chatId = actor, privateRepo = true) {
    const w = workspace();
    w.operatorId = operatorId;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [
        { id: 7001, full_name: "example/workspace", private: privateRepo },
      ],
    };
    const run = createRun(w, actor, "Merge PR 233", chatId, 3, "gpt-4.1-mini");
    run.status = "running";
    run.fence = 1;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    return { w, run };
  }
  function provider(
    options: {
      write?: () => Promise<Response>;
      onToken?: () => Promise<void>;
      onRead?: () => Promise<void>;
      missingPermission?: boolean;
    } = {},
  ) {
    const requests: { url: string; init: RequestInit }[] = [];
    const pull = {
      number: 233,
      title: "Remove Renovate",
      state: "open",
      merged: false,
      draft: false,
      head: { sha: "a".repeat(40) },
      base: { ref: "main", repo: { id: 7001, full_name: "example/workspace" } },
    };
    const fallback = githubTransport();
    const app = new GitHubApp(githubFixtureConfig, (async (
      input,
      init = {},
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/access_tokens")) {
        await options.onToken?.();
        if (options.missingPermission)
          return Response.json(
            {
              message:
                "Permissions requested are not granted to this installation.",
            },
            { status: 422 },
          );
      }
      if (url.endsWith("/pulls/233") && init.method === "GET") {
        await options.onRead?.();
        return Response.json(pull);
      }
      if (init.method === "PUT" || init.method === "PATCH")
        return options.write
          ? options.write()
          : Response.json(
              init.method === "PUT"
                ? { merged: true }
                : { ...pull, state: "closed" },
            );
      return fallback(input, init);
    }) as typeof fetch);
    return {
      app,
      pull,
      requests,
      service: new GitHubPullRequests(store, app),
      writes: () =>
        requests.filter((r) => ["PUT", "PATCH"].includes(r.init.method ?? "")),
    };
  }
  async function proposal(
    f: Awaited<ReturnType<typeof fixture>>,
    p: ReturnType<typeof provider>,
    input: object = args,
    callId = "call1",
  ) {
    return p.service.propose(
      f.w.id,
      f.run.id,
      callId,
      input,
      1,
      signal(),
      guard,
    );
  }
  const saved = async (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
    (await store.read(f.w.id)).approvals.find((a) => a.id === id);
  const approve = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
    store.change(f.w.id, (w) => decide(w, f.run.actor, id, true));

  test("Pi exposes a proposal tool, reads with PR-only scope and delivers one exact review", async () => {
    const f = await fixture();
    const p = provider();
    requireThat(f.w.github, "missing fixture connection");
    const input: AgentInput = {
      workspaceId: f.w.id,
      actor: "101",
      runId: f.run.id,
      model: selectedModel("gpt-4.1-mini"),
      apiKey: "fake",
      system: "",
      prompt: "",
      transcript: [],
      tools: [],
      maxTurns: 2,
      maxTools: 3,
      signal: signal(),
      guard,
      reserve: async () => "attempt",
      checkpoint: async () => {},
    };
    const catalog = ExtensionCatalog.fromSnapshot(
      [],
      [githubExtension(store, f.w.id, f.w.github, undefined, p.service)],
    );
    const host = await catalog.open(input);
    try {
      const tool = host?.tools.find(
        (t) => t.name === "propose_github_pull_request_action",
      );
      requireThat(tool, "missing PR action tool");
      await tool.execute("call1", args, input.signal);
      const reads = p.requests.length;
      await tool.execute("call1", args, input.signal);
      expect(p.requests).toHaveLength(reads);
      expect(p.writes()).toHaveLength(0);
      expect(JSON.parse(String(p.requests[0]?.init.body))).toEqual({
        repository_ids: [7001],
        permissions: { pull_requests: "read" },
      });
      const current = await store.read(f.w.id);
      expect(current.approvals).toHaveLength(1);
      expect(current.deliveries).toHaveLength(1);
      expect(current.runs[0]?.githubRead?.repositoryIds).toEqual([7001]);
      const review = current.deliveries[0];
      expect(review?.text).toContain("example/workspace#233");
      expect(review?.text).toContain("Target branch: main");
      expect(review?.text).toContain("Merge method: squash");
      expect(review?.text).toContain("a".repeat(40));
      expect(review?.topicId).toBe(3);
      expect(review?.buttons?.[0]?.map((b) => b.text)).toEqual([
        "Approve",
        "Reject",
      ]);
      await expect(
        tool.execute(
          "call1",
          { ...args, action: "close", mergeMethod: undefined },
          input.signal,
        ),
      ).rejects.toThrow("extension_tool_failed");
      await expect(tool.execute("call2", args, input.signal)).rejects.toThrow(
        "extension_tool_failed",
      );
      await expect(
        proposal(f, p, { ...args, mergeMethod: "rebase" }),
      ).rejects.toThrow("tool_call_conflict");
      await expect(proposal(f, p, args, "another-call")).rejects.toThrow(
        "resolve_existing_proposal_first",
      );
    } finally {
      await host?.close();
    }
  });

  test("the default agent loads GitHub tools and bundled skill for an existing workspace without catalog or plugin setup", async () => {
    const f = await fixture();
    const p = provider();
    const originalSkills = (await store.read(f.w.id)).skills;
    const requests: Record<string, unknown>[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as Record<string, unknown>);
        const chunk = {
          id: "github-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture/github",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Ready" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const input: AgentInput = {
      workspaceId: f.w.id,
      actor: "101",
      runId: f.run.id,
      model: selectedModel("fixture/github", {
        modelBaseUrl: `http://127.0.0.1:${server.port}/v1`,
        modelPricing: { input: 0, output: 0 },
        modelLimits: { contextWindow: 128000, maxOutputTokens: 512 },
      }),
      apiKey: "fake",
      system: "Original policy.",
      prompt: "Can you merge this PR?",
      transcript: [],
      tools: [],
      maxTurns: 2,
      maxTools: 3,
      signal: signal(),
      guard,
      reserve: async () => "attempt",
      checkpoint: async () => {},
    };
    const plugins = new PluginService(store, undefined, undefined, p.app);
    try {
      const runner = await plugins.runner(await store.deployment(), f.w.id);
      expect((await runner.run(input)).text).toBe("Ready");
      const tools = requests[0]?.tools as { function: { name: string } }[];
      expect(tools.map((t) => t.function.name).sort()).toEqual(
        [
          "find_connected_repository",
          "propose_github_issue",
          "propose_github_pull_request_action",
          "query_github_metadata",
        ].sort(),
      );
      const messages = JSON.stringify(requests[0]?.messages);
      expect(messages).toContain("Original policy.");
      expect(messages).toContain("# RepoDesk GitHub");
      expect(messages).toContain("GitHub work is RepoDesk's primary workflow");
      expect(messages).toContain("older replies saying a tool was unavailable");
      expect((await store.read(f.w.id)).skills).toEqual(originalSkills);
      expect((await store.read(f.w.id)).plugins).toBeUndefined();
      expect(p.requests).toHaveLength(0);
      await store.change(f.w.id, (w) => {
        w.github = { revision: 2, repositories: [] };
      });
      const disconnected = await plugins.runner(
        await store.deployment(),
        f.w.id,
      );
      await disconnected.run(input);
      expect(JSON.stringify(requests[1]?.tools ?? [])).not.toContain(
        "propose_github_pull_request_action",
      );
      expect(JSON.stringify(requests[1]?.messages)).not.toContain(
        "# RepoDesk GitHub",
      );
    } finally {
      await server.stop(true);
    }
  });

  test("one approved merge uses the reviewed SHA and method; duplicates and concurrent workers never repeat it", async () => {
    const f = await fixture();
    const p = provider();
    const id = await proposal(f, p);
    await p.service.send(f.w.id, id);
    expect(p.writes()).toHaveLength(0);
    await approve(f, id);
    await Promise.all([p.service.send(f.w.id, id), p.service.send(f.w.id, id)]);
    await p.service.send(f.w.id, id);
    expect(p.writes()).toHaveLength(1);
    expect(p.writes()[0]?.url).toEndWith("/pulls/233/merge");
    expect(JSON.parse(String(p.writes()[0]?.init.body))).toEqual({
      sha: "a".repeat(40),
      merge_method: "squash",
    });
    expect(p.writes()[0]?.init.redirect).toBe("error");
    const tokens = p.requests
      .filter((r) => r.url.endsWith("/access_tokens"))
      .slice(1);
    for (const t of tokens)
      expect(JSON.parse(String(t.init.body))).toEqual({
        repository_ids: [7001],
        permissions: { contents: "write", pull_requests: "read" },
      });
    expect((await saved(f, id))?.pullRequest?.state).toBe("merged");
    const current = await store.read(f.w.id);
    expect(current.deliveries.at(-1)?.text).toBe(
      "PR merged: https://github.com/example/workspace/pull/233",
    );
    expect(JSON.stringify(current)).not.toContain("ghs_fixture");
  });

  test("Pi receives actionable permission and draft guidance without private diagnostics", async () => {
    for (const missingPermission of [true, false]) {
      const f = await fixture();
      const p = provider({ missingPermission });
      if (!missingPermission) p.pull.draft = true;
      requireThat(f.w.github, "missing connection");
      const input: AgentInput = {
        workspaceId: f.w.id,
        actor: "101",
        runId: f.run.id,
        model: selectedModel("gpt-4.1-mini"),
        apiKey: "fake",
        system: "",
        prompt: "",
        transcript: [],
        tools: [],
        maxTurns: 2,
        maxTools: 3,
        signal: signal(),
        guard,
        reserve: async () => "attempt",
        checkpoint: async () => {},
      };
      const host = await ExtensionCatalog.fromSnapshot(
        [],
        [githubExtension(store, f.w.id, f.w.github, undefined, p.service)],
      ).open(input);
      try {
        const tool = host?.tools.find(
          (t) => t.name === "propose_github_pull_request_action",
        );
        requireThat(tool, "missing PR tool");
        const result = JSON.stringify(
          await tool.execute("blocked", args, input.signal),
        );
        expect(result).toContain("not_proposed");
        expect(result).toContain(
          missingPermission
            ? "accept the updated installation permissions"
            : "Mark it ready for review",
        );
        expect(result).not.toContain("ghs_fixture");
        expect((await store.read(f.w.id)).approvals).toHaveLength(0);
      } finally {
        await host?.close();
      }
    }
  });

  test("malformed or contradictory mutation responses cannot claim success or trigger retries", async () => {
    for (const [action, response, state] of [
      ["merge", { merged: false }, "failed"],
      ["merge", {}, "unknown"],
      ["close", { number: 234, state: "closed", merged: false }, "unknown"],
      ["close", { number: 233, state: "closed", merged: true }, "unknown"],
    ] as const) {
      const f = await fixture();
      const p = provider({ write: async () => Response.json(response) });
      const id = await proposal(
        f,
        p,
        action === "merge" ? args : { repositoryId: 7001, number: 233, action },
      );
      await approve(f, id);
      await p.service.send(f.w.id, id);
      await p.service.send(f.w.id, id);
      expect(p.writes()).toHaveLength(1);
      expect((await saved(f, id))?.pullRequest?.state).toBe(state);
    }
  });

  test("closing uses only PR write, no merge or branch deletion", async () => {
    const f = await fixture();
    const p = provider();
    p.pull.draft = true;
    const id = await proposal(f, p, {
      repositoryId: 7001,
      number: 233,
      action: "close",
    });
    expect((await store.read(f.w.id)).deliveries[0]?.text).toContain(
      "without merging or deleting",
    );
    await approve(f, id);
    await p.service.send(f.w.id, id);
    expect(p.writes()).toHaveLength(1);
    expect(p.writes()[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(p.writes()[0]?.init.body))).toEqual({
      state: "closed",
    });
    expect(
      JSON.parse(
        String(
          p.requests.findLast((r) => r.url.endsWith("/access_tokens"))?.init
            .body,
        ),
      ),
    ).toEqual({
      repository_ids: [7001],
      permissions: { pull_requests: "write" },
    });
    expect((await saved(f, id))?.pullRequest?.state).toBe("closed");
  });

  test("approval checks actor, exact payload, expiry, current connection and rejection", async () => {
    const f = await fixture();
    const p = provider();
    const id = await proposal(f, p);
    await expect(
      store.change(f.w.id, (w) => decide(w, "303", id, true)),
    ).rejects.toThrow("approval_denied");
    await expect(
      store.change(f.w.id, (w) => {
        (w.approvals[0]?.payload as { mergeMethod: string }).mergeMethod =
          "rebase";
        decide(w, "101", id, true);
      }),
    ).rejects.toThrow("approval_changed");
    await expect(
      store.change(f.w.id, (w) => {
        requireThat(w.approvals[0], "missing approval");
        w.approvals[0].expiresAt = new Date(0).toISOString();
        decide(w, "101", id, true);
      }),
    ).rejects.toThrow("approval_expired");
    await expect(
      store.change(f.w.id, (w) => {
        requireThat(w.github, "missing connection");
        w.github.revision++;
        decide(w, "101", id, true);
      }),
    ).rejects.toThrow("version_conflict");
    await store.change(f.w.id, (w) => decide(w, "101", id, false));
    await p.service.send(f.w.id, id);
    expect(p.writes()).toHaveLength(0);
    await expect(approve(f, id)).rejects.toThrow("approval_consumed");
  });

  test("ordinary members, linked read-only actors, other repositories, private groups and schedules cannot propose", async () => {
    const member = await fixture("202");
    const p = provider();
    await expect(proposal(member, p)).rejects.toThrow(
      "github_pr_maintainer_required",
    );
    const owner = await fixture();
    await store.change(owner.w.id, (w) => {
      requireThat(w.members[0], "missing owner");
      w.members[0].github = {
        id: 42,
        login: "owner",
        status: "connected",
        connectionRevision: 1,
        syncedAt: new Date().toISOString(),
        repositories: [
          {
            id: 7001,
            full_name: "example/workspace",
            permissions: { pull: true, push: false, admin: false },
          },
        ],
      };
    });
    await expect(proposal(owner, p)).rejects.toThrow(
      "github_user_access_denied",
    );
    const other = await fixture();
    await expect(
      proposal(other, p, { ...args, repositoryId: 7002 }),
    ).rejects.toThrow("github_repository_not_connected");
    const group = await fixture("101", "-100100");
    await expect(proposal(group, p)).rejects.toThrow(
      "github_metadata_scope_denied",
    );
    const schedule = await fixture();
    await store.change(schedule.w.id, (w) => {
      requireThat(w.runs[0], "missing run");
      w.runs[0].workflowId = "schedule";
    });
    await expect(proposal(schedule, p)).rejects.toThrow("tool_policy_denied");
    expect(p.requests).toHaveLength(0);
  });

  test("configured maintainers with fresh upstream write access can propose; removing that grant stops execution", async () => {
    const f = await fixture("202");
    const p = provider();
    await store.change(f.w.id, (w) => {
      w.coding = {
        revision: 1,
        settings: {
          ...emptyCoding,
          enabled: true,
          repositories: [
            { repositoryId: 7001, baseBranch: "main", maintainers: ["202"] },
          ],
        },
      };
      const member = w.members.find((m) => m.id === "202");
      requireThat(member, "missing member");
      member.github = {
        id: 43,
        login: "maintainer",
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
    });
    const id = await proposal(f, p);
    await approve(f, id);
    await store.change(f.w.id, (w) => {
      requireThat(w.coding, "missing coding settings");
      w.coding.settings.repositories = [];
    });
    await p.service.send(f.w.id, id);
    expect(p.writes()).toHaveLength(0);
    expect((await saved(f, id))?.pullRequest?.error).toBe(
      "github_pr_maintainer_required",
    );
  });

  test("draft merges, closed PRs and mismatched PR destinations cannot produce a review", async () => {
    for (const change of [
      (p: ReturnType<typeof provider>) => {
        p.pull.draft = true;
      },
      (p: ReturnType<typeof provider>) => {
        p.pull.state = "closed";
      },
      (p: ReturnType<typeof provider>) => {
        p.pull.number = 234;
      },
      (p: ReturnType<typeof provider>) => {
        p.pull.base.repo.id = 7002;
      },
    ]) {
      const f = await fixture();
      const p = provider();
      change(p);
      await expect(proposal(f, p)).rejects.toThrow();
      expect((await store.read(f.w.id)).approvals).toHaveLength(0);
      expect(p.writes()).toHaveLength(0);
    }
  });

  test("changed heads, targets, titles, closed or draft PRs fail before mutation", async () => {
    for (const change of [
      (p: ReturnType<typeof provider>) => {
        p.pull.head.sha = "b".repeat(40);
      },
      (p: ReturnType<typeof provider>) => {
        p.pull.base.ref = "release";
      },
      (p: ReturnType<typeof provider>) => {
        p.pull.title = "Changed scope";
      },
      (p: ReturnType<typeof provider>) => {
        p.pull.merged = true;
      },
      (p: ReturnType<typeof provider>) => {
        p.pull.draft = true;
      },
    ]) {
      const f = await fixture();
      const p = provider();
      const id = await proposal(f, p);
      await approve(f, id);
      change(p);
      await p.service.send(f.w.id, id);
      expect(p.writes()).toHaveLength(0);
      expect((await saved(f, id))?.pullRequest?.state).toBe("failed");
    }
  });

  test("tenant isolation and revocation during token minting or PR reading stop writes", async () => {
    const f = await fixture();
    const p = provider();
    const id = await proposal(f, p);
    await approve(f, id);
    const other = await fixture();
    const isolated = provider();
    await isolated.service.send(other.w.id, id);
    expect(isolated.requests).toHaveLength(0);
    for (const hook of ["onToken", "onRead"] as const) {
      const f = await fixture();
      const p = provider();
      const id = await proposal(f, p);
      await approve(f, id);
      const revoked = provider({
        [hook]: async () => {
          await store.change(f.w.id, (w) => {
            requireThat(w.members[0], "missing owner");
            w.members[0].active = false;
          });
        },
      });
      await revoked.service.send(f.w.id, id);
      expect(revoked.writes()).toHaveLength(0);
      expect((await saved(f, id))?.pullRequest?.state).toBe("failed");
    }
  });

  test("cancellation, role changes, disconnect and deployment pause stop approved actions", async () => {
    for (const revoke of [
      (w: Workspace) => {
        requireThat(w.runs[0], "missing run");
        w.runs[0].cancelled = true;
      },
      (w: Workspace) => {
        requireThat(w.members[0], "missing owner");
        w.members[0].role = "member";
      },
      (w: Workspace) => {
        w.github = { revision: 2, repositories: [] };
      },
      (w: Workspace) => {
        w.settings.paused = true;
      },
    ]) {
      const f = await fixture();
      const p = provider();
      const id = await proposal(f, p);
      await approve(f, id);
      await store.change(f.w.id, revoke);
      await p.service.send(f.w.id, id);
      expect(p.writes()).toHaveLength(0);
    }
    const f = await fixture();
    const p = provider();
    const id = await proposal(f, p);
    await approve(f, id);
    await store.pool.query(
      "UPDATE deployment SET data=jsonb_set(data,'{paused}','true')",
    );
    try {
      await p.service.send(f.w.id, id);
      expect(p.writes()).toHaveLength(0);
    } finally {
      await store.pool.query(
        "UPDATE deployment SET data=jsonb_set(data,'{paused}','false')",
      );
    }
  });

  test("missing installation grants explain the GitHub permission update", async () => {
    const f = await fixture();
    const p = provider();
    const id = await proposal(f, p);
    await approve(f, id);
    const denied = provider({ missingPermission: true });
    await denied.service.send(f.w.id, id);
    expect(denied.writes()).toHaveLength(0);
    expect((await saved(f, id))?.pullRequest?.error).toBe(
      "github_app_permissions_missing",
    );
    expect((await store.read(f.w.id)).deliveries.at(-1)?.text).toContain(
      "accept the updated installation permissions",
    );
  });

  test("GitHub rejections and ambiguous outcomes are safe, durable and never retried", async () => {
    for (const [status, state, code] of [
      [403, "failed", "github_pr_access_denied"],
      [405, "failed", "github_pr_not_mergeable"],
      [409, "failed", "github_pr_changed"],
      [422, "failed", "github_pr_rejected"],
      [503, "unknown", "github_pr_outcome_unknown"],
    ] as const) {
      const f = await fixture();
      const p = provider({
        write: async () =>
          Response.json({ message: "private diagnostic" }, { status }),
      });
      const id = await proposal(f, p);
      await approve(f, id);
      await p.service.send(f.w.id, id);
      await p.service.send(f.w.id, id);
      expect(p.writes()).toHaveLength(1);
      expect((await saved(f, id))?.pullRequest).toMatchObject({
        state,
        error: code,
      });
      expect(JSON.stringify(await store.read(f.w.id))).not.toContain(
        "private diagnostic",
      );
    }
    const f = await fixture();
    const p = provider({
      write: async () => {
        throw new Error("private timeout");
      },
    });
    const id = await proposal(f, p);
    await approve(f, id);
    await p.service.send(f.w.id, id);
    const restarted = provider();
    await restarted.service.send(f.w.id, id);
    expect(restarted.requests).toHaveLength(0);
    expect((await saved(f, id))?.pullRequest?.state).toBe("unknown");
  });

  test("interrupted reservations are reconciled as unknown without sending again", async () => {
    const f = await fixture();
    const p = provider();
    const id = await proposal(f, p);
    await approve(f, id);
    await store.change(f.w.id, (w) => {
      requireThat(w.approvals[0], "missing approval");
      w.approvals[0].pullRequest = {
        state: "sending",
        startedAt: new Date(Date.now() - 120000).toISOString(),
      };
    });
    const restarted = provider();
    await restarted.service.send(f.w.id, id);
    expect(restarted.requests).toHaveLength(0);
    expect((await saved(f, id))?.pullRequest?.state).toBe("unknown");
  });

  test("GitHub disconnect revokes pending PR approvals and deletion purges records", async () => {
    const f = await fixture();
    const p = provider();
    const id = await proposal(f, p);
    await approve(f, id);
    await store.change(f.w.id, (w) => invalidateGitHubWork(w, "101"));
    expect((await saved(f, id))?.decision).toBe("revoked");
    await p.service.send(f.w.id, id);
    expect(p.writes()).toHaveLength(0);
    await store.change(f.w.id, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "none",
      };
      sweep(w);
    });
    expect((await store.read(f.w.id)).approvals).toHaveLength(0);
  });
});
