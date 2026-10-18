import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { developmentPolicy } from "../../src/coding/development.ts";
import { codingExtension } from "../../src/coding/extension.ts";
import type {
  LocalDeviceAuth,
  LocalRunner,
} from "../../src/coding/local/protocol.ts";
import { CodingService } from "../../src/coding/service.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";

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
      repositories: [
        { id: 7001, full_name: "example/workspace", default_branch: "develop" },
      ],
    };
    w.coding = {
      revision: 1,
      settings: {
        enabled: true,
        backend: "podman",
        authMode: "provider_key",
      },
    };
    grantGitHubAccess(w, ["101"]);
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    return { id: w.id };
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
  test("Codex tasks use connected repositories and filter by GitHub write access", async () => {
    const { id } = await fixture();
    await store.change(id, (w) => {
      present(w.github).repositories.push({
        id: 7002,
        full_name: "example/unavailable",
        default_branch: "main",
      });
      present(w.coding).settings.development = developmentPolicy.parse({});
    });
    const { host, input, run } = await codingHost(id);
    try {
      const start = present(
        host.tools.find((t) => t.name === "start_development_task"),
      );
      expect(start.description).toContain("example/workspace");
      expect(start.description).not.toContain("example/unavailable");
      const source = present(
        (await store.read(id)).messages.find((s) => s.runId === run.id),
      );
      await expect(
        start.execute(
          "denied-start",
          { repositoryId: 7002, sourceIds: [source.id] },
          input.signal,
        ),
      ).rejects.toThrow("github_user_access_denied");
      expect(
        (
          await store.pool.query(
            "SELECT id FROM coding_tasks WHERE workspace_id=$1",
            [id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await host.close();
    }
  });

  test("one source-bound workflow is exposed without coding proposals or approvals", async () => {
    const { id } = await fixture();
    const { host, input, run } = await codingHost(id);
    try {
      const names = host.tools.map((t) => t.name);
      expect(names).toContain("start_development_task");
      for (const name of [
        "propose_coding_task",
        "coding_task_status",
        "cancel_coding_task",
      ])
        expect(names).not.toContain(name);
      const source = present(
        (await store.read(id)).messages.find((s) => s.runId === run.id),
      );
      const start = present(
        host.tools.find((t) => t.name === "start_development_task"),
      );
      const args = { repositoryId: 7001, sourceIds: [source.id] };
      await start.execute("start", args, input.signal);
      await start.execute("replayed-start", args, input.signal);
      const records = await store.pool.query(
        "SELECT data FROM coding_tasks WHERE workspace_id=$1",
        [id],
      );
      expect(records.rows).toHaveLength(1);
      expect(records.rows[0].data).toMatchObject({
        phase: "intake",
        canImplement: false,
        canPublish: false,
        revision: 1,
        policy: { publishByDefault: true },
      });
      expect(records.rows[0].data.policy).not.toHaveProperty("executionMode");
      expect((await store.read(id)).approvals).toHaveLength(0);
      await expect(
        start.execute(
          "forged-source",
          { repositoryId: 7001, sourceIds: ["missing-source"] },
          input.signal,
        ),
      ).rejects.toThrow("coding_source_required");
    } finally {
      await host.close();
    }
  });
  test("deleted workspace clears only its own runner credential", async () => {
    const { id } = await fixture();
    const purged: string[] = [];
    const local = {
      deviceLogout: async (workspaceId: string) => {
        purged.push(workspaceId);
        return { state: "disconnected" };
      },
    } as LocalRunner & LocalDeviceAuth;
    const service = new CodingService(
      store,
      new GitHubApps(store, "ab".repeat(32)),
      local,
    );
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
});
