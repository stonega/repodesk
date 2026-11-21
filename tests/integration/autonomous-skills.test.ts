import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { claim } from "../../src/admin/auth.ts";
import type { AgentInput, AgentRunner } from "../../src/agent/runtime.ts";
import type { DevelopmentTask } from "../../src/coding/development.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { settingsSchema } from "../../src/domain.ts";
import { sweep } from "../../src/privacy/service.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { changeSkill } from "../../src/skills/catalog.ts";
import { compileCodingSkillsBriefing } from "../../src/skills/coding-briefing.ts";
import { SkillExtractionService } from "../../src/skills/extraction-service.ts";
import { queryModelUsageAnalytics } from "../../src/usage/model-usage.ts";
import { createRun, enrollOwner } from "../../src/workspaces/service.ts";

const baseUrl = process.env.TEST_DATABASE_URL;
const describeDb = baseUrl ? describe : describe.skip;

function fakeRunner(responses: string[]): AgentRunner {
  let idx = 0;
  return {
    async run(input: AgentInput) {
      const text =
        responses[idx++] ??
        responses.at(-1) ??
        '{"action":"noop","rationale":"empty","confidence":"low"}';
      const attemptId = await input.reserve(0.01, input.purpose, {
        model: input.model.id,
        estimatedInputTokens: 400,
      });
      await input.checkpoint(
        {
          role: "assistant",
          content: [{ type: "text", text }],
          api: input.model.api,
          provider: input.model.provider,
          model: input.model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 420,
            output: 180,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 600,
            cost: {
              input: 0.002,
              output: 0.004,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.006,
            },
          },
        },
        attemptId,
        input.purpose,
        {
          model: input.model.id,
          latencyMs: 120,
          stopReason: "stop",
          toolCalls: 0,
        },
      );
      return {
        status: "succeeded" as const,
        text,
        turns: 1,
        tools: 0,
        transcript: [],
      };
    },
  };
}

