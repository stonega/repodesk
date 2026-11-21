import { expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { PiRunner, selectedModel } from "../../src/agent/runtime.ts";
import {
  createConcurrencyLimiter,
  isParallelReadOnlyTool,
  isSubagentSafeTool,
  toolExecutionMode,
} from "../../src/agent/tool-metadata.ts";

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

const emptyUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("tool metadata classifies read-only vs mutating tools conservatively", () => {
  expect(isParallelReadOnlyTool("query_github_metadata")).toBe(true);
  expect(isParallelReadOnlyTool("read_web")).toBe(true);
  expect(isParallelReadOnlyTool("search_tool")).toBe(true);
  expect(isParallelReadOnlyTool("obsidian_read")).toBe(true);
  expect(isParallelReadOnlyTool("obsidian_write")).toBe(false);
  expect(isParallelReadOnlyTool("start_development_task")).toBe(false);
  expect(isParallelReadOnlyTool("propose_github_issue")).toBe(false);
  expect(isParallelReadOnlyTool("delegate_research")).toBe(false);
  expect(isSubagentSafeTool("delegate_research")).toBe(false);
  expect(toolExecutionMode("query_github_metadata", true)).toBe("parallel");
  // External non-builtin plugins always execute sequentially even if names collide.
  expect(toolExecutionMode("query_github_metadata", false)).toBe("sequential");
});

test("concurrency limiter caps concurrent executions and honors AbortSignal", async () => {
  const limit = createConcurrencyLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return n;
      }),
    ),
  );
  expect(peak).toBe(2);

  const controller = new AbortController();
  let releaseFirst!: () => void;
  const first = limit(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  const second = limit(() => new Promise<void>(() => {}), controller.signal);
  const third = limit(async () => "never", controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(third).rejects.toThrow("cancelled");
  releaseFirst();
  await first;
  void second.catch(() => {});
});

test("PiRunner executes parallel read-only tools concurrently up to cap and returns results in original order", async () => {
  const model = selectedModel("gpt-4.1-mini");
  let active = 0;
  let peak = 0;
  const finishedOrder: string[] = [];

  const readTool: AgentTool = {
    name: "read_web",
    label: "Read web",
    description: "Read",
    executionMode: "parallel",
    parameters: Type.Object({ id: Type.String(), delay: Type.Integer() }),
    execute: async (_callId, raw) => {
      const { id, delay } = raw as { id: string; delay: number };
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, delay));
      active--;
      finishedOrder.push(id);
      return {
        content: [{ type: "text", text: JSON.stringify({ id }) }],
        details: {},
      };
    },
  };

  let turn = 0;
  const runner = new PiRunner((m) => {
    turn++;
    if (turn === 1) {
      return streamMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "read_web",
            arguments: { id: "slow", delay: 45 },
          },
          {
            type: "toolCall",
            id: "c2",
            name: "read_web",
            arguments: { id: "fast", delay: 10 },
          },
          {
            type: "toolCall",
            id: "c3",
            name: "read_web",
            arguments: { id: "mid", delay: 25 },
          },
        ],
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      });
    }
    return streamMessage({
      role: "assistant",
      content: [{ type: "text", text: "Combined result" }],
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  });

  const result = await runner.run({
    actor: "101",
    runId: "r1",
    model,
    apiKey: "test",
    system: "test",
    prompt: "read all three",
    transcript: [],
    tools: [readTool],
    parallelToolConcurrency: 2,
    signal: AbortSignal.timeout(5000),
    guard: async () => {},
    reserve: async () => "a1",
    checkpoint: async () => {},
  });

  expect(result.text).toBe("Combined result");
  expect(peak).toBe(2);
  // Fast finished before slow, proving concurrency, yet transcript toolResults preserve call order c1, c2, c3.
  expect(finishedOrder[0]).toBe("fast");
  const toolResultIds = result.transcript
    .filter((m) => m.role === "toolResult")
    .map((m) => m.toolCallId);
  expect(toolResultIds).toEqual(["c1", "c2", "c3"]);
});

test("PiRunner serializes batch when any sequential mutating tool is present", async () => {
  const model = selectedModel("gpt-4.1-mini");
  let active = 0;
  let peak = 0;

  const readTool: AgentTool = {
    name: "read_web",
    label: "Read",
    description: "Read",
    executionMode: "parallel",
    parameters: Type.Object({}),
    execute: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
  const writeTool: AgentTool = {
    name: "propose_instruction",
    label: "Write",
    description: "Write",
    executionMode: "sequential",
    parameters: Type.Object({}),
    execute: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };

  let turn = 0;
  const runner = new PiRunner((m) => {
    turn++;
    if (turn === 1) {
      return streamMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "read_web", arguments: {} },
          {
            type: "toolCall",
            id: "c2",
            name: "propose_instruction",
            arguments: {},
          },
        ],
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      });
    }
    return streamMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  });

  const result = await runner.run({
    actor: "101",
    runId: "r2",
    model,
    apiKey: "test",
    system: "test",
    prompt: "read then write",
    transcript: [],
    tools: [readTool, writeTool],
    signal: AbortSignal.timeout(5000),
    guard: async () => {},
    reserve: async () => "a1",
    checkpoint: async () => {},
  });

  expect(result.text).toBe("Done");
  expect(peak).toBe(1);
});
