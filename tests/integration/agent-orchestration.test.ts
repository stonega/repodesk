import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { claim } from "../../src/admin/auth.ts";
import type { AgentRunner, SubagentContext } from "../../src/agent/runtime.ts";
import {
  autonomyView,
  evaluateAutonomy,
  updateRepositoryAutonomy,
  updateWorkspaceAutonomy,
} from "../../src/autonomy/policy.ts";
import {
  cancelRepoQueueItem,
  completeRepoQueueItem,
  enqueueRepoTask,
  listRepoQueues,
  pinRepoQueueItem,
  setRepoQueuePaused,
} from "../../src/coding/queue.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { settingsSchema, workflowSchema } from "../../src/domain.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { dispatchCrossRepoMission } from "../../src/orchestration/cross-repo.ts";
import {
  missionCreate,
  missionDetail,
  missionGet,
  waitCreate,
} from "../../src/orchestration/store.ts";
import {
  cancelMission,
  missionContextSnapshot,
  resolveMissionWait,
  tickMissions,
} from "../../src/orchestration/wakeup.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import {
  dispatchAutomationEvent,
  recordWatcherDedupe,
} from "../../src/workflows/events.ts";
import { activateWorkflow } from "../../src/workflows/service.ts";
import { enrollOwner } from "../../src/workspaces/service.ts";

const baseUrl = process.env.TEST_DATABASE_URL;
const describeDb = baseUrl ? describe : describe.skip;

