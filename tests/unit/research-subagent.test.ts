import { expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { PiRunner, selectedModel } from "../../src/agent/runtime.ts";
import { RESEARCH_SUBAGENT_TOOL } from "../../src/agent/subagent.ts";

function streamMessage(message: AssistantMessage) {
  const stream = new AssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
    message,
  });
  stream.end(message);
  return stream;
}

const costUsage = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: {
    input: 0.001,
    output: 0.002,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.003,
  },
};

test("delegate_research runs isolated depth-1 read-only subagents, excludes write tools, and tracks budget", async () => {
  const model = selectedModel("gpt-4.1-mini");
  const seenSubagentToolSets: string[][] = [];
  const reservedPurposes: Array<string | undefined> = [];
  const checkpointedPurposes: Array<string | undefined> = [];

  const readTool: AgentTool = {
    name: "query_github_metadata",
    label: "Read GitHub",
    description: "Read",
    executionMode: "parallel",
    parameters: Type.Object({ repo: Type.String() }),
    execute: async (_id, raw) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            repo: (raw as { repo: string }).repo,
            stars: 42,
          }),
        },
      ],
      details: {},
    }),
  };
  const writeTool: AgentTool = {
    name: "start_development_task",
    label: "Start coding",
    description: "Write",
    executionMode: "sequential",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("Write tool must never be exposed to research subagent");
    },
  };

  let parentCall = 0;
  const runner = new PiRunner((m, context) => {
    const toolNames =
      getCurrentTools(context.messages)?.map((t) => t.name) ?? [];
    const systemText =
      context.messages.find((msg) => msg.role === "system")?.content ?? "";
    const isSubagent =
      typeof systemText === "string" &&
      systemText.includes("bounded, read-only research subagent");

    if (isSubagent) {
      seenSubagentToolSets.push(toolNames);
      // Verify security boundary is prepended to subagent prompt too
      expect(systemText).toStartWith("Security and instruction boundaries:");
      // Verify depth=1 and read-only isolation
      expect(toolNames).toContain("query_github_metadata");
      expect(toolNames).not.toContain(RESEARCH_SUBAGENT_TOOL);
      expect(toolNames).not.toContain("start_development_task");

      const hasToolResult = context.messages.some(
        (msg) => msg.role === "toolResult",
      );
      if (!hasToolResult) {
        return streamMessage({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `sub-call-${Math.random().toString(36).slice(2, 8)}`,
              name: "query_github_metadata",
              arguments: { repo: "acme/app" },
            },
          ],
          api: m.api,
          provider: m.provider,
          model: m.id,
          usage: costUsage,
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
      }
      return streamMessage({
        role: "assistant",
        content: [{ type: "text", text: "Repo acme/app has 42 stars." }],
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: costUsage,
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }

    parentCall++;
    if (parentCall === 1) {
      expect(toolNames).toContain(RESEARCH_SUBAGENT_TOOL);
      return streamMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "dr-1",
            name: RESEARCH_SUBAGENT_TOOL,
            arguments: {
              tasks: [
                {
                  id: "repo-a",
                  focus: "Check acme/app",
                  question: "How many stars does acme/app have?",
                },
                {
                  id: "repo-b",
                  focus: "Check acme/docs",
                  question: "How many stars does acme/docs have?",
                },
              ],
            },
          },
        ],
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: costUsage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      });
    }

    const toolResult = context.messages.find(
      (msg) => msg.role === "toolResult" && msg.toolCallId === "dr-1",
    );
    expect(toolResult).toBeDefined();
    return streamMessage({
      role: "assistant",
      content: [{ type: "text", text: "Both repos checked: 42 stars." }],
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: costUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  });

  const result = await runner.run({
    actor: "101",
    runId: "r-sub",
    model,
    apiKey: "test",
    system: "Parent orchestrator",
    prompt: "Investigate both repositories",
    transcript: [],
    enableSubagent: true,
    tools: [readTool, writeTool],
    signal: AbortSignal.timeout(5000),
    guard: async () => {},
    reserve: async (_amount, purpose) => {
      reservedPurposes.push(purpose);
      return `att-${reservedPurposes.length}`;
    },
    checkpoint: async (_msg, _attemptId, purpose) => {
      checkpointedPurposes.push(purpose);
    },
  });

  expect(result.text).toBe("Both repos checked: 42 stars.");
  expect(seenSubagentToolSets.length).toBe(4); // 2 tasks x 2 turns each
  expect(reservedPurposes.filter((p) => p === "research_subagent").length).toBe(
    4,
  );
  expect(
    checkpointedPurposes.filter((p) => p === "research_subagent").length,
  ).toBeGreaterThanOrEqual(4);
  // Parent transcript should only contain parent turns + the delegate_research toolResult, not subagent internals
  const drResultMsg = result.transcript.find(
    (m) => m.role === "toolResult" && m.toolCallId === "dr-1",
  );
  expect(drResultMsg).toBeDefined();
  const payload = JSON.parse(
    (drResultMsg as { content: { text: string }[] }).content[0]?.text ?? "{}",
  );
  expect(payload.untrustedReferenceData).toBe(true);
  expect(payload.results).toHaveLength(2);
  expect(payload.results[0].status).toBe("succeeded");
  expect(payload.results[0].findings).toContain("42 stars");
});

