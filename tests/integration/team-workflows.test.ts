import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Run, Workspace } from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { githubExtension } from "../../src/github/extension.ts";
import { GitHubMetadata } from "../../src/github/metadata.ts";
import { decide, proposeWorkflow, tick } from "../../src/workflows/service.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { spec } from "../fixtures.ts";
import { githubFixtureConfig } from "../github-fixture.ts";
import {
  developmentTask,
  fixtureValue,
  requestRun,
  reusableSkill,
  successfulRun,
  teamWorkspace,
} from "../team-workflows-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "repository, skill and handoff integration",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `repodesk_team_${randomUUID().replaceAll("-", "")}`;
    const operatorId = randomUUID();
    let store: Store;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url as string);
      parsed.pathname = `/${name}`;
      store = new Store(database(parsed.toString()));
      await migrate(store.pool);
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'team_workflows','unused',true)",
        [operatorId],
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function seed(w = teamWorkspace(), r = requestRun(w)) {
      w.operatorId = operatorId;
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      return { w, r };
    }
    function provider(
      response: (u: URL) => unknown | Promise<unknown>,
      during?: (url: string) => Promise<void>,
    ) {
      const requests: { url: string; init: RequestInit }[] = [];
      const app = new GitHubApp(githubFixtureConfig, (async (
        input,
        init = {},
      ) => {
        const url = String(input);
        requests.push({ url, init });
        await during?.(url);
        if (url.endsWith("/access_tokens"))
          return Response.json({
            token: "ghs_fixture_read",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          });
        const result = await response(new URL(url));
        return result instanceof Response ? result : Response.json(result);
      }) as typeof fetch);
      return { requests, service: new GitHubMetadata(store, app) };
    }
    const read = (
      service: GitHubMetadata,
      w: Workspace,
      r: Run,
      args: unknown,
      signal = new AbortController().signal,
    ) => service.read(w.id, r.id, args, signal, async () => {});
    function item(number: number, extra: Record<string, unknown> = {}) {
      return {
        number,
        title: `Change ${number}`,
        state: "closed",
        user: { login: "alice" },
        body: "Read-only description",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-06T12:00:00Z",
        merged_at: "2026-10-06T11:00:00Z",
        closed_at: "2026-10-06T11:00:00Z",
        requested_reviewers: [{ login: "bob" }],
        requested_teams: [{ slug: "maintainers" }],
        draft: false,
        ...extra,
      };
    }
    test("merged PR windows use merge time; pages and reviewers have explicit read-only provenance", async () => {
      const { w, r } = await seed();
      const p = provider((u) =>
        u.searchParams.get("page") === "2"
          ? [item(21)]
          : Array.from({ length: 20 }, (_, i) =>
              item(i + 1, {
                merged_at:
                  i === 0
                    ? null
                    : i === 1
                      ? "2026-10-05T00:00:00Z"
                      : "2026-10-06T11:00:00Z",
              }),
            ),
      );
      const q = {
        repositoryId: 7001,
        kind: "pulls",
        state: "merged",
        since: "2026-10-06T00:00:00Z",
        until: "2026-10-07T00:00:00Z",
      };
      const first = await read(p.service, w, r, q);
      expect(first.items).toHaveLength(18);
      expect(first.complete).toBe(false);
      expect(first.nextPage).toBe(2);
      expect(first.items[0]).toMatchObject({
        url: "https://github.com/example/private/pull/3",
        requestedReviewers: ["bob"],
        requestedTeams: ["maintainers"],
      });
      const second = await read(p.service, w, r, {
        ...q,
        page: first.nextPage,
      });
      expect(second.complete).toBe(true);
      expect(second.items[0]?.number).toBe(21);
      expect(JSON.parse(String(p.requests[0]?.init.body))).toEqual({
        repository_ids: [7001],
        permissions: { pull_requests: "read" },
      });
      expect(
        p.requests
          .filter((req) => !req.url.endsWith("/access_tokens"))
          .every((req) => req.init.method === "GET"),
      ).toBe(true);
      expect(JSON.stringify(first)).not.toContain("ghs_fixture");
    });
    test("the real Pi extension registers current metadata tools without adding write permissions", async () => {
      const { w, r } = await seed(),
        p = provider(() => [item(42)]);
      const input: AgentInput = {
        workspaceId: w.id,
        actor: r.actor,
        runId: r.id,
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
      const host = await ExtensionCatalog.fromSnapshot(
        [],
        [githubExtension(store, w.id, fixtureValue(w.github), p.service)],
      ).open(input);
      try {
        const tool = fixtureValue(
          host?.tools.find((t) => t.name === "query_github_metadata"),
        );
        const result = await tool.execute(
          "metadata",
          { repositoryId: 7001, kind: "pulls" },
          input.signal,
        );
        expect(JSON.stringify(result)).toContain(
          "https://github.com/example/private/pull/42",
        );
      } finally {
        await host?.close();
      }
    });
    test("issue lists exclude PRs; an individual issue response is bounded and URL is constructed locally", async () => {
      const { w, r } = await seed();
      const p = provider((u) =>
        u.pathname.endsWith("/42")
          ? item(42, {
              merged_at: undefined,
              body: "x".repeat(3000),
              html_url: "https://attacker.invalid",
            })
          : [
              item(42, { merged_at: undefined }),
              item(43, { pull_request: { url: "ignored" } }),
            ],
      );
      const list = await read(p.service, w, r, {
        repositoryId: 7001,
        kind: "issues",
      });
      expect(list.items.map((i) => i.number)).toEqual([42]);
      const one = await read(p.service, w, r, {
        repositoryId: 7001,
        kind: "issues",
        number: 42,
      });
      expect(one.items[0]?.body).toHaveLength(2000);
      expect(one.items[0]?.bodyTruncated).toBe(true);
      expect(one.items[0]?.url).toBe(
        "https://github.com/example/private/issues/42",
      );
      expect(JSON.parse(String(p.requests[0]?.init.body)).permissions).toEqual({
        issues: "read",
      });
    });
    test("unselected repositories and private group reads fail before any external request", async () => {
      const w = teamWorkspace(),
        r = requestRun(w, "101", "-100100", 3);
      await seed(w, r);
      const p = provider(() => []);
      await expect(
        read(p.service, w, r, { repositoryId: 7001, kind: "pulls" }),
      ).rejects.toThrow("github_metadata_scope_denied");
      await expect(
        read(p.service, w, r, { repositoryId: 9999, kind: "pulls" }),
      ).rejects.toThrow("github_metadata_scope_denied");
      expect(p.requests).toHaveLength(0);
    });
    test("repository revocation during token minting prevents the GET; cancellation after response prevents returning data", async () => {
      for (const stage of ["token", "response"]) {
        const { w, r } = await seed();
        const p = provider(
          () => [],
          async (url) => {
            if ((stage === "token") === url.endsWith("/access_tokens"))
              await store.change(w.id, (current) => {
                if (stage === "token") fixtureValue(current.github).revision++;
                else
                  fixtureValue(
                    current.runs.find((run) => run.id === r.id),
                  ).cancelled = true;
              });
          },
        );
        await expect(
          read(p.service, w, r, { repositoryId: 7001, kind: "pulls" }),
        ).rejects.toThrow("tool_policy_denied");
        if (stage === "token") expect(p.requests).toHaveLength(1);
      }
    });
    test("upstream failure and missing permissions never become empty successful reports", async () => {
      const { w, r } = await seed();
      const unavailable = provider(
        () => new Response("upstream error", { status: 503 }),
      );
      await expect(
        read(unavailable.service, w, r, { repositoryId: 7001, kind: "pulls" }),
      ).rejects.toThrow("github_unavailable");
      const missing = new GitHubMetadata(
        store,
        new GitHubApp(githubFixtureConfig, (async (
          _input: RequestInfo | URL,
          _init?: RequestInit,
        ) =>
          Response.json(
            { message: "Permissions requested are not granted" },
            { status: 422 },
          )) as typeof fetch),
      );
      await expect(
        read(missing, w, r, { repositoryId: 7001, kind: "pulls" }),
      ).rejects.toThrow("github_app_permissions_missing");
      const controller = new AbortController();
      controller.abort();
      await expect(
        read(
          unavailable.service,
          w,
          r,
          { repositoryId: 7001, kind: "pulls" },
          controller.signal,
        ),
      ).rejects.toThrow();
    });
    test("repository workflows pin approved sources through a restart and scheduler duplicate", async () => {
      const { w } = await seed();
      const proposal = await store.change(w.id, (current) => {
        const p = proposeWorkflow(current, "101", {
          ...spec(current),
          github: { revision: 1, repositoryIds: [7001] },
        });
        decide(current, "101", p.approval.id, true);
        return p;
      });
      const next = new Store(store.pool);
      await next.change(w.id, (current) =>
        tick(
          current,
          "gpt-4.1-mini",
          new Date(fixtureValue(proposal.workflow.nextAt)),
        ),
      );
      await next.change(w.id, (current) =>
        tick(
          current,
          "gpt-4.1-mini",
          new Date(fixtureValue(proposal.workflow.nextAt)),
        ),
      );
      const scheduled = fixtureValue(
        (await next.read(w.id)).runs.find(
          (run) => run.workflowId === proposal.workflow.id,
        ),
      );
      expect((await next.read(w.id)).occurrences).toHaveLength(1);
      await next.change(w.id, (current) => {
        fixtureValue(
          current.runs.find((run) => run.id === scheduled.id),
        ).status = "running";
      });
      const p = provider(() => [item(42)]);
      const result = await read(p.service, w, scheduled, {
        repositoryId: 7001,
        kind: "pulls",
        state: "merged",
      });
      expect(
        new Intl.DateTimeFormat("en", {
          timeZone: "Asia/Taipei",
          hourCycle: "h23",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(result.window.until as string)),
      ).toBe("00:00");
      expect(result.complete).toBe(true);
    });
    test("application tools review a skill exactly once, survive JSONB key order and reject stale fences", async () => {
      const w = teamWorkspace(),
        source = successfulRun(w, "202"),
        r = requestRun(w, "202");
      await seed(w, r);
      const tools = applicationTools(store, w.id, r.id, 1);
      const sourceTool = fixtureValue(
        tools.find((t) => t.name === "read_skill_source"),
      );
      await sourceTool.execute("source", { runId: source.id });
      const tool = fixtureValue(tools.find((t) => t.name === "propose_skill"));
      const args = { sourceRunId: source.id, ...reusableSkill };
      await tool.execute("skill", args);
      await tool.execute("skill", { ...reusableSkill, sourceRunId: source.id });
      const saved = await store.read(w.id);
      expect(saved.approvals).toHaveLength(1);
      expect(saved.deliveries).toHaveLength(1);
      const approval = fixtureValue(saved.approvals[0]);
      await store.change(w.id, (current) =>
        decide(current, "202", approval.id, true),
      );
      const restart = await store.read(w.id);
      expect(
        restart.skills.find((s) => s.id === approval.target),
      ).toMatchObject({ enabled: false, published: [] });
      await store.change(w.id, (current) => {
        fixtureValue(current.runs.find((run) => run.id === r.id)).fence = 2;
      });
      await expect(tool.execute("skill", args)).rejects.toThrow(
        "tool_policy_denied",
      );
      const another = await seed();
      const foreign = fixtureValue(
        applicationTools(store, another.w.id, r.id, 1).find(
          (t) => t.name === "propose_skill",
        ),
      );
      await expect(foreign.execute("foreign", args)).rejects.toThrow(
        "tool_policy_denied",
      );
    });
    test("handoff tools query durable continuous tasks and recheck all answer/context source dependencies", async () => {
      const w = teamWorkspace(),
        task = developmentTask(w),
        r = requestRun(w);
      const context = {
        ...fixtureValue(w.messages.find((s) => s.id === task.sourceId)),
        id: randomUUID(),
        text: "Earlier approved product context",
      };
      w.messages.push(context);
      await seed(w, r);
      await store.pool.query(
        "INSERT INTO coding_tasks(workspace_id,id,data,updated_at) VALUES($1,$2,$3,now())",
        [w.id, task.id, JSON.stringify(task)],
      );
      const source = fixtureValue(
        w.messages.find((s) => s.id === task.sourceId),
      );
      await store.pool.query(
        "INSERT INTO coding_task_events(workspace_id,task_id,id,data) VALUES($1,$2,'context',$3)",
        [w.id, task.id, JSON.stringify({ sources: [context] })],
      );
      await store.pool.query(
        "INSERT INTO coding_task_inputs(workspace_id,task_id,revision,source_key,data) VALUES($1,$2,1,'request',$3)",
        [
          w.id,
          task.id,
          JSON.stringify({
            revision: 1,
            actor: "101",
            sourceId: source.id,
            text: source.text,
            kind: "request",
          }),
        ],
      );
      const tool = fixtureValue(
        applicationTools(store, w.id, r.id, 1).find(
          (t) => t.name === "query_work_handoff",
        ),
      );
      const result = await tool.execute("handoff", {});
      const body = JSON.parse(
        fixtureValue(result.content.find((c) => c.type === "text")).text,
      );
      expect(body.entries[0].question).toContain("sessions");
      expect(body.complete).toBe(true);
      await tool.execute("handoff", {});
      expect(
        (await store.read(w.id)).runs.find((run) => run.id === r.id)?.tools
          .handoff?.state,
      ).toBe("done");
      await store.change(w.id, (current) => {
        current.messages = current.messages.filter((s) => s.id !== context.id);
      });
      const saved = await store.read(w.id);
      expect(
        runAllowed(
          saved,
          fixtureValue(saved.runs.find((run) => run.id === r.id)),
        ),
      ).toBe(false);
      await expect(tool.execute("handoff", {})).rejects.toThrow(
        "tool_policy_denied",
      );
    });
  },
);
