import { expect, test } from "bun:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import {
  type AgentInput,
  failedStream,
  PiRunner,
  selectedModel,
} from "../../src/agent/runtime.ts";

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1-mini",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: {
        input: 0.000004,
        output: 0.000016,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.00002,
      },
    },
  };
}
function stream(m: AssistantMessage) {
  const s = new AssistantMessageEventStream();
  s.push({ type: "start", partial: m });
  s.push({ type: "done", reason: m.stopReason as "stop", message: m });
  s.end(m);
  return s;
}
function input(patch: Partial<AgentInput> = {}): AgentInput {
  return {
    actor: "101",
    runId: "test",
    model: selectedModel("gpt-4.1-mini"),
    apiKey: "fake",
    system: "test",
    prompt: "do test",
    transcript: [],
    tools: [],
    maxTurns: 3,
    maxTools: 4,
    maxInputChars: 16000,
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    guard: async () => {},
    reserve: async () => "attempt",
    checkpoint: async () => {},
    ...patch,
  };
}
test("Pi fake stream validates and executes tools sequentially, checkpoints ordered events", async () => {
  const events: string[] = [];
  const transcript: AgentMessage[] = [];
  let calls = 0;
  let executed = 0;
  const runner = new PiRunner(() =>
    stream(
      ++calls === 1
        ? message(
            [
              {
                type: "toolCall",
                id: "tool-1",
                name: "read",
                arguments: { count: 2 },
              },
            ],
            "toolUse",
          )
        : message([{ type: "text", text: "Done" }]),
    ),
  );
  const result = await runner.run(
    input({
      events: (type) => events.push(type),
      checkpoint: async (m) => {
        transcript.push(m);
      },
      tools: [
        {
          name: "read",
          label: "Read",
          description: "Read",
          parameters: Type.Object({ count: Type.Integer() }),
          execute: async (_id, args) => {
            executed += (args as { count: number }).count;
            return { content: [{ type: "text", text: "read" }], details: {} };
          },
        },
      ],
    }),
  );
  expect(result.text).toBe("Done");
  expect(executed).toBe(2);
  expect(transcript.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  expect(events.indexOf("tool_execution_start")).toBeLessThan(
    events.indexOf("tool_execution_end"),
  );
  expect(events.at(-1)).toBe("agent_end");
});
test("invalid tool arguments never reach executor and bounded loop stops", async () => {
  let executed = 0;
  let calls = 0;
  const runner = new PiRunner(() =>
    stream(
      message(
        [
          {
            type: "toolCall",
            id: `t${++calls}`,
            name: "read",
            arguments: { count: "oops" },
          },
        ],
        "toolUse",
      ),
    ),
  );
  const result = await runner.run(
    input({
      maxTurns: 2,
      tools: [
        {
          name: "read",
          label: "Read",
          description: "Read",
          parameters: Type.Object({ count: Type.Integer() }),
          execute: async () => {
            executed++;
            return { content: [], details: {} };
          },
        },
      ],
    }),
  );
  expect(executed).toBe(0);
  expect(calls).toBe(2);
  expect(result.status).toBe("partial");
});
test("restored tool-result boundary continues without re-executing a completed tool", async () => {
  let calls = 0;
  const runner = new PiRunner((_model, context) => {
    calls++;
    expect(context.messages.at(-1)?.role).toBe("toolResult");
    return stream(message([{ type: "text", text: "Restored" }]));
  });
  const transcript: AgentMessage[] = [
    { role: "user", content: "hi", timestamp: 1 },
    message(
      [{ type: "toolCall", id: "one", name: "read", arguments: {} }],
      "toolUse",
    ),
    {
      role: "toolResult",
      toolCallId: "one",
      toolName: "read",
      content: [{ type: "text", text: "saved" }],
      isError: false,
      timestamp: 2,
    },
  ];
  expect((await runner.run(input({ transcript }))).text).toBe("Restored");
  expect(calls).toBe(1);
});
test("abort propagates to the provider and never reports success", async () => {
  const controller = new AbortController();
  const fake: StreamFn = (_model, _context, options) => {
    const s = new AssistantMessageEventStream();
    options?.signal?.addEventListener(
      "abort",
      () => {
        const m = message([], "aborted");
        s.push({ type: "error", reason: "aborted", error: m });
        s.end(m);
      },
      { once: true },
    );
    setTimeout(() => controller.abort(), 10);
    return s;
  };
  expect(
    new PiRunner(fake).run(input({ signal: controller.signal })),
  ).rejects.toThrow("cancelled");
});
test("budget denial makes zero provider calls and hides reasoning checkpoints", async () => {
  let calls = 0;
  const runner = new PiRunner(() => {
    calls++;
    return stream(
      message([
        { type: "thinking", thinking: "private chain" },
        { type: "text", text: "Answer" },
      ]),
    );
  });
  await expect(
    runner.run(
      input({
        reserve: async () => {
          throw Error("no budget");
        },
      }),
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  const saved: AgentMessage[] = [];
  await runner.run(
    input({
      checkpoint: async (m) => {
        saved.push(m);
      },
    }),
  );
  expect(JSON.stringify(saved)).not.toContain("private chain");
});
test("provider errors are not interpreted as success", async () => {
  const runner = new PiRunner((model) =>
    failedStream(model, "secret-provider-error"),
  );
  await expect(runner.run(input())).rejects.toThrow("provider_failed");
});

// Exercise Pi's actual HTTP adapter against a local deterministic SSE server.
test("compatible endpoint receives the custom model, key and exact thinking level", async () => {
  const requests: {
    path: string;
    auth: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      const chunk = {
        id: "test",
        object: "chat.completion.chunk",
        created: 1,
        model: "team/reasoner",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Done" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  try {
    for (const thinkingLevel of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as const) {
      const model = selectedModel("team/reasoner", {
        modelBaseUrl: `http://127.0.0.1:${server.port}/custom/v1`,
        thinkingLevel,
        modelPricing: { input: 1, output: 3 },
      });
      const result = await new PiRunner().run(
        input({ model, thinkingLevel, apiKey: "local-test-key" }),
      );
      expect(result.text).toBe("Done");
      const request = requests.at(-1);
      expect(request?.path).toBe("/custom/v1/chat/completions");
      expect(request?.auth).toBe("Bearer local-test-key");
      expect(request?.body.model).toBe("team/reasoner");
      expect(request?.body.reasoning_effort).toBe(
        thinkingLevel === "off" ? undefined : thinkingLevel,
      );
      expect(request?.body.store).toBe(false);
      expect(request?.body.max_completion_tokens).toBe(256);
    }
    expect(requests).toHaveLength(7);
  } finally {
    await server.stop(true);
  }
});

test("unknown model pricing must be explicit and known model metadata stays isolated", () => {
  expect(() => selectedModel("team/custom")).toThrow(
    "custom_model_pricing_required",
  );
  const custom = selectedModel("team/custom", {
    modelPricing: { input: 0, output: 0 },
  });
  expect(custom.cost.input).toBe(0);
  const first = selectedModel("gpt-4.1-mini", {
    modelBaseUrl: "http://localhost:1234/v1",
    thinkingLevel: "high",
  });
  const second = selectedModel("gpt-4.1-mini");
  expect(first.baseUrl).not.toBe(second.baseUrl);
  expect(second.reasoning).toBe(false);
  expect(second.cost.input).toBeGreaterThan(0);
});