describeDb("agent orchestration, autonomy, triggers, and repo queues", () => {
  let pool: Pool;
  let adminPool: Pool;
  let dbName: string;
  let store: Store;
  let setup: SetupService;
  let adminId: string;
  const encryptionKey = "ab".repeat(32);

  beforeAll(async () => {
    if (!baseUrl) return;
    const parsed = new URL(baseUrl);
    dbName = `repodesk_orch_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    adminPool = database(baseUrl);
    await adminPool.query(`CREATE DATABASE ${dbName}`);
    parsed.pathname = `/${dbName}`;
    pool = database(parsed.toString());
    await migrate(pool);
    store = new Store(pool, undefined, encryptionKey);
    setup = new SetupService(store, encryptionKey, "http://localhost:3000");
    await claim(pool, "orch-admin", "a long test password");
    adminId = (await pool.query("SELECT id FROM admins LIMIT 1")).rows[0].id;
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

  async function createFixtureWorkspace(name: string) {
    const { id } = await setup.createWorkspace(
      { id: adminId, username: "orch-admin", operator: true },
      settingsSchema.parse({ name, timezone: "UTC" }),
    );
    await store.change(id, (w) => {
      enrollOwner(w, "101");
      w.members.push({ id: "202", role: "member", active: true });
      w.github = {
        revision: 1,
        installationId: 500,
        repositories: [
          {
            id: 1001,
            full_name: "acme/backend",
            default_branch: "main",
            private: true,
          },
          {
            id: 1002,
            full_name: "acme/landing",
            default_branch: "main",
            private: false,
          },
        ],
      };
    });
    return id;
  }

  test("mission waits, join_mode=all wakeup, autonomous timer tick, and cancellation work atomically", async () => {
    const id = await createFixtureWorkspace("Mission Lifecycle");

    let missionId = "";
    const joinGroup = "jg-1";
    await store.change(id, async (w, sql) => {
      const m = await missionCreate(sql, {
        workspaceId: w.id,
        actor: "101",
        chatId: "101",
        topicId: 0,
        status: "waiting",
        goal: "Investigate traffic drop and fix landing page",
        originSourceIds: ["src-1"],
        autonomyMode: "check_in",
        autonomyRevision: 0,
      });
      missionId = m.id;
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId: m.id,
        joinGroup,
        joinMode: "all",
        kind: "coding_task",
        targetId: "task-a",
        reason: "Wait for backend fix",
      });
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId: m.id,
        joinGroup,
        joinMode: "all",
        kind: "coding_task",
        targetId: "task-b",
        reason: "Wait for landing fix",
      });
    });

    // Resolving only task-a should NOT wake yet (join_mode=all)
    await store.change(id, async (w, sql) => {
      const first = await resolveMissionWait(
        sql,
        w,
        "coding_task",
        "task-a",
        {
          status: "satisfied",
          summary: "Backend PR #10 ready",
          artifact: {
            kind: "pr",
            label: "Backend PR #10",
            value: "https://github.com/acme/backend/pull/10",
          },
        },
        "gpt-4.1-mini",
      );
      expect(first.wokeRunIds).toEqual([]);
    });

    // Resolving task-b satisfies the join group and queues a Continuation Run
    let wokeRunId = "";
    await store.change(id, async (w, sql) => {
      const second = await resolveMissionWait(
        sql,
        w,
        "coding_task",
        "task-b",
        {
          status: "satisfied",
          summary: "Landing PR #20 ready",
          artifact: {
            kind: "pr",
            label: "Landing PR #20",
            value: "https://github.com/acme/landing/pull/20",
          },
        },
        "gpt-4.1-mini",
      );
      expect(second.wokeRunIds).toHaveLength(1);
      wokeRunId = second.wokeRunIds[0] ?? "";
      const run = w.runs.find((r) => r.id === wokeRunId);
      expect(run?.missionId).toBe(missionId);
      expect(run?.triggerKind).toBe("mission_wakeup");
    });

    // Verify outbox enqueued the continuation run
    const outbox = await pool.query(
      "SELECT target_id FROM outbox WHERE workspace_id=$1 AND kind='run' AND target_id=$2",
      [id, wokeRunId],
    );
    expect(outbox.rowCount).toBe(1);

    // Verify autonomous due timer wakeup via tickMissions
    const dueTime = new Date("2026-11-20T12:00:00.000Z");
    await store.change(id, async (w, sql) => {
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId,
        kind: "timer",
        targetId: "timer:ci-check-1",
        reason: "Recheck CI status",
        dueAt: dueTime.toISOString(),
      });
      const woke = await tickMissions(sql, w, "gpt-4.1-mini", {
        now: new Date("2026-11-20T12:01:00.000Z"),
      });
      expect(woke).toBe(1);
    });

    // Verify mission detail + cancellation cancels active waits and runs
    await store.change(id, async (w, sql) => {
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId,
        kind: "timer",
        targetId: "timer:ci-check-2",
        dueAt: new Date("2026-11-21T00:00:00.000Z").toISOString(),
      });
      const cancelled = await cancelMission(sql, w, "101", missionId);
      expect(cancelled.status).toBe("cancelled");
      const detail = await missionDetail(sql, w.id, missionId);
      expect(detail.mission.artifacts).toHaveLength(2);
      expect(detail.waits.every((wait) => wait.status !== "pending")).toBe(
        true,
      );
    });
  });

  test("event-triggered automations deduplicate events, respect cooldowns, and watcher dedupe suppresses repeats", async () => {
    const id = await createFixtureWorkspace("Event Automations");

    let workflowId = "";
    await store.change(id, (w) => {
      const { workflow } = activateWorkflow(
        w,
        "101",
        workflowSchema.parse({
          name: "Main CI failure triage",
          task: "Analyze why CI failed on main",
          chatId: "101",
          topicId: 0,
          recurrence: {
            frequency: "daily",
            hour: 9,
            minute: 0,
            timezone: "UTC",
          },
          trigger: {
            kind: "github_event",
            event: "check_suite_failed",
            branch: "main",
            cooldownMinutes: 15,
          },
          deliveryMode: "on_condition",
          github: { revision: 1, repositoryIds: [1001] },
        }),
      );
      workflowId = workflow.id;
    });

    const t0 = new Date("2026-11-20T15:00:00.000Z");
    await store.change(id, async (w, sql) => {
      const first = await dispatchAutomationEvent(
        sql,
        w,
        {
          kind: "github_event",
          event: "check_suite_failed",
          eventKey: "ci:1001:sha1",
          repositoryId: 1001,
          repository: "acme/backend",
          branch: "main",
          sha: "sha1",
        },
        "gpt-4.1-mini",
        t0,
      );
      expect(first).toHaveLength(1);

      // Duplicate eventKey blocked
      const dup = await dispatchAutomationEvent(
        sql,
        w,
        {
          kind: "github_event",
          event: "check_suite_failed",
          eventKey: "ci:1001:sha1",
          repositoryId: 1001,
          repository: "acme/backend",
          branch: "main",
          sha: "sha1",
        },
        "gpt-4.1-mini",
        new Date(t0.getTime() + 20 * 60_000),
      );
      expect(dup).toHaveLength(0);

      // Different eventKey within 15m cooldown blocked
      const withinCooldown = await dispatchAutomationEvent(
        sql,
        w,
        {
          kind: "github_event",
          event: "check_suite_failed",
          eventKey: "ci:1001:sha2",
          repositoryId: 1001,
          repository: "acme/backend",
          branch: "main",
          sha: "sha2",
        },
        "gpt-4.1-mini",
        new Date(t0.getTime() + 5 * 60_000),
      );
      expect(withinCooldown).toHaveLength(0);

      // Watcher alert dedupe allows first alert and suppresses repeat within cooldown
      expect(
        await recordWatcherDedupe(sql, w.id, workflowId, "err:502", 30, t0),
      ).toBe(true);
      expect(
        await recordWatcherDedupe(
          sql,
          w.id,
          workflowId,
          "err:502",
          30,
          new Date(t0.getTime() + 10 * 60_000),
        ),
      ).toBe(false);
    });
  });

  test("per-repository sequential queue serializes tasks, supports pin/pause/resume, and carries over verified artifacts within scope", async () => {
    const id = await createFixtureWorkspace("Repo Queue");

    let item1Id = "";
    let item2Id = "";
    let item3Id = "";
    await store.change(id, async (w, sql) => {
      const a = await enqueueRepoTask(sql, w, {
        repositoryId: 1001,
        actor: "101",
        chatId: "101",
        topicId: 0,
        title: "Task 1: add health endpoint",
      });
      const b = await enqueueRepoTask(sql, w, {
        repositoryId: 1001,
        actor: "101",
        chatId: "101",
        topicId: 0,
        title: "Task 2: update docs",
      });
      const c = await enqueueRepoTask(sql, w, {
        repositoryId: 1001,
        actor: "101",
        chatId: "101",
        topicId: 0,
        title: "Task 3: urgent hotfix",
      });
      item1Id = a.item.id;
      item2Id = b.item.id;
      item3Id = c.item.id;
      expect(a.item.status).toBe("running");
      expect(b.item.status).toBe("queued");
      expect(c.item.status).toBe("queued");

      // Pin task 3 ahead of task 2
      const pinned = await pinRepoQueueItem(sql, w, "101", 1001, item3Id);
      expect(pinned.priority).toBeGreaterThan(0);

      // Completing task 1 promotes pinned task 3 with task 1's verified PR artifact carryover!
      const done = await completeRepoQueueItem(sql, w, 1001, item1Id, {
        status: "completed",
        summary: "Added /healthz endpoint",
        branch: "feat/healthz",
        commitSha: "a".repeat(40),
        prNumber: 77,
        prUrl: "https://github.com/acme/backend/pull/77",
      });
      expect(done.promoted?.id).toBe(item3Id);
      expect(done.promoted?.carryover?.prNumber).toBe(77);
      expect(done.promoted?.carryover?.branch).toBe("feat/healthz");

      // Pause queue, cancel running task 3 -> task 2 stays queued while paused
      await setRepoQueuePaused(sql, w, "101", 1001, true);
      const cancelled = await cancelRepoQueueItem(sql, w, "101", 1001, item3Id);
      expect(cancelled.promoted).toBeUndefined();

      // Resume queue -> promotes task 2 automatically!
      const resumed = await setRepoQueuePaused(sql, w, "101", 1001, false);
      expect(resumed.promoted?.id).toBe(item2Id);

      const queues = await listRepoQueues(sql, w);
      const backendQueue = queues.find((q) => q.queue.repositoryId === 1001);
      expect(backendQueue?.running.map((i) => i.id)).toEqual([item2Id]);
      expect(backendQueue?.recent.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("cross-repo parallel and dependent mission dispatch plus autonomy persistence work cleanly", async () => {
    const id = await createFixtureWorkspace("Cross Repo");

    await store.change(id, async (w, sql) => {
      updateWorkspaceAutonomy(w, "101", {
        revision: 0,
        defaultMode: "check_in",
      });
      updateRepositoryAutonomy(w, "101", 1001, {
        revision: 1,
        mode: "supervised",
      });
      expect(autonomyView(w).defaultMode).toBe("check_in");
      expect(
        evaluateAutonomy(w, "github_issue_write", 1001).requiresApproval,
      ).toBe(true);
      expect(
        evaluateAutonomy(w, "github_issue_write", 1002).allowedAutomatic,
      ).toBe(true);
      expect(
        evaluateAutonomy(w, "github_pr_merge", 1002).requiresApproval,
      ).toBe(true);

      const m = await missionCreate(sql, {
        workspaceId: w.id,
        actor: "101",
        chatId: "101",
        topicId: 0,
        status: "active",
        goal: "Ship API update and update landing docs",
        originSourceIds: ["src-99"],
        autonomyMode: "check_in",
        autonomyRevision: 2,
      });

      const dispatched = await dispatchCrossRepoMission(sql, w, {
        missionId: m.id,
        actor: "101",
        chatId: "101",
        topicId: 0,
        mode: "parallel",
        targets: [
          { repositoryId: 1001, title: "Update backend API" },
          { repositoryId: 1002, title: "Update landing docs" },
        ],
      });
      expect(dispatched.enqueued).toHaveLength(2);
      const detail = await missionDetail(sql, w.id, m.id);
      expect(detail.mission.status).toBe("waiting");
      expect(detail.waits).toHaveLength(2);
      expect(
        detail.waits.every((wait) => wait.joinGroup === dispatched.joinGroup),
      ).toBe(true);
      const loaded = await missionGet(sql, w.id, m.id);
      expect(loaded.status).toBe("waiting");
    });
  });

  test("multi-wait large fan-out wakeup stays under 4000-char task limit and preserves repo autonomy overrides", async () => {
    const id = await createFixtureWorkspace("Wakeup Bounds and Repo Autonomy");

    let missionId = "";
    let wokeRunId = "";
    await store.change(id, async (w, sql) => {
      // Workspace default is supervised; repo 1001 overrides to check_in.
      updateRepositoryAutonomy(w, "101", 1001, {
        revision: 0,
        mode: "check_in",
      });
      const m = await missionCreate(sql, {
        workspaceId: w.id,
        actor: "101",
        chatId: "101",
        topicId: 0,
        status: "waiting",
        goal: "Coordinate multi-repository refactor and verification. ".repeat(
          35,
        ),
        originSourceIds: ["src-large"],
        autonomyMode: "check_in",
        autonomyRevision: 1,
        repositoryId: 1001,
      });
      missionId = m.id;
      for (let i = 1; i <= 4; i++) {
        await waitCreate(sql, {
          workspaceId: w.id,
          missionId: m.id,
          joinGroup: "jg-fanout",
          joinMode: "all",
          kind: "coding_task",
          targetId: `task-fanout-${i}`,
          reason: `Parallel task ${i}: ${"context ".repeat(30)}`,
        });
      }
      for (let i = 1; i <= 4; i++) {
        const res = await resolveMissionWait(
          sql,
          w,
          "coding_task",
          `task-fanout-${i}`,
          {
            status: "satisfied",
            summary: `Task ${i} completed cleanly: ${"detailed diff ".repeat(120)}`,
            data: { pr: { number: i, body: "x".repeat(1500) } },
          },
          "gpt-4.1-mini",
        );
        if (i < 4) expect(res.wokeRunIds).toHaveLength(0);
        else {
          expect(res.wokeRunIds).toHaveLength(1);
          wokeRunId = res.wokeRunIds[0] ?? "";
        }
      }

      const wokeMission = await missionGet(sql, w.id, missionId);
      expect(wokeMission.status).toBe("active");
      expect(wokeMission.error).toBeUndefined();
      // Repo-level check_in override must survive wakeup instead of degrading to workspace default.
      expect(wokeMission.autonomyMode).toBe("check_in");

      const wokeRun = w.runs.find((r) => r.id === wokeRunId);
      expect(wokeRun).toBeDefined();
      expect(wokeRun?.task.length).toBeLessThanOrEqual(4000);
      expect(wokeRun?.repository?.id).toBe(1001);

      if (wokeRun) {
        const snap = await missionContextSnapshot(sql, w, wokeRun);
        expect(snap.activeMission?.repositoryId).toBe(1001);
        expect(snap.activeMission?.waits).toHaveLength(4);
      }

      // Tightening repo 1001 back to supervised takes effect immediately on the next wakeup.
      updateRepositoryAutonomy(w, "101", 1001, {
        revision: 1,
        mode: "supervised",
      });
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId,
        kind: "timer",
        targetId: "timer-tighten",
        reason: "Recheck autonomy tightening",
        dueAt: new Date(Date.now() - 1000).toISOString(),
      });
      await resolveMissionWait(
        sql,
        w,
        "timer",
        "timer-tighten",
        { status: "satisfied", summary: "Due" },
        "gpt-4.1-mini",
      );
      const tightened = await missionGet(sql, w.id, missionId);
      expect(tightened.autonomyMode).toBe("supervised");
    });
  });

  test("mission_wakeup supports explicit and implicit silent continuation without flashing drafts or polluting threads, and passes subagentContext", async () => {
    const id = await createFixtureWorkspace("Silent Mission Wakeup");
    const telegramCalls: { method: string; params: Record<string, unknown> }[] =
      [];
    const fakeTelegram: Telegram = {
      async call<T>(method: string, params = {}) {
        telegramCalls.push({ method, params });
        return { message_id: 9001 } as T;
      },
    };
    const execSetup = new SetupService(
      store,
      encryptionKey,
      "http://localhost:3000",
      () => fakeTelegram,
    );
    const deployment = await store.deployment();
    Object.assign(deployment, {
      active: true,
      paused: false,
      bot: { id: "999", username: "orch_bot", visibleAll: true },
      credentials: {
        bot: encrypt(encryptionKey, "bot", "999:fake"),
        model: encrypt(encryptionKey, "model", "fake"),
        webhook: encrypt(encryptionKey, "webhook", "secret"),
      },
    });
    await store.saveDeployment(store.pool, deployment);

    // 1. Explicit silent wakeup (manage_mission action="continue_silently")
    let missionId = "";
    let explicitRunId = "";
    await store.change(id, async (w, sql) => {
      const m = await missionCreate(sql, {
        workspaceId: w.id,
        actor: "101",
        chatId: "101",
        topicId: 0,
        botId: "999",
        status: "waiting",
        goal: "Watch CI and report only when ready",
        originSourceIds: ["src-s1"],
        autonomyMode: "supervised",
        autonomyRevision: 0,
        repositoryId: 1001,
      });
      missionId = m.id;
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId: m.id,
        kind: "timer",
        targetId: "timer-explicit-silent",
        reason: "Check CI",
        dueAt: new Date(Date.now() - 1000).toISOString(),
      });
      const woke = await resolveMissionWait(
        sql,
        w,
        "timer",
        "timer-explicit-silent",
        { status: "satisfied", summary: "CI check due" },
        "gpt-4.1-mini",
        { botId: "999" },
      );
      explicitRunId = woke.wokeRunIds[0] ?? "";
    });

    let capturedSubagentCtx: SubagentContext | undefined;
    const explicitSilentRunner: AgentRunner = {
      async run(input) {
        capturedSubagentCtx = input.subagentContext;
        const schedule = input.tools.find(
          (t) => t.name === "schedule_mission_followup",
        );
        const manage = input.tools.find((t) => t.name === "manage_mission");
        if (!schedule || !manage)
          throw new Error("orchestration tools missing");
        await schedule.execute("call-sched-1", {
          delayMinutes: 10,
          reason: "CI still running; check again in 10m",
        });
        await manage.execute("call-silent-1", {
          action: "continue_silently",
          summary: "CI still in progress; rescheduled check.",
        });
        return {
          text: "",
          status: "partial",
          reason: "empty_response",
          turns: 1,
          tools: 2,
          transcript: [],
        };
      },
    };

    await new Executor(store, execSetup, explicitSilentRunner).execute(
      id,
      explicitRunId,
    );

    // No streaming draft flashed for background wakeup
    expect(telegramCalls).toHaveLength(0);
    // subagentContext populated with selectedRepository, timezone, activeMission
    expect(capturedSubagentCtx?.selectedRepository).toEqual({
      id: 1001,
      full_name: "acme/backend",
    });
    expect(capturedSubagentCtx?.timezone).toBe("UTC");
    expect(capturedSubagentCtx?.activeMission?.id).toBe(missionId);
    expect(capturedSubagentCtx?.activeMission?.repositoryId).toBe(1001);

    const afterExplicit = await store.read(id);
    const explicitRun = afterExplicit.runs.find((r) => r.id === explicitRunId);
    expect(explicitRun?.status).toBe("succeeded");
    expect(explicitRun?.error).toBeUndefined();
    expect(explicitRun?.result).toBe(
      "CI still in progress; rescheduled check.",
    );
    expect(
      afterExplicit.deliveries.filter((d) => d.runId === explicitRunId),
    ).toHaveLength(0);
    expect(
      afterExplicit.messages.some((m) => m.id === `answer:${explicitRunId}`),
    ).toBe(false);
    expect(
      afterExplicit.audit.some(
        (a) => a.action === "run.silent" && a.target === explicitRunId,
      ),
    ).toBe(true);

    // 2. Implicit silent wakeup: model schedules next follow-up (mission is waiting) and returns empty text without calling continue_silently
    let implicitRunId = "";
    await store.change(id, async (w, sql) => {
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId,
        kind: "timer",
        targetId: "timer-implicit-silent",
        reason: "Second CI check",
        dueAt: new Date(Date.now() - 1000).toISOString(),
      });
      const woke = await resolveMissionWait(
        sql,
        w,
        "timer",
        "timer-implicit-silent",
        {
          status: "satisfied",
          summary: "Second CI check due",
          artifact: { kind: "summary", label: "progress", value: "step-2" },
        },
        "gpt-4.1-mini",
        { botId: "999" },
      );
      implicitRunId = woke.wokeRunIds[0] ?? "";
    });

    const implicitSilentRunner: AgentRunner = {
      async run(input) {
        const schedule = input.tools.find(
          (t) => t.name === "schedule_mission_followup",
        );
        if (!schedule) throw new Error("schedule tool missing");
        await schedule.execute("call-sched-2", {
          delayMinutes: 15,
          reason: "Waiting for deploy job",
        });
        return {
          text: "",
          status: "partial",
          reason: "empty_response",
          turns: 1,
          tools: 1,
          transcript: [],
        };
      },
    };

    await new Executor(store, execSetup, implicitSilentRunner).execute(
      id,
      implicitRunId,
    );
    const afterImplicit = await store.read(id);
    const implicitRun = afterImplicit.runs.find((r) => r.id === implicitRunId);
    expect(implicitRun?.status).toBe("succeeded");
    expect(implicitRun?.error).toBeUndefined();
    expect(
      afterImplicit.deliveries.filter((d) => d.runId === implicitRunId),
    ).toHaveLength(0);

    // 3. Non-waiting wakeup returning empty text still surfaces empty_response truthfully
    let emptyFailureRunId = "";
    await store.change(id, async (w, sql) => {
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId,
        kind: "github_event",
        targetId: "pr:77",
        reason: "PR merged",
      });
      const woke = await resolveMissionWait(
        sql,
        w,
        "github_event",
        "pr:77",
        { status: "satisfied", summary: "PR #77 merged" },
        "gpt-4.1-mini",
        { botId: "999" },
      );
      emptyFailureRunId = woke.wokeRunIds[0] ?? "";
    });

    const emptyRunner: AgentRunner = {
      async run() {
        return {
          text: "",
          status: "partial",
          reason: "empty_response",
          turns: 1,
          tools: 0,
          transcript: [],
        };
      },
    };
    await new Executor(store, execSetup, emptyRunner).execute(
      id,
      emptyFailureRunId,
    );
    const afterEmpty = await store.read(id);
    const emptyRun = afterEmpty.runs.find((r) => r.id === emptyFailureRunId);
    expect(emptyRun?.status).toBe("partial");
    expect(emptyRun?.error).toBe("empty_response");
    expect(
      afterEmpty.deliveries.filter((d) => d.runId === emptyFailureRunId),
    ).toHaveLength(1);
  });
});
