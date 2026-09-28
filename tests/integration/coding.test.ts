import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { codingExtension } from "../../src/coding/extension.ts";
import { CodingGitHub } from "../../src/coding/github.ts";
import type {
  LocalRunner,
  LocalStart,
  LocalStatus,
} from "../../src/coding/local/protocol.ts";
import { proposeCoding } from "../../src/coding/policy.ts";
import { CodingService, saveCoding } from "../../src/coding/service.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { decide } from "../../src/workflows/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Codex workflow durability", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `deepx_coding_${randomUUID().replaceAll("-", "")}`;
  const operatorId = randomUUID();
  let store: Store;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(present(url));
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'coding','unused',true)",
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
  async function fixture(backend?: "podman") {
    const w = workspace();
    w.operatorId = operatorId;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [{ id: 7001, full_name: "example/workspace" }],
    };
    w.coding = {
      revision: 1,
      settings: {
        enabled: true,
        backend,
        repositories: [
          {
            repositoryId: 7001,
            baseBranch: "develop",
            workflowFile: "deepx-codex.yml",
            ...(backend ? { checkCommand: "bun test" } : {}),
            maintainers: ["101"],
          },
        ],
      },
    };
    const run = createRun(w, "101", "Fix recap", "-100100", 3, "gpt-4.1-mini");
    run.status = "running";
    const a = proposeCoding(w, "101", run.id, "call", {
      repositoryId: 7001,
      title: "Fix recap",
      body: "Include last message",
    });
    decide(w, "101", a.id, true);
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    return { id: w.id, taskId: a.id };
  }
  async function ready(id: string) {
    await store.change(id, (w) => {
      present(w.codingTasks?.[0]).nextPollAt = undefined;
    });
  }
  async function read(id: string) {
    return present((await store.read(id)).codingTasks?.[0]);
  }
  function provider(
    taskId: string,
    options: {
      issueStatus?: number;
      dispatchStatus?: number;
      complete?: boolean;
      onToken?: () => Promise<void>;
      local?: LocalRunner;
    } = {},
  ) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fallback = githubTransport();
    const transport = (async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/access_tokens")) await options.onToken?.();
      if (url.endsWith("/issues"))
        return Response.json(
          { number: 42 },
          { status: options.issueStatus ?? 201 },
        );
      if (url.endsWith("/dispatches"))
        return options.dispatchStatus
          ? new Response(null, { status: options.dispatchStatus })
          : new Response(null, { status: 204 });
      if (url.endsWith("/cancel")) return new Response(null, { status: 202 });
      if (
        url.includes("/actions/") &&
        (url.includes("/runs?") || url.endsWith("/runs/81"))
      ) {
        const run = {
          id: 81,
          display_title: `deepx-coding:${taskId}`,
          event: "workflow_dispatch",
          head_branch: "develop",
          status: options.complete ? "completed" : "in_progress",
          conclusion: options.complete ? "success" : null,
        };
        return Response.json(
          url.endsWith("/runs/81") ? run : { workflow_runs: [run] },
        );
      }
      if (url.includes("/pulls?"))
        return Response.json([
          {
            number: 43,
            body: "Implements https://github.com/example/workspace/issues/42",
            head: {
              ref: `codex/deepx-${taskId}`,
              repo: { full_name: "example/workspace" },
            },
            base: { ref: "develop" },
          },
        ]);
      return fallback(input, init);
    }) as typeof fetch;
    return {
      requests,
      service: new CodingService(
        store,
        new GitHubApps(
          store,
          "ab".repeat(32),
          new GitHubApp(githubFixtureConfig, transport),
        ),
        new CodingGitHub(transport),
        options.local,
        "ab".repeat(32),
      ),
    };
  }
  test("real Pi extension registers coding tools and enforces maintainer identity", async () => {
    const { id } = await fixture();
    for (const actor of ["101", "202"]) {
      const run = await store.change(id, (w) => {
        const run = createRun(
          w,
          actor,
          "Implement fix",
          actor,
          0,
          "gpt-4.1-mini",
        );
        run.status = "running";
        return structuredClone(run);
      });
      const input: AgentInput = {
        workspaceId: id,
        actor,
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
      const catalog = ExtensionCatalog.fromSnapshot(
        [],
        [codingExtension(store, await store.read(id))],
      );
      const host = present(await catalog.open(input));
      try {
        const tool = present(
          host.tools.find((t) => t.name === "propose_coding_task"),
        );
        const action = tool.execute(
          "coding-call",
          { repositoryId: 7001, title: "Fix bug", body: "Add regression test" },
          input.signal,
        );
        if (actor === "101") {
          await action;
          await tool.execute(
            "coding-call",
            {
              repositoryId: 7001,
              title: "Fix bug",
              body: "Add regression test",
            },
            input.signal,
          );
          const w = await store.read(id);
          expect(w.approvals.filter((a) => a.runId === run.id)).toHaveLength(1);
          expect(w.codingTasks).toHaveLength(1); // Only the previously approved fixture task.
        } else {
          await expect(action).rejects.toThrow("extension_tool_failed");
          expect(
            (await store.read(id)).approvals.filter((a) => a.runId === run.id),
          ).toHaveLength(0);
        }
      } finally {
        await host.close();
      }
    }
  });
  test("concurrent workers create one issue and dispatch once, then report a validated PR", async () => {
    const { id, taskId } = await fixture();
    const { service, requests } = provider(taskId, { complete: true });
    await Promise.all([
      service.advance(id, taskId),
      service.advance(id, taskId),
    ]);
    expect((await read(id)).state).toBe("issue_created");
    await ready(id);
    await Promise.all([
      service.advance(id, taskId),
      service.advance(id, taskId),
    ]);
    expect((await read(id)).state).toBe("running");
    await ready(id);
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("succeeded");
    expect((await read(id)).prUrl).toBe(
      "https://github.com/example/workspace/pull/43",
    );
    expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(1);
    const dispatches = requests.filter((r) => r.url.endsWith("/dispatches"));
    expect(dispatches).toHaveLength(1);
    expect(JSON.parse(String(present(dispatches[0]).init.body))).toMatchObject({
      ref: "refs/heads/develop",
      inputs: { task_id: taskId, issue_number: "42" },
    });
    expect(
      (await store.read(id)).deliveries.some(
        (d) => d.text.includes("/pull/43") && d.topicId === 3,
      ),
    ).toBe(true);
    expect(JSON.stringify(await store.read(id))).not.toContain("ghs_fixture");
    await ready(id);
    await service.advance(id, taskId);
    expect(requests.filter((r) => r.url.endsWith("/dispatches"))).toHaveLength(
      1,
    );
  });
  test("permission changes during token minting prevent external submission", async () => {
    const { id, taskId } = await fixture();
    const { service, requests } = provider(taskId, {
      onToken: async () => {
        await store.change(id, (w) => {
          present(present(w.coding).settings.repositories[0]).maintainers = [];
        });
      },
    });
    await service.advance(id, taskId);
    expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(0);
    expect((await read(id)).state).toBe("failed");
  });
  test("ambiguous issue or dispatch is never replayed", async () => {
    for (const phase of ["issue", "dispatch"]) {
      const { id, taskId } = await fixture();
      const { service, requests } = provider(
        taskId,
        phase === "issue" ? { issueStatus: 503 } : { dispatchStatus: 503 },
      );
      await service.advance(id, taskId);
      if (phase === "dispatch") {
        await ready(id);
        await service.advance(id, taskId);
      }
      expect((await read(id)).state).toBe("unknown");
      await ready(id);
      await service.advance(id, taskId);
      expect(
        requests.filter((r) =>
          r.url.endsWith(phase === "issue" ? "/issues" : "/dispatches"),
        ),
      ).toHaveLength(1);
    }
  });
  test("stale POST reservations become unknown without a network call", async () => {
    for (const state of ["creating_issue", "dispatching"] as const) {
      const { id, taskId } = await fixture();
      await store.change(id, (w) => {
        const t = present(w.codingTasks?.[0]);
        t.state = state;
        t.updatedAt = new Date(Date.now() - 180000).toISOString();
      });
      const { service, requests } = provider(taskId);
      await service.advance(id, taskId);
      expect((await read(id)).state).toBe("unknown");
      expect(requests).toHaveLength(0);
    }
  });
  test("configuration revocation requests remote cancellation once", async () => {
    const { id, taskId } = await fixture();
    const { service, requests } = provider(taskId);
    await service.advance(id, taskId);
    await ready(id);
    await service.advance(id, taskId);
    await store.change(id, (w) => {
      present(w.coding).settings.enabled = false;
    });
    await ready(id);
    await service.advance(id, taskId);
    expect((await read(id)).cancellationSent).toBe(true);
    await ready(id);
    await service.advance(id, taskId);
    expect(requests.filter((r) => r.url.endsWith("/cancel"))).toHaveLength(1);
  });
  test("another workspace cannot execute the task; queued cancellation does not contact GitHub", async () => {
    const { id, taskId } = await fixture();
    const other = await fixture();
    const { service, requests } = provider(taskId);
    await service.advance(other.id, taskId);
    expect(requests).toHaveLength(0);
    await store.change(id, (w) => {
      present(w.codingTasks?.[0]).cancelRequested = true;
    });
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("cancelled");
    expect(requests).toHaveLength(0);
  });
  function localFixture() {
    const calls: string[] = [];
    let state: LocalStatus = { state: "running" };
    const runner: LocalRunner = {
      async start() {
        calls.push("start");
      },
      async status() {
        calls.push("status");
        return state;
      },
      async publish() {
        calls.push("publish");
        state = { state: "publishing" };
      },
      async cancel() {
        calls.push("cancel");
        state = { state: "cancelled" };
      },
    };
    return {
      runner,
      calls,
      set: (value: LocalStatus) => {
        state = value;
      },
    };
  }
  test("Podman tasks retain approval and duplicate protection through fresh publication", async () => {
    const { id, taskId } = await fixture("podman");
    const local = localFixture();
    const { service, requests } = provider(taskId, { local: local.runner });
    await service.advance(id, taskId);
    await ready(id);
    await Promise.all([
      service.advance(id, taskId),
      service.advance(id, taskId),
    ]);
    expect(local.calls.filter((c) => c === "start")).toHaveLength(1);
    local.set({ state: "ready", threadId: "thread-123" });
    await ready(id);
    await Promise.all([
      service.advance(id, taskId),
      service.advance(id, taskId),
    ]);
    expect((await read(id)).state).toBe("publishing");
    expect(local.calls.filter((c) => c === "publish")).toHaveLength(1);
    const permissions = requests
      .filter((r) => r.url.endsWith("/access_tokens"))
      .map((r) => JSON.parse(String(r.init.body)).permissions);
    expect(permissions).toContainEqual({ contents: "read" });
    expect(permissions).toContainEqual({
      contents: "write",
      pull_requests: "write",
    });
    expect(requests.some((r) => r.url.includes("/actions/"))).toBe(false);
    local.set({
      state: "succeeded",
      prUrl: "https://github.com/example/workspace/pull/43",
      threadId: "thread-123",
    });
    await ready(id);
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("succeeded");
    expect((await read(id)).threadId).toBe("thread-123");
  });
  test("worker sends only the owning workspace's decrypted key to its local runner", async () => {
    const { id, taskId } = await fixture("podman");
    await store.change(id, (w) => {
      present(w.coding).providerApiKey = encrypt(
        "ab".repeat(32),
        `coding-provider:${id}`,
        "workspace-provider-secret",
      );
    });
    let started: LocalStart | undefined;
    const local = localFixture();
    local.runner.start = async (input) => {
      started = input;
    };
    const { service } = provider(taskId, { local: local.runner });
    await service.advance(id, taskId);
    await ready(id);
    await service.advance(id, taskId);
    expect(present(started).providerApiKey).toBe("workspace-provider-secret");
    expect(present(started).workspaceId).toBe(id);
    expect(JSON.stringify(present(started).payload)).not.toContain(
      "workspace-provider-secret",
    );
    expect(JSON.stringify(await store.read(id))).not.toContain(
      "workspace-provider-secret",
    );
    expect((await read(id)).state).toBe("running");
    await store.change(id, (w) => {
      const config = present(w.coding);
      saveCoding(
        w,
        { id: operatorId, operator: true, username: "coding" },
        {
          revision: config.revision,
          settings: config.settings,
          providerApiKey: "rotated-secret",
        },
        "ab".repeat(32),
      );
    });
    await ready(id);
    await service.advance(id, taskId);
    expect(local.calls).toContain("cancel");
    expect(local.calls).not.toContain("publish");
    expect((await read(id)).state).toBe("cancelled");
  });
  test("Podman publication rechecks authority after minting write credentials", async () => {
    const { id, taskId } = await fixture("podman");
    const local = localFixture();
    let revoke = false;
    const { service } = provider(taskId, {
      local: local.runner,
      onToken: async () => {
        if (revoke)
          await store.change(id, (w) => {
            present(w.coding).settings.enabled = false;
          });
      },
    });
    await service.advance(id, taskId);
    await ready(id);
    await service.advance(id, taskId);
    local.set({ state: "ready" });
    revoke = true;
    await ready(id);
    await service.advance(id, taskId);
    expect(local.calls).not.toContain("publish");
    expect(local.calls).toContain("cancel");
    expect((await read(id)).state).toBe("cancelled");
  });
  test("revoked local tasks cancel without GitHub credentials; ambiguous publication is not replayed", async () => {
    const { id, taskId } = await fixture("podman");
    const local = localFixture();
    const { service, requests } = provider(taskId, { local: local.runner });
    await service.advance(id, taskId);
    await ready(id);
    await service.advance(id, taskId);
    requests.splice(0);
    await store.change(id, (w) => {
      present(w.coding).settings.enabled = false;
    });
    await ready(id);
    await service.advance(id, taskId);
    expect(local.calls).toContain("cancel");
    expect(requests).toHaveLength(0);
    expect((await read(id)).state).toBe("cancelled");
    const g = await fixture("podman");
    const failed = localFixture();
    failed.runner.publish = async () => {
      failed.calls.push("publish");
      throw new Error("network reset");
    };
    const second = provider(g.taskId, { local: failed.runner }).service;
    await second.advance(g.id, g.taskId);
    await ready(g.id);
    await second.advance(g.id, g.taskId);
    failed.set({ state: "ready" });
    await ready(g.id);
    await second.advance(g.id, g.taskId);
    expect((await read(g.id)).state).toBe("unknown");
    await ready(g.id);
    await second.advance(g.id, g.taskId);
    expect(failed.calls.filter((c) => c === "publish")).toHaveLength(1);
  });
});