describeDb("autonomous skill extraction end-to-end integration", () => {
  let pool: Pool;
  let adminPool: Pool;
  let dbName: string;
  let store: Store;
  let setup: SetupService;
  let adminId: string;
  const encryptionKey = "ef".repeat(32);

  beforeAll(async () => {
    if (!baseUrl) return;
    const parsed = new URL(baseUrl);
    dbName = `repodesk_skills_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    adminPool = database(baseUrl);
    await adminPool.query(`CREATE DATABASE ${dbName}`);
    parsed.pathname = `/${dbName}`;
    pool = database(parsed.toString());
    await migrate(pool);
    store = new Store(pool, undefined, encryptionKey);
    setup = new SetupService(store, encryptionKey, "http://localhost:3000");
    await claim(pool, "skills-admin", "a long test password");
    adminId = (await pool.query("SELECT id FROM admins LIMIT 1")).rows[0].id;
    const d = await store.deployment();
    Object.assign(d, {
      active: true,
      paused: false,
      model: "gpt-4.1-mini",
      bot: { id: "bot-1", username: "repodesk_bot", visibleAll: true },
      credentials: {
        bot: encrypt(encryptionKey, "bot", "bot-1:fake"),
        model: encrypt(encryptionKey, "model", "sk-test-autonomous-skills-key"),
      },
    });
    await store.saveDeployment(pool, d);
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

  test("extracts project skill from Codex task, meters skill_extract usage, injects briefing, and evolves global skill from conversation", async () => {
    const { id: wsId } = await setup.createWorkspace(
      { id: adminId, username: "skills-admin", operator: true },
      settingsSchema.parse({
        name: "Autonomous Skills Integration",
        timezone: "UTC",
        monthlyBudgetUsd: 50,
      }),
    );

    const taskId = randomUUID();
    await store.change(wsId, async (w, sql) => {
      enrollOwner(w, "101");
      const owner = w.members.find((m) => m.id === "101");
      if (owner) {
        owner.github = {
          id: 101,
          login: "owner",
          status: "connected",
          connectionRevision: 1,
          syncedAt: new Date().toISOString(),
          repositories: [
            {
              id: 2001,
              full_name: "acme/backend",
              default_branch: "main",
              private: true,
              permissions: { pull: true, push: true, admin: true },
            },
            {
              id: 2002,
              full_name: "acme/frontend",
              default_branch: "main",
              private: true,
              permissions: { pull: true, push: true, admin: true },
            },
          ],
        };
      }
      w.github = {
        revision: 1,
        installationId: 88,
        repositories: [
          {
            id: 2001,
            full_name: "acme/backend",
            default_branch: "main",
            private: true,
          },
          {
            id: 2002,
            full_name: "acme/frontend",
            default_branch: "main",
            private: true,
          },
        ],
      };

      const task: DevelopmentTask = {
        id: taskId,
        workspaceId: wsId,
        actor: "101",
        chatId: "101",
        topicId: 0,
        botId: "bot-1",
        sourceId: "src-coding-1",
        state: "review",
        phase: "work",
        revision: 1,
        consumedRevision: 1,
        fence: 1,
        attempts: 2,
        canImplement: true,
        canPublish: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payload: {
          installationId: 88,
          repositoryId: 2001,
          repository: "acme/backend",
          githubRevision: 1,
          configRevision: 1,
          baseBranch: "main",
          backend: "podman",
          title: "Fix migration runner timeout",
          body: "Repair flaky migration startup in CI",
          authMode: "provider_key",
        },
        result: {
          status: "completed",
          intent: "implement",
          evidenceRevision: 1,
          evidence:
            "Ran migrations with TEST_DATABASE_URL set and passed 42 tests.",
          publishRequested: false,
          summary:
            "Fixed migration runner timeout by using transactional advisory locks and running bun run typecheck before tests.",
          question: null,
          title: "Fix migration runner timeout",
          body: "Added advisory lock guard.",
          verificationCommands: ["bun run typecheck", "bun test tests/unit/"],
        },
      };
      await sql.query(
        "INSERT INTO coding_tasks(workspace_id,id,data) VALUES($1,$2,$3)",
        [wsId, taskId, JSON.stringify(task)],
      );
    });

    const runner = fakeRunner([
      JSON.stringify({
        action: "create",
        rationale: "Reusable backend verification & migration locking rule.",
        confidence: "high",
        skill: {
          slug: "backend-migration-checks",
          name: "Backend migration checks",
          description:
            "Run typecheck and use advisory locks when touching acme/backend migrations.",
          body: "When modifying migrations/ in acme/backend, use advisory locks and run bun run typecheck before bun test.",
          scope: { kind: "project", repositoryId: 2001 },
          audience: "coding",
          tools: ["load_skill"],
        },
      }),
      JSON.stringify({
        action: "create",
        rationale: "Reusable cross-project incident postmortem template.",
        confidence: "high",
        skill: {
          slug: "incident-summary-format",
          name: "Incident summary format",
          description: "Standardized summary structure for incident recaps.",
          body: "Always lead with customer impact, root cause, timeline, and concrete follow-up owners.",
          scope: { kind: "global" },
          audience: "chat",
          tools: ["read_chat_context", "load_skill"],
        },
      }),
      JSON.stringify({
        action: "update",
        targetSlug: "incident-summary-format",
        rationale: "User added detection-gap section to incident summaries.",
        confidence: "high",
        skill: {
          slug: "incident-summary-format",
          name: "Incident summary format",
          description:
            "Standardized summary structure including detection gaps.",
          body: "Always lead with customer impact, root cause, detection gap, timeline, and concrete follow-up owners.",
          scope: { kind: "global" },
          audience: "chat",
          tools: ["read_chat_context", "load_skill"],
        },
      }),
    ]);

    const service = new SkillExtractionService(store, setup, runner, 0);

    // 1. Tick extracts the Project coding skill from the completed Codex task.
    await service.tick(wsId);
    const afterCoding = await store.read(wsId);
    const projectSkill = afterCoding.skills.find(
      (s) => s.draft.slug === "backend-migration-checks",
    );
    expect(projectSkill).toBeDefined();
    expect(projectSkill?.enabled).toBe(true);
    expect(projectSkill?.auto?.sourceKind).toBe("coding_task");
    expect(projectSkill?.draft.scope).toEqual({
      kind: "project",
      repositoryId: 2001,
      repository: "acme/backend",
    });

    // Cold-start briefing injects it for acme/backend and NOT for acme/frontend.
    const backendBrief = compileCodingSkillsBriefing(afterCoding, 2001, {
      actor: "101",
    });
    const frontendBrief = compileCodingSkillsBriefing(afterCoding, 2002, {
      actor: "101",
    });
    expect(backendBrief?.text).toContain("Backend migration checks");
    expect(frontendBrief).toBeUndefined();

    // Model usage analytics recorded the `skill_extract` call!
    const analytics = await queryModelUsageAnalytics(pool, afterCoding, {
      range: "7d",
      source: "skill_extract",
      offset: 0,
      limit: 20,
    });
    expect(analytics.summary.calls).toBe(1);
    expect(analytics.items[0]?.sourceKind).toBe("skill_extract");
    expect(analytics.items[0]?.totalTokens).toBe(600);

    // 2. Seed an idle high-signal conversation thread -> extracts Global skill.
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await store.change(wsId, (w) => {
      const run = createRun(
        w,
        "101",
        "Draft incident recap",
        "101",
        0,
        "gpt-4o-mini",
        {
          botId: "bot-1",
        },
      );
      run.status = "succeeded";
      run.result = "Here is the incident recap.";
      run.tools = {
        c1: { name: "read_chat_context", state: "done" },
        c2: { name: "query_work_handoff", state: "done" },
      };
      const threadId = run.threadId ?? "thread-conv-1";
      w.messages.push(
        {
          id: "m-u1",
          chatId: "101",
          topicId: 0,
          threadId,
          runId: run.id,
          author: "101",
          role: "user",
          text: "Summarize the outage",
          at: past,
          expiresAt: future,
          directed: true,
        },
        {
          id: "m-a1",
          chatId: "101",
          topicId: 0,
          threadId,
          runId: run.id,
          author: "bot",
          role: "assistant",
          text: "Summary drafted.",
          at: past,
          expiresAt: future,
          directed: false,
        },
        {
          id: "m-u2",
          chatId: "101",
          topicId: 0,
          threadId,
          runId: run.id,
          author: "101",
          role: "user",
          text: "下次事故复盘都要用这个模板，先写影响和根因",
          at: past,
          expiresAt: future,
          directed: true,
        },
        {
          id: "m-a2",
          chatId: "101",
          topicId: 0,
          threadId,
          runId: run.id,
          author: "bot",
          role: "assistant",
          text: "好的，已按影响、根因、时间线和负责人整理。",
          at: past,
          expiresAt: future,
          directed: false,
        },
      );
    });

    await service.tick(wsId);
    const afterConv = await store.read(wsId);
    const globalSkill = afterConv.skills.find(
      (s) => s.draft.slug === "incident-summary-format",
    );
    expect(globalSkill).toBeDefined();
    expect(globalSkill?.enabled).toBe(true);
    expect(globalSkill?.draft.scope).toEqual({ kind: "global" });
    expect(globalSkill?.version).toBe(1);

    // 3. User sends a refinement message in the same thread -> updates skill to v2 automatically!
    await store.change(wsId, (w) => {
      const threadId = w.threads?.[0]?.id ?? "thread-conv-1";
      const runId = w.runs.at(-1)?.id;
      w.messages.push({
        id: "m-u3",
        chatId: "101",
        topicId: 0,
        threadId,
        runId,
        author: "101",
        role: "user",
        text: "以后再加一节 detection gap",
        at: past,
        expiresAt: future,
        directed: true,
      });
    });

    await service.tick(wsId);
    const afterUpdate = await store.read(wsId);
    const evolved = afterUpdate.skills.find(
      (s) => s.draft.slug === "incident-summary-format",
    );
    expect(evolved?.version).toBe(2);
    expect(evolved?.published).toHaveLength(2);
    expect(evolved?.draft.body).toContain("detection gap");
    expect(evolved?.auto?.revisions).toBe(2);

    // 4. Admin disables the auto skill -> suppression recorded; workspace deletion sweeps state cleanly.
    if (!evolved) throw new Error("Expected evolved skill");
    await store.change(wsId, (w) => {
      changeSkill(w, "101", evolved.id, evolved.version, "disable");
    });
    const afterDisable = await store.read(wsId);
    expect(
      afterDisable.skillExtraction?.suppressed.length,
    ).toBeGreaterThanOrEqual(1);

    await store.change(wsId, (w) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "deleted",
      };
      sweep(w);
    });
    const afterSweep = await store.read(wsId);
    expect(afterSweep.skillExtraction).toBeUndefined();
    expect(afterSweep.skills).toEqual([]);
  });
});
