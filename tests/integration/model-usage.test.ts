import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { claim, login } from "../../src/admin/auth.ts";
import { adminRoutes } from "../../src/admin/routes.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import type { DevelopmentTask } from "../../src/coding/development.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { settingsSchema } from "../../src/domain.ts";
import { GitHubService } from "../../src/github/service.ts";
import { reconcileCharge } from "../../src/jobs/recovery.ts";
import { sweep } from "../../src/privacy/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import {
  deriveCodingUsageEvent,
  type ModelUsageAnalyticsResponse,
  queryModelUsageAnalytics,
  upsertModelUsageEvents,
} from "../../src/usage/model-usage.ts";
import { createRun, enrollOwner } from "../../src/workspaces/service.ts";

const baseUrl = process.env.TEST_DATABASE_URL;
const describeDb = baseUrl ? describe : describe.skip;

describeDb(
  "model usage ledger, attribution, analytics API, and isolation",
  () => {
    let pool: Pool;
    let adminPool: Pool;
    let dbName: string;
    let store: Store;
    let setup: SetupService;
    let adminId: string;
    let cookie: string;
    const encryptionKey = "cd".repeat(32);

    beforeAll(async () => {
      if (!baseUrl) return;
      const parsed = new URL(baseUrl);
      dbName = `telo_usage_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      adminPool = database(baseUrl);
      await adminPool.query(`CREATE DATABASE ${dbName}`);
      parsed.pathname = `/${dbName}`;
      pool = database(parsed.toString());
      await migrate(pool);
      store = new Store(pool, undefined, encryptionKey);
      setup = new SetupService(store, encryptionKey, "http://localhost:3000");
      await claim(pool, "usage-admin", "a long test password");
      adminId = (await pool.query("SELECT id FROM admins LIMIT 1")).rows[0].id;
      const session = await login(pool, "usage-admin", "a long test password");
      cookie = `telo_session=${session.raw}`;
    });

    afterAll(async () => {
      await pool?.end();
      if (adminPool && dbName) {
        await adminPool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",
          [dbName],
        );
        await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
      }
      await adminPool?.end();
    });

    async function seedWorkspace(name: string) {
      const { id } = await setup.createWorkspace(
        { id: adminId, username: "usage-admin", operator: true },
        settingsSchema.parse({
          name,
          timezone: "UTC",
          monthlyBudgetUsd: 50,
        }),
      );
      await store.change(id, (w) => {
        enrollOwner(w, "101");
        w.members.push({
          id: "202",
          username: "alice",
          name: "Alice",
          role: "member",
          active: true,
        });
        w.chats.push({
          id: "-100100",
          title: "Engineering",
          active: true,
          collection: true,
          linkedAt: new Date().toISOString(),
          visibleAll: true,
        });
      });
      return id;
    }

    test("records chat, compaction, workflow, self-check, coding, and review bot usage with full source attribution and reconciliation", async () => {
      const wsId = await seedWorkspace("Analytics Team");
      const otherWsId = await seedWorkspace("Other Tenant");
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const today = now.toISOString();

      let chatRunId = "";
      const reconcileAttemptId = randomUUID();

      await store.change(wsId, async (w, sql) => {
        // 1. Chat run in linked group with 3 attempts: main chat, compaction, and unknown->reconciled
        const chatRun = createRun(
          w,
          "202",
          "Explain caching",
          "-100100",
          0,
          "gpt-4.1-mini",
        );
        chatRunId = chatRun.id;
        chatRun.attempts.push(
          {
            id: randomUUID(),
            model: "gpt-4.1-mini",
            reserved: 0.01,
            actual: 0.004,
            status: "settled",
            at: yesterday,
            tokens: {
              input: 2000,
              cacheRead: 3000,
              cacheWrite: 0,
              output: 500,
            },
            estimatedInputTokens: 4800,
            latencyMs: 920,
            stopReason: "stop",
            toolCalls: 2,
          },
          {
            id: randomUUID(),
            model: "gpt-4.1-mini",
            purpose: "compaction",
            reserved: 0.003,
            actual: 0.001,
            status: "settled",
            at: today,
            tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200 },
            estimatedInputTokens: 1050,
            latencyMs: 410,
            stopReason: "stop",
            toolCalls: 0,
          },
          {
            id: reconcileAttemptId,
            model: "gpt-4.1-mini",
            reserved: 0.02,
            status: "unknown",
            at: today,
            tokens: { input: 500, cacheRead: 0, cacheWrite: 0, output: 0 },
            latencyMs: 1200,
            stopReason: "error",
          },
        );

        // 2. Workflow run
        w.workflows.push({
          id: "wf-digest",
          version: 1,
          owner: "101",
          status: "active",
          spec: {
            name: "Daily PR Digest",
            task: "Summarize PRs",
            chatId: "101",
            topicId: 0,
            recurrence: {
              frequency: "daily",
              hour: 9,
              minute: 0,
              timezone: "UTC",
            },
            format: "Brief",
            windowDays: 1,
          },
          versions: [],
        });
        const wfRun = createRun(w, "101", "Digest", "101", 0, "gpt-4.1", {
          workflowId: "wf-digest",
        });
        wfRun.attempts.push({
          id: randomUUID(),
          model: "gpt-4.1",
          reserved: 0.05,
          actual: 0.03,
          status: "settled",
          at: today,
          tokens: {
            input: 4000,
            cacheRead: 1000,
            cacheWrite: 200,
            output: 800,
          },
          estimatedInputTokens: 5100,
          latencyMs: 1500,
          stopReason: "stop",
          toolCalls: 3,
        });

        // 3. Admin self-check
        w.adminChecks = [
          {
            id: randomUUID(),
            adminId,
            actor: "101",
            model: "gpt-4.1-mini",
            providerName: "OpenAI",
            at: today,
            status: "succeeded",
            attempts: [
              {
                id: randomUUID(),
                model: "gpt-4.1-mini",
                reserved: 0.002,
                actual: 0.0005,
                status: "settled",
                at: today,
                tokens: {
                  input: 400,
                  cacheRead: 0,
                  cacheWrite: 0,
                  output: 100,
                },
                latencyMs: 320,
                stopReason: "stop",
              },
            ],
          },
        ];

        // 4. Review Bot task
        w.reviewTasks = [
          {
            id: "rev-task-1",
            key: "acme/api#42",
            actor: "202",
            number: 42,
            mode: "review",
            automatic: true,
            inputs: [],
            sources: [],
            revision: 1,
            consumedRevision: 1,
            state: "completed",
            attemptId: "rev-att-1",
            payload: {
              installationId: 1,
              repositoryId: 1,
              repository: "acme/api",
              title: "PR #42",
              body: "Review PR",
              githubRevision: 1,
              configRevision: 1,
              baseBranch: "main",
              backend: "podman",
              authMode: "provider_key",
            },
            runnerModel: {
              id: "prov-1",
              version: 1,
              name: "OpenAI Prod",
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-4.1",
            },
            tokens: 3000,
            tokenUsage: {
              input: 1500,
              cacheRead: 1000,
              cacheWrite: 0,
              output: 500,
              total: 3000,
            },
            reviewRevision: 1,
            createdAt: today,
            updatedAt: today,
          },
        ];

        // 5. Codex coding task event
        const codingTask = {
          id: "coding-task-1",
          workspaceId: w.id,
          actor: "202",
          payload: { repository: "acme/api", authMode: "provider_key" },
          runnerModel: {
            id: "prov-1",
            version: 1,
            name: "OpenAI Prod",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4.1",
          },
          phase: "work",
        } as unknown as DevelopmentTask;
        await upsertModelUsageEvents(sql, [
          deriveCodingUsageEvent({
            task: codingTask,
            attemptId: "cod-att-1",
            kind: "coding_task",
            status: "settled",
            tokens: 6000,
            tokenUsage: {
              input: 3000,
              cacheRead: 2000,
              cacheWrite: 0,
              output: 1000,
              reasoning: 250,
              total: 6000,
            },
            latencyMs: 8400,
            recordedAt: today,
          }),
        ]);
      });

      // Seed an unrelated event in otherWsId to assert strict tenant isolation.
      await store.change(otherWsId, (w) => {
        const r = createRun(w, "101", "Other tenant", "101", 0, "other-model");
        r.attempts.push({
          id: randomUUID(),
          model: "other-model",
          reserved: 1,
          actual: 1,
          status: "settled",
          at: today,
          tokens: { input: 99999, cacheRead: 0, cacheWrite: 0, output: 99999 },
        });
      });

      // Reconcile the unknown charge and verify ledger updates atomically via Store.save.
      await store.change(wsId, (w) => {
        reconcileCharge(
          w,
          "101",
          chatRunId,
          reconcileAttemptId,
          0.0025,
          "INV-100",
        );
      });

      // Query analytics directly & through HTTP admin API.
      const w = await store.read(wsId);
      const analytics = await queryModelUsageAnalytics(pool, w, {
        range: "30d",
        offset: 0,
        limit: 50,
      });

      expect(analytics.summary.calls).toBe(7);
      expect(analytics.summary.settledCalls).toBe(7);
      expect(analytics.summary.totalTokens).toBe(22700);
      expect(analytics.summary.cacheReadTokens).toBe(7000);
      expect(analytics.summary.reasoningTokens).toBe(250);
      expect(analytics.summary.totalToolCalls).toBe(5);
      expect(analytics.summary.estimatorSampleCount).toBe(3);
      expect(analytics.summary.avgActualToEstimatedRatio).toBeGreaterThan(0.9);
      expect(analytics.summary.avgActualToEstimatedRatio).toBeLessThan(1.1);
      expect(analytics.bySource.map((s) => s.key).sort()).toEqual([
        "chat",
        "coding_task",
        "compaction",
        "review_bot",
        "self_check",
        "workflow",
      ]);
      expect(analytics.byModel.some((m) => m.key === "other-model")).toBe(
        false,
      );
      expect(
        analytics.items.every((item) => item.sourceId && item.sourceLabel),
      ).toBe(true);

      // HTTP route check (including operator-only privacy masking & source filtering)
      const plugins = new PluginService(store, encryptionKey);
      const github = new GitHubService(
        store,
        encryptionKey,
        "http://localhost:3000",
      );
      const app = adminRoutes({
        store,
        setup,
        origin: "http://localhost:3000",
        plugins,
        github,
        encryptionKey,
      });

      const res = await app.request(
        `/api/admin/workspaces/${wsId}/model-usage?range=30d&source=workflow`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as ModelUsageAnalyticsResponse;
      expect(body.summary.calls).toBe(1);
      expect(body.items[0]?.sourceKind).toBe("workflow");
      expect(body.items[0]?.sourceLabel).toBe("Workflow · Daily PR Digest");

      // Workspace deletion purges model_usage_events.
      await store.change(wsId, (ws) => {
        ws.deletion = {
          requestedAt: new Date().toISOString(),
          providerState: "none",
        };
        sweep(ws);
      });
      const remaining = await pool.query(
        "SELECT COUNT(*)::int AS count FROM model_usage_events WHERE workspace_id=$1",
        [wsId],
      );
      expect(remaining.rows[0]?.count).toBe(0);
    });
  },
);