test("delegate_research forwards scoped runtime context (repository, time, timezone, active mission) to subagents", async () => {
  const model = selectedModel("gpt-4.1-mini");
  const subagentPrompts: Record<string, unknown>[] = [];

  const readTool: AgentTool = {
    name: "query_github_metadata",
    label: "Read GitHub",
    description: "Read",
    executionMode: "parallel",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      details: {},
    }),
  };

  let parentCall = 0;
  const runner = new PiRunner((m, context) => {
    const systemText =
      context.messages.find((msg) => msg.role === "system")?.content ?? "";
    const isSubagent =
      typeof systemText === "string" &&
      systemText.includes("bounded, read-only research subagent");
    if (isSubagent) {
      const userMsg = context.messages.find((msg) => msg.role === "user");
      const rawText =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : (userMsg?.content
              ?.filter(
                (p): p is { type: "text"; text: string } => p.type === "text",
              )
              .map((p) => p.text)
              .join("") ?? "{}");
      subagentPrompts.push(JSON.parse(rawText));
      return streamMessage({
        role: "assistant",
        content: [{ type: "text", text: "Checked repo 7001." }],
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: costUsage,
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
    parentCall++;
    if (parentCall === 1) {
      return streamMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "dr-ctx",
            name: RESEARCH_SUBAGENT_TOOL,
            arguments: {
              tasks: [
                {
                  id: "ctx-check",
                  focus: "Recent PRs",
                  question: "What PRs merged today?",
                },
              ],
            },
          },
        ],
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: costUsage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      });
    }
    return streamMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: costUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  });

  await runner.run({
    actor: "101",
    runId: "r-sub-ctx",
    model,
    apiKey: "test",
    system: "Parent",
    prompt: "Check today's PRs",
    transcript: [],
    enableSubagent: true,
    subagentContext: {
      now: "2026-11-21T09:00:00.000Z",
      timezone: "Asia/Taipei",
      chatId: "-100100",
      topicId: 42,
      isGroup: true,
      selectedRepository: { id: 7001, full_name: "acme/backend" },
      groupRepository: {
        repositoryId: 7001,
        repository: "acme/backend",
        available: true,
      },
      activeMission: {
        id: "m-1",
        goal: "Monitor release readiness",
        status: "active",
        repositoryId: 7001,
      },
    },
    tools: [readTool],
    signal: AbortSignal.timeout(5000),
    guard: async () => {},
    reserve: async () => "att-1",
    checkpoint: async () => {},
  });

  expect(subagentPrompts).toHaveLength(1);
  expect(subagentPrompts[0]?.context).toEqual({
    now: "2026-11-21T09:00:00.000Z",
    timezone: "Asia/Taipei",
    chatId: "-100100",
    topicId: 42,
    isGroup: true,
    selectedRepository: { id: 7001, full_name: "acme/backend" },
    groupRepository: {
      repositoryId: 7001,
      repository: "acme/backend",
      available: true,
    },
    activeMission: {
      id: "m-1",
      goal: "Monitor release readiness",
      status: "active",
      repositoryId: 7001,
    },
  });
});
