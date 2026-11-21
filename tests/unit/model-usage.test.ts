import { expect, test } from "bun:test";
import type { DevelopmentTask } from "../../src/coding/development.ts";
import type { ReviewTask } from "../../src/review-bot/config.ts";
import {
  deriveAdminCheckUsageEvent,
  deriveCodingUsageEvent,
  deriveReviewBotUsageEvent,
  deriveRunAttemptUsageEvent,
  estimateTokenBreakdownCostUsd,
  USAGE_SOURCE_KINDS,
} from "../../src/usage/model-usage.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

test("every usage source produces complete, non-empty source attribution", () => {
  const w = workspace();
  w.workflows.push({
    id: "wf-1",
    version: 1,
    owner: "101",
    status: "active",
    spec: {
      name: "Daily PR Digest",
      task: "Summarize PRs",
      chatId: "101",
      topicId: 0,
      recurrence: { frequency: "daily", hour: 9, minute: 0, timezone: "UTC" },
      format: "Brief",
      windowDays: 1,
    },
    versions: [],
  });
  const existingChat = w.chats.find((c) => c.id === "-100100");
  if (existingChat) existingChat.title = "Engineering";
  else
    w.chats.push({
      id: "-100100",
      title: "Engineering",
      active: true,
      collection: true,
      linkedAt: new Date().toISOString(),
      visibleAll: true,
    });

  const seenKinds = new Set<string>();

  // 1. Chat + internal purposes
  const chatRun = createRun(w, "101", "Hello", "-100100", 0, "gpt-4.1-mini");
  for (const purpose of [
    undefined,
    "compaction",
    "followup",
    "research_subagent",
    "memory_extract",
    "memory_consolidate",
    "skill_extract",
  ] as const) {
    const ev = deriveRunAttemptUsageEvent(w, chatRun, {
      id: `att-${purpose ?? "chat"}`,
      model: "gpt-4.1-mini",
      purpose,
      reserved: 0.002,
      actual: 0.0012,
      status: "settled",
      at: new Date().toISOString(),
      tokens: { input: 500, output: 120, cacheRead: 300, cacheWrite: 0 },
      estimatedInputTokens: 780,
      latencyMs: 640,
      stopReason: "stop",
      toolCalls: 1,
    });
    seenKinds.add(ev.sourceKind);
    expect(ev.sourceId).toBe(chatRun.id);
    expect(ev.sourceLabel.length).toBeGreaterThan(0);
    expect(ev.sourcePath).toBe(`/admin/runs/${chatRun.id}`);
    expect(ev.totalTokens).toBe(920);
    expect(ev.tokenBreakdownKnown).toBe(true);
    expect(ev.estimatedInputTokens).toBe(780);
    expect(ev.latencyMs).toBe(640);
    expect(ev.toolCalls).toBe(1);
    if (!purpose) expect(ev.sourceLabel).toBe("Group · Engineering");
  }

  // 2. Workflow run
  const wfRun = createRun(w, "101", "Run digest", "101", 0, "gpt-4.1-mini", {
    workflowId: "wf-1",
  });
  const wfEv = deriveRunAttemptUsageEvent(w, wfRun, {
    id: "att-wf",
    reserved: 0.001,
    actual: 0.0008,
    status: "settled",
    at: new Date().toISOString(),
    tokens: { input: 400, output: 100, cacheRead: 0, cacheWrite: 0 },
  });
  seenKinds.add(wfEv.sourceKind);
  expect(wfEv.sourceKind).toBe("workflow");
  expect(wfEv.sourceLabel).toBe("Workflow · Daily PR Digest");

  // 3. Mission wakeup run
  const missionRun = createRun(
    w,
    "101",
    "Continue mission",
    "101",
    0,
    "gpt-4.1-mini",
  );
  missionRun.missionId = "mission-abc12345";
  missionRun.triggerKind = "mission_wakeup";
  const missionEv = deriveRunAttemptUsageEvent(w, missionRun, {
    id: "att-mission",
    reserved: 0.001,
    actual: 0.0009,
    status: "settled",
    at: new Date().toISOString(),
    tokens: { input: 300, output: 80, cacheRead: 100, cacheWrite: 0 },
  });
  seenKinds.add(missionEv.sourceKind);
  expect(missionEv.sourceKind).toBe("mission");
  expect(missionEv.sourceLabel).toContain("Mission");

  // 4. Admin self-check
  const checkEv = deriveAdminCheckUsageEvent(
    w,
    {
      id: "chk-1",
      adminId: "admin-1",
      actor: "101",
      model: "gpt-4.1-mini",
      providerName: "OpenAI",
      at: new Date().toISOString(),
      status: "succeeded",
      attempts: [],
    },
    {
      id: "att-chk",
      reserved: 0.0005,
      actual: 0.0004,
      status: "settled",
      at: new Date().toISOString(),
      tokens: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0 },
    },
  );
  seenKinds.add(checkEv.sourceKind);
  expect(checkEv.sourceKind).toBe("self_check");
  expect(checkEv.sourceLabel).toBe("Admin self-check");

  // 5. Codex coding_task and coding_conversation
  const codingTask = {
    id: "task-1",
    workspaceId: w.id,
    actor: "101",
    payload: {
      repository: "acme/api",
      authMode: "provider_key",
    },
    runnerModel: {
      id: "prov-1",
      version: 1,
      name: "OpenAI Prod",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    },
    phase: "work",
  } as unknown as DevelopmentTask;

  for (const kind of ["coding_task", "coding_conversation"] as const) {
    const ev = deriveCodingUsageEvent({
      task: codingTask,
      attemptId: `c-${kind}`,
      kind,
      status: "settled",
      tokens: 1500,
      tokenUsage: {
        input: 800,
        cacheRead: 400,
        cacheWrite: 0,
        output: 300,
        reasoning: 100,
        total: 1500,
      },
      latencyMs: 4200,
    });
    seenKinds.add(ev.sourceKind);
    expect(ev.sourceLabel).toContain("acme/api");
    expect(ev.providerName).toBe("OpenAI Prod");
    expect(ev.tokenBreakdownKnown).toBe(true);
    expect(ev.reasoningTokens).toBe(100);
    expect(ev.pricingUnknown).toBe(false);
    expect(ev.accountedUsd).toBeGreaterThan(0);
  }

  // 6. Review Bot
  const reviewTask = {
    id: "rev-1",
    actor: "101",
    number: 42,
    mode: "review",
    state: "completed",
    attemptId: "rev-att-1",
    payload: {
      repository: "acme/api",
      authMode: "provider_key",
    },
    runnerModel: {
      id: "prov-1",
      version: 1,
      name: "OpenAI Prod",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    },
    tokens: 2200,
    tokenUsage: {
      input: 1200,
      cacheRead: 500,
      cacheWrite: 0,
      output: 500,
      total: 2200,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as ReviewTask;

  const revEv = deriveReviewBotUsageEvent(w, reviewTask);
  expect(revEv).toBeDefined();
  if (revEv) {
    seenKinds.add(revEv.sourceKind);
    expect(revEv.sourceKind).toBe("review_bot");
    expect(revEv.sourceLabel).toBe("Review Bot · acme/api #42");
    expect(revEv.accountedUsd).toBeGreaterThan(0);
  }

  // Every single UsageSourceKind is covered!
  for (const kind of USAGE_SOURCE_KINDS) {
    expect(seenKinds.has(kind)).toBe(true);
  }

  // Unknown custom model pricing remains unknown instead of fabricating costs.
  expect(
    estimateTokenBreakdownCostUsd("custom/unknown-model", {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ).toEqual({ pricingUnknown: true });
});
