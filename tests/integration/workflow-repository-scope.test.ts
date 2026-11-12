import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin, Workspace } from "../../src/domain.ts";
import { GitHubApp, type GitHubRepository } from "../../src/github/app.ts";
import { repositorySourcesAllowed } from "../../src/github/metadata-policy.ts";
import { GitHubService } from "../../src/github/service.ts";
import { authorizeRepository } from "../../src/github/user-access.ts";
import { RuntimeLogger } from "../../src/observability/logs.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { activateWorkflow, tick } from "../../src/workflows/service.ts";
import { revokeWork, runAllowed } from "../../src/workspaces/policy.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "scheduled repository scope production services",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `workflow_scope_${randomUUID().replaceAll("-", "")}`;
    const key = "ab".repeat(32);
    const operatorId = randomUUID();
    let store: Store;
    let log: RuntimeLogger;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url as string);
      parsed.pathname = `/${name}`;
      const pool = database(parsed.toString());
      await migrate(pool);
      log = new RuntimeLogger(pool, "worker", () => {});
      store = new Store(pool, log);
      await pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'scope','unused',true)",
        [operatorId],
      );
    });
    afterAll(async () => {
      await log?.close();
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function fixture() {
      const w = workspace();
      w.operatorId = operatorId;
      const repositories: GitHubRepository[] = [7001, 7002].map((id) => ({
        id,
        full_name: `example/repo-${id}`,
        private: false,
        permissions: { pull: true, push: true, admin: false },
      }));
      w.github = { revision: 1, installationId: 501, repositories };
      const member = w.members.find((m) => m.id === "202");
      if (!member) throw new Error("fixture");
      member.github = {
        id: 42,
        login: "member",
        status: "connected",
        connectionRevision: 1,
        syncedAt: new Date().toISOString(),
        repositories: structuredClone(repositories),
      };
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      await store.pool.query(
        "INSERT INTO github_user_accounts(workspace_id,actor,github_id,app_id,user_token,next_sync_at) VALUES($1,'202',42,$2,$3,now())",
        [
          w.id,
          githubFixtureConfig.id,
          encrypt(key, `github-user:${w.id}:202`, "ghu_fixture"),
        ],
      );
      const state = { repositories: structuredClone(repositories) };
      const app = new GitHubApp(githubFixtureConfig, (async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/access_tokens"))
          return Response.json({
            token: "ghs_fixture",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          });
        if (path === "/user") return Response.json({ id: 42, login: "member" });
        if (path === "/user/installations")
          return Response.json({
            installations: [
              {
                id: 501,
                app_id: githubFixtureConfig.id,
                account: { login: "example" },
                suspended_at: null,
              },
            ],
          });
        if (
          path === "/installation/repositories" ||
          path === "/user/installations/501/repositories"
        )
          return Response.json({ repositories: state.repositories });
        throw new Error("Unexpected fixture request");
      }) as typeof fetch);
      const service = new GitHubService(
        store,
        key,
        "http://localhost:3000",
        app,
      );
      const admin: Admin = {
        id: operatorId,
        username: "scope",
        operator: true,
      };
      const workflows = await store.change(w.id, (current) =>
        repositories.map(
          (repo) =>
            activateWorkflow(current, "202", {
              name: `Report ${repo.id}`,
              task: "Read repository activity",
              format: "markdown",
              windowDays: 1,
              chatId: "202",
              topicId: 0,
              recurrence: {
                frequency: "daily",
                timezone: "Asia/Taipei",
                hour: 8,
                minute: 0,
              },
              github: { revision: 1, repositoryIds: [repo.id] },
            }).workflow,
        ),
      );
      const when = new Date(workflows[0]?.nextAt as string);
      await store.change(w.id, (current) => tick(current, "test-model", when));
      return { id: w.id, service, state, admin, workflows, when };
    }
    test("unrelated removal preserves pinned schedule, queued run and delivery across metadata refresh, user sync, restart and duplicate ticks", async () => {
      const f = await fixture();
      await store.change(f.id, (w) => {
        for (const r of w.runs)
          w.deliveries.push({
            id: randomUUID(),
            actor: "202",
            chatId: "202",
            topicId: 0,
            runId: r.id,
            text: "Fixture output",
            state: "pending",
            attempts: 0,
            at: new Date().toISOString(),
          });
      });
      f.state.repositories = f.state.repositories.filter((r) => r.id === 7001);
      await f.service.repositorySync.refresh(f.admin, f.id);
      // A fresh snapshot for an unchanged repository stays valid before the next sync.
      await store.change(f.id, (w) => {
        expect(() => authorizeRepository(w, "202", 7001)).not.toThrow();
        expect(
          repositorySourcesAllowed(w, "202", {
            revision: 1,
            repositoryIds: [7001],
          }),
        ).toBe(true);
      });
      await store.change(f.id, (w, sql) => f.service.users.sync(sql, w, "202"));
      const synced = await store.read(f.id);
      expect(synced.members.find((m) => m.id === "202")?.github).toMatchObject({
        status: "connected",
        connectionRevision: 2,
        repositories: [{ id: 7001 }],
      });
      expect(
        repositorySourcesAllowed(synced, "202", {
          revision: 1,
          repositoryIds: [7001],
        }),
      ).toBe(true);
      const restarted = new Store(store.pool, log);
      for (let i = 0; i < 2; i++)
        await restarted.change(f.id, (w) => tick(w, "test-model", f.when));
      const w = await restarted.read(f.id);
      const kept = w.workflows.find((wf) => wf.id === f.workflows[0]?.id);
      const removed = w.workflows.find((wf) => wf.id === f.workflows[1]?.id);
      expect(w.github?.revision).toBe(2);
      expect(w.github?.repositoryRevisions).toEqual({ "7002": 2 });
      expect(kept?.status).toBe("active");
      expect(kept?.spec.github?.revision).toBe(1);
      expect(removed?.status).toBe("suspended");
      expect(removed?.reason).toBe("github_workflow_scope_denied");
      const run = w.runs.find((r) => r.workflowId === kept?.id);
      const denied = w.runs.find((r) => r.workflowId === removed?.id);
      expect(run?.cancelled).toBe(false);
      expect(runAllowed(w, run as NonNullable<typeof run>)).toBe(true);
      expect(denied?.cancelled).toBe(true);
      expect(w.deliveries.find((d) => d.runId === run?.id)?.state).toBe(
        "pending",
      );
      expect(w.deliveries.find((d) => d.runId === denied?.id)?.state).toBe(
        "cancelled",
      );
      expect(w.occurrences).toHaveLength(2);
      expect(w.runs).toHaveLength(2);
      expect(
        w.audit.filter((a) => a.action === "workflow.suspended"),
      ).toHaveLength(1);
      await log.flush();
      const events = (
        await store.pool.query(
          "SELECT code,workspace_id,run_id FROM runtime_logs WHERE workspace_id=$1 AND event='workflow_suspended'",
          [f.id],
        )
      ).rows;
      expect(events).toEqual([
        {
          code: "github_workflow_scope_denied",
          workspace_id: f.id,
          run_id: denied?.id,
        },
      ]);
      // Reappearing with the same ID cannot revive an old scope after revocation.
      await store.change(f.id, (current) => {
        current.github?.repositories.push({
          id: 7002,
          full_name: "example/repo-7002",
          private: false,
        });
        expect(
          repositorySourcesAllowed(current, "202", {
            revision: 1,
            repositoryIds: [7002],
          }),
        ).toBe(false);
        revokeWork(current);
        expect(
          current.workflows.find((wf) => wf.id === removed?.id)?.status,
        ).toBe("suspended");
      });
    });
    const cases: {
      name: string;
      mutate: (w: Workspace) => void;
      reason: string;
    }[] = [
      {
        name: "owner deactivation",
        mutate: (w) => {
          const m = w.members.find((m) => m.id === "202");
          if (m) m.active = false;
        },
        reason: "workflow_owner_revoked",
      },
      {
        name: "connection replacement",
        mutate: (w) => {
          if (w.github) {
            w.github.revision++;
            w.github.connectionRevision = w.github.revision;
          }
        },
        reason: "github_workflow_scope_denied",
      },
      {
        name: "selected repository metadata change",
        mutate: (w) => {
          if (w.github) {
            w.github.connectionRevision = 1;
            w.github.revision = 2;
            w.github.repositoryRevisions = { "7001": 2 };
          }
        },
        reason: "github_workflow_scope_denied",
      },
      {
        name: "stale permissions",
        mutate: (w) => {
          const a = w.members.find((m) => m.id === "202")?.github;
          if (a) a.syncedAt = new Date(Date.now() - 11 * 60000).toISOString();
        },
        reason: "github_workflow_scope_denied",
      },
      {
        name: "denied permissions",
        mutate: (w) => {
          const a = w.members.find((m) => m.id === "202")?.github;
          if (a) a.repositories = [];
        },
        reason: "github_workflow_scope_denied",
      },
    ];
    for (const scenario of cases)
      test(`${scenario.name} still denies dispatch and records one safe suspension`, async () => {
        const f = await fixture();
        await store.change(f.id, (w) => {
          scenario.mutate(w);
          revokeWork(w);
          revokeWork(w);
        });
        const w = await store.read(f.id);
        expect(w.workflows[0]?.status).toBe("suspended");
        expect(w.workflows[0]?.reason).toBe(scenario.reason);
        expect(w.runs[0]?.cancelled).toBe(true);
        expect(
          w.audit.filter(
            (a) =>
              a.action === "workflow.suspended" &&
              a.target === w.workflows[0]?.id,
          ),
        ).toHaveLength(1);
        expect(
          repositorySourcesAllowed(w, "202", {
            revision: 99,
            repositoryIds: [7001],
          }),
        ).toBe(false);
      });
  },
);
