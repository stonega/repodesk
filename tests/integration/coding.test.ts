import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { developmentPolicy } from "../../src/coding/development.ts";
import { codingExtension } from "../../src/coding/extension.ts";
import type {
  LocalDeviceAuth,
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
import { selectTaskControl } from "../../src/telegram/task-controls.ts";
import { decide } from "../../src/workflows/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Codex task durability", () => {
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
      "UPDATE deployment SET data=jsonb_set(jsonb_set(data,'{active}','true'),'{bot}','{\"id\":\"999\",\"username\":\"fixture\"}')",
    );
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function fixture() {
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
        backend: "podman",
        authMode: "provider_key",
        repositories: [
          {
            repositoryId: 7001,
            baseBranch: "develop",
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
  test("Reviewed task buttons show current status and retain initiator cancellation after grant removal", async () => {
    const f = await fixture();
    const queued = present(
      (await store.read(f.id)).deliveries.find(
        (d) => d.feedback?.owner === "coding" && d.feedback.id === f.taskId,
      ),
    );
    expect(queued.buttons?.[0]?.map((b) => b.text)).toEqual([
      "Status",
      "Cancel",
    ]);
    await store.change(f.id, (w) => {
      Object.assign(present(w.deliveries.find((d) => d.id === queued.id)), {
        state: "sent",
        botId: "999",
        remoteId: 2100,
      });
    });
    const tap = (data: string) =>
      store.change(f.id, (w, sql) =>
        selectTaskControl(
          sql,
          w,
          {
            update_id: 2101,
            callback_query: {
              id: "reviewed-inline",
              from: { id: 101, is_bot: false },
              data,
              message: {
                message_id: 2100,
                date: Math.floor(Date.now() / 1000),
                chat: { id: -100100, type: "supergroup" },
                message_thread_id: 3,
              },
            },
          },
          "999",
        ),
      );
    await tap(present(queued.buttons?.[0]?.[0]).callback_data);
    expect((await store.read(f.id)).deliveries.at(-1)?.text).toContain(
      "queued",
    );
    await store.change(f.id, (w) => {
      present(present(w.coding).settings.repositories[0]).maintainers = [];
    });
    await expect(
      tap(present(queued.buttons?.[0]?.[0]).callback_data),
    ).rejects.toThrow();
    await tap(present(queued.buttons?.[0]?.[1]).callback_data);
    expect((await read(f.id)).state).toBe("cancelled");
  });
  async function read(id: string) {
    return present((await store.read(id)).codingTasks?.[0]);
  }
  async function codingHost(id: string, actor = "101") {
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
    return { run, input, host: present(await catalog.open(input)) };
  }
  function provider(
    options: {
      issueStatus?: number;
      tokenStatus?: number;
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
      if (url.endsWith("/access_tokens")) {
        await options.onToken?.();
        if (options.tokenStatus)
          return Response.json(
            { message: "denied" },
            { status: options.tokenStatus },
          );
      }
      if (url.endsWith("/issues"))
        return Response.json(
          { number: 42 },
          { status: options.issueStatus ?? 201 },
        );
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
        options.local,
        "ab".repeat(32),
      ),
    };
  }
  test("automatic-check migration removes stored overrides and invalidates old grants only once", async () => {
    const { id } = await fixture();
    await store.change(id, (w) => {
      Object.assign(present(present(w.coding).settings.repositories[0]), {
        setupCommand: "exit 91",
        checkCommand: "exit 92",
      });
    });
    const before = await store.read(id);
    const migration = await readFile(
      "migrations/013_automatic_coding_checks.sql",
      "utf8",
    );
    await store.pool.query(migration);
    const migrated = await store.read(id);
    expect(migrated.coding?.settings.repositories[0]).not.toHaveProperty(
      "setupCommand",
    );
    expect(migrated.coding?.settings.repositories[0]).not.toHaveProperty(
      "checkCommand",
    );
    expect(migrated.coding?.revision).toBe(present(before.coding).revision + 1);
    expect(migrated.version).toBe(before.version + 1);
    await store.pool.query(migration);
    expect((await store.read(id)).version).toBe(migrated.version);
    await provider().service.tick(id);
    expect((await read(id)).state).toBe("cancelled");
  });
  test("real Pi extension registers coding tools and enforces maintainer identity", async () => {
    const { id } = await fixture();
    for (const actor of ["101", "202"]) {
      const { run, input, host } = await codingHost(id, actor);
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
          await expect(action).rejects.toThrow("coding_maintainer_required");
          expect(
            (await store.read(id)).approvals.filter((a) => a.runId === run.id),
          ).toHaveLength(0);
        }
      } finally {
        await host.close();
      }
    }
  });
  test("implicit and explicit Reviewed repositories expose the approval flow without direct starts", async () => {
    for (const explicit of [false, true]) {
      const { id } = await fixture();
      if (explicit)
        await store.change(id, (w) => {
          present(present(w.coding).settings.repositories[0]).development =
            developmentPolicy.parse({ executionMode: "reviewed" });
        });
      const { host } = await codingHost(id);
      try {
        expect(
          host.tools.some((t) => t.name === "start_development_task"),
        ).toBe(false);
        const proposal = present(
          host.tools.find((t) => t.name === "propose_coding_task"),
        );
        expect(proposal.description).toContain('"mode":"reviewed"');
        expect(proposal.description).toContain("Use this approval flow");
      } finally {
        await host.close();
      }
    }
  });
  test("mixed policies advertise only Direct targets and preserve policy errors before reviewed fallback", async () => {
    const { id } = await fixture();
    await store.change(id, (w) => {
      present(w.github).repositories.push({
        id: 7002,
        full_name: "example/direct",
      });
      present(w.coding).settings.repositories.push({
        repositoryId: 7002,
        baseBranch: "main",
        maintainers: ["101"],
        development: developmentPolicy.parse({ executionMode: "direct" }),
      });
    });
    const { host, input, run } = await codingHost(id);
    try {
      const start = present(
        host.tools.find((t) => t.name === "start_development_task"),
      );
      expect(start.description).toContain("example/direct");
      expect(start.description).not.toContain("example/workspace");
      const source = present(
        (await store.read(id)).messages.find((s) => s.runId === run.id),
      );
      await expect(
        start.execute(
          "rejected-start",
          { repositoryId: 7001, sourceIds: [source.id] },
          input.signal,
        ),
      ).rejects.toThrow("coding_direct_execution_disabled");
      expect(
        (
          await store.pool.query(
            "SELECT id FROM coding_tasks WHERE workspace_id=$1",
            [id],
          )
        ).rowCount,
      ).toBe(0);
      const proposal = present(
        host.tools.find((t) => t.name === "propose_coding_task"),
      );
      const approvedFlow = await proposal.execute(
        "reviewed-proposal",
        { repositoryId: 7001, title: "Implement fix", body: "Implement fix" },
        input.signal,
      );
      expect(approvedFlow.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining('"status":"awaiting_approval"'),
        },
      ]);
      const task = await start.execute(
        "direct-start",
        { repositoryId: 7002, sourceIds: [source.id] },
        input.signal,
      );
      expect(task.content).toEqual([
        { type: "text", text: expect.stringContaining('"state":"queued"') },
      ]);
    } finally {
      await host.close();
    }
  });
  test("permission changes during token minting prevent issue creation", async () => {
    const { id, taskId } = await fixture();
    const local = localFixture();
    const { service, requests } = provider({
      local: local.runner,
      onToken: async () => {
        await store.change(id, (w) => {
          present(present(w.coding).settings.repositories[0]).maintainers = [];
        });
      },
    });
    await service.advance(id, taskId);
    expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
    expect((await read(id)).state).toBe("failed");
  });
  test("ambiguous issue creation is never replayed", async () => {
    const { id, taskId } = await fixture();
    const local = localFixture();
    const { service, requests } = provider({
      issueStatus: 503,
      local: local.runner,
    });
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("unknown");
    await ready(id);
    await service.advance(id, taskId);
    expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(1);
    expect(local.calls).toHaveLength(0);
  });
  test("stale POST reservations become unknown without a network call", async () => {
    for (const state of [
      "creating_issue",
      "dispatching",
      "starting_publication",
    ] as const) {
      const { id, taskId } = await fixture();
      await store.change(id, (w) => {
        const t = present(w.codingTasks?.[0]);
        t.state = state;
        t.updatedAt = new Date(Date.now() - 180000).toISOString();
      });
      const local = localFixture();
      const { service, requests } = provider({ local: local.runner });
      await service.advance(id, taskId);
      expect((await read(id)).state).toBe("unknown");
      expect(requests).toHaveLength(0);
      expect(local.calls).toHaveLength(0);
    }
  });
  test("legacy Actions tasks are stopped locally without contacting GitHub", async () => {
    for (const state of ["queued", "issue_created", "running"] as const) {
      const { id, taskId } = await fixture();
      await store.change(id, (w) => {
        const task = present(w.codingTasks?.[0]);
        task.state = state;
        (task.payload as { backend: string }).backend = "github-actions";
      });
      const { service, requests } = provider();
      await service.advance(id, taskId);
      expect((await read(id)).state).toBe(
        state === "running" ? "unknown" : "cancelled",
      );
      expect((await read(id)).error).toBe("coding_legacy_backend_disabled");
      expect(requests).toHaveLength(0);
    }
  });
  test("another workspace cannot execute the task; queued cancellation does not contact GitHub", async () => {
    const { id, taskId } = await fixture();
    const other = await fixture();
    const local = localFixture();
    const { service, requests } = provider({ local: local.runner });
    await service.advance(other.id, taskId);
    expect(requests).toHaveLength(0);
    await store.change(id, (w) => {
      present(w.codingTasks?.[0]).cancelRequested = true;
    });
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("cancelled");
    expect(requests).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
  });

  function localFixture() {
    const calls: string[] = [];
    const starts: LocalStart[] = [];
    let state: LocalStatus = { state: "running" };
    const runner: LocalRunner = {
      async start(input) {
        starts.push(input);
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
      starts,
      set: (value: LocalStatus) => {
        state = value;
      },
    };
  }
  test("device auth is checked before creating a GitHub issue", async () => {
    const { id, taskId } = await fixture();
    await store.change(id, (w) => {
      present(w.coding).settings.authMode = "device_code";
      present(present(w.github).repositories[0]).private = true;
      present(w.codingTasks?.[0]).payload.authMode = "device_code";
    });
    const local = localFixture();
    (local.runner as LocalRunner & LocalDeviceAuth).deviceStatus =
      async () => ({
        state: "disconnected",
      });
    const { service, requests } = provider({ local: local.runner });
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("auth_required");
    expect((await read(id)).error).toBe("coding_device_auth_required");
    expect(requests.some((request) => request.url.endsWith("/issues"))).toBe(
      false,
    );
  });
  for (const privateRepository of [true, false]) {
    test(`account-auth tasks use GitHub App credentials for ${privateRepository ? "private" : "public"} repositories`, async () => {
      const { id, taskId } = await fixture();
      await store.change(id, (w) => {
        present(w.coding).settings.authMode = "device_code";
        present(present(w.github).repositories[0]).private = privateRepository;
        present(w.codingTasks?.[0]).payload.authMode = "device_code";
      });
      const local = localFixture();
      (local.runner as LocalRunner & LocalDeviceAuth).deviceStatus =
        async () => ({ state: "connected" });
      const { service, requests } = provider({ local: local.runner });
      await service.advance(id, taskId);
      expect((await read(id)).state).toBe("issue_created");
      await ready(id);
      await service.advance(id, taskId);
      expect((await read(id)).state).toBe("running");
      expect(local.starts).toHaveLength(1);
      expect(local.starts[0]?.readToken).toBe(
        "ghs_fixture_installation_secret",
      );
      expect(local.starts[0]?.payload.authMode).toBe("device_code");
      const tokens = requests.filter((r) => r.url.endsWith("/access_tokens"));
      expect(tokens.map((r) => JSON.parse(String(r.init.body)))).toEqual([
        { repository_ids: [7001], permissions: { issues: "write" } },
        { repository_ids: [7001], permissions: { contents: "read" } },
      ]);
      const issue = present(requests.find((r) => r.url.endsWith("/issues")));
      expect(new Headers(issue.init.headers).get("authorization")).toBe(
        "Bearer ghs_fixture_installation_secret",
      );
      await service.advance(id, taskId);
      expect(local.starts).toHaveLength(1);
    });
  }
  test("account auth cannot bypass denied GitHub App repository access", async () => {
    const { id, taskId } = await fixture();
    await store.change(id, (w) => {
      present(w.coding).settings.authMode = "device_code";
      present(w.codingTasks?.[0]).payload.authMode = "device_code";
    });
    const local = localFixture();
    (local.runner as LocalRunner & LocalDeviceAuth).deviceStatus =
      async () => ({ state: "connected" });
    const { service, requests } = provider({
      local: local.runner,
      tokenStatus: 403,
    });
    await service.advance(id, taskId);
    expect((await read(id)).error).toBe("github_access_denied");
    expect(requests.some((r) => r.url.endsWith("/issues"))).toBe(false);
    expect(local.starts).toHaveLength(0);
  });
  test("deleted workspace clears its runner account credential", async () => {
    const { id } = await fixture();
    const local = localFixture();
    const purged: string[] = [];
    (local.runner as LocalRunner & LocalDeviceAuth).deviceLogout = async (
      workspaceId,
    ) => {
      purged.push(workspaceId);
      return { state: "disconnected" };
    };
    const { service } = provider({ local: local.runner });
    await expect(service.purgeDeletedWorkspaceAuth(id)).rejects.toThrow(
      "deletion_not_requested",
    );
    await store.change(id, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "none",
      };
    });
    await service.purgeDeletedWorkspaceAuth(id);
    expect(purged).toEqual([id]);
  });
  test("Podman tasks retain approval and duplicate protection through fresh publication", async () => {
    const { id, taskId } = await fixture();
    const local = localFixture();
    const { service, requests } = provider({ local: local.runner });
    await service.advance(id, taskId);
    await ready(id);
    await Promise.all([
      service.advance(id, taskId),
      service.advance(id, taskId),
    ]);
    expect(local.calls.filter((c) => c === "start")).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(1);
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
    expect(
      (await store.read(id)).deliveries.some(
        (d) => d.text.includes("/pull/43") && d.topicId === 3,
      ),
    ).toBe(true);
    expect(JSON.stringify(await store.read(id))).not.toContain("ghs_fixture");
  });
  test("worker sends only the owning workspace's decrypted key to its local runner", async () => {
    const { id, taskId } = await fixture();
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
    const { service } = provider({ local: local.runner });
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
    const { id, taskId } = await fixture();
    const local = localFixture();
    let revoke = false;
    const { service } = provider({
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
    const { id, taskId } = await fixture();
    const local = localFixture();
    const { service, requests } = provider({ local: local.runner });
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
    const g = await fixture();
    const failed = localFixture();
    failed.runner.publish = async () => {
      failed.calls.push("publish");
      throw new Error("network reset");
    };
    const second = provider({ local: failed.runner }).service;
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
  test("reviewed account tasks resume the existing checkout without creating another issue", async () => {
    const { id, taskId } = await fixture();
    await store.change(id, (w) => {
      present(w.coding).settings.authMode = "device_code";
      present(present(w.github).repositories[0]).private = true;
      present(w.codingTasks?.[0]).payload.authMode = "device_code";
    });
    const local = localFixture();
    const device = local.runner as LocalRunner & LocalDeviceAuth;
    let connected = false;
    device.deviceStatus = async () => ({
      state: connected ? "connected" : "auth_required",
    });
    const { service, requests } = provider({
      local: device,
    });
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("auth_required");
    connected = true;
    for (let n = 0; n < 3; n++) {
      await ready(id);
      await service.advance(id, taskId);
    }
    expect((await read(id)).state).toBe("running");
    local.set({ state: "auth_required", error: "coding_device_auth_required" });
    connected = false;
    await ready(id);
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("auth_required");
    let resumes = 0;
    device.resumeAuth = async () => {
      resumes++;
      local.set({ state: "running" });
    };
    connected = true;
    await ready(id);
    await service.advance(id, taskId);
    expect((await read(id)).state).toBe("running");
    expect(resumes).toBe(1);
    expect(local.calls.filter((c) => c === "start")).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith("/issues"))).toHaveLength(1);
  });
});
