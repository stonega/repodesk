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
test("Pi sends image blocks, reserves vision input and restores images from checkpoints", async () => {
  const images = [
    {
      type: "image" as const,
      mimeType: "image/png",
      data: "a".repeat(2000000),
    },
  ];
  const checkpoint: AgentMessage[] = [];
  let reserved = 0;
  const runner = new PiRunner((_model, context) => {
    const user = context.messages.find((m) => m.role === "user");
    expect(user?.content).toEqual([
      { type: "text", text: "do test" },
      ...images,
    ]);
    return stream(message([{ type: "text", text: "Image received" }]));
  });
  await runner.run(
    input({
      images,
      maxInputChars: undefined,
      reserve: async (amount) => {
        reserved = amount;
        return "image-attempt";
      },
      checkpoint: async (m) => {
        checkpoint.push(m);
      },
    }),
  );
  expect(reserved).toBeGreaterThan(
    (32768 * selectedModel("gpt-4.1-mini").cost.input) / 1000000,
  );
  const user = checkpoint.find((m) => m.role === "user");
  if (!user) throw Error("missing image checkpoint");
  await runner.run(input({ transcript: [user], maxInputChars: undefined }));
});

test("Pi blocks images on text-only models before provider dispatch or reservation", async () => {
  let called = false;
  const runner = new PiRunner(() => {
    called = true;
    return stream(message([{ type: "text", text: "wrong" }]));
  });
  await expect(
    runner.run(
      input({
        model: { ...selectedModel("gpt-4.1-mini"), input: ["text"] },
        images: [{ type: "image", mimeType: "image/png", data: "a" }],
        reserve: async () => {
          called = true;
          return "wrong";
        },
      }),
    ),
  ).rejects.toThrow("model_images_unsupported");
  expect(called).toBe(false);
});
test("Pi previews cumulative text before completion, never thinking or tool arguments", async () => {
  const previews: string[] = [];
  const order: string[] = [];
  const partial = message([
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "Hello" },
  ]);
  const runner = new PiRunner(() => {
    const s = new AssistantMessageEventStream();
    s.push({ type: "start", partial });
    s.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "private reasoning",
      partial,
    });
    s.push({ type: "text_delta", contentIndex: 1, delta: "Hello", partial });
    const next = message([
      ...partial.content.slice(0, 1),
      { type: "text", text: "Hello world" },
    ]);
    s.push({
      type: "text_delta",
      contentIndex: 1,
      delta: " world",
      partial: next,
    });
    const final = message([{ type: "text", text: "Hello world" }]);
    s.push({ type: "done", reason: "stop", message: final });
    s.end(final);
    return s;
  });
  const result = await runner.run(
    input({
      preview: async (text) => {
        previews.push(text);
        order.push("preview");
      },
      checkpoint: async (m) => {
        if (m.role === "assistant") order.push("checkpoint");
      },
    }),
  );
  expect(previews).toEqual(["Hello", "Hello world"]);
  expect(order).toEqual(["preview", "preview", "checkpoint"]);
  expect(result.text).toBe("Hello world");
});
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
  expect(result.reason).toBe("turn_limit");
});
test("empty final answers and output truncation retain distinct partial reasons", async () => {
  for (const [text, stop, reason] of [
    [" \n", "stop", "empty_response"],
    ["", "length", "output_limit"],
    ["Some answer", "length", "output_limit"],
  ] as const) {
    const runner = new PiRunner(() =>
      stream(message([{ type: "text", text }], stop)),
    );
    expect(await runner.run(input())).toMatchObject({
      text,
      status: "partial",
      reason,
      turns: 1,
    });
  }
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
        modelLimits: { contextWindow: 128000, maxOutputTokens: 16000 },
      });
      const result = await new PiRunner().run(
        input({
          model,
          thinkingLevel,
          apiKey: "local-test-key",
          images:
            thinkingLevel === "high"
              ? [{ type: "image", mimeType: "image/png", data: "test-image" }]
              : undefined,
        }),
      );
      expect(result.text).toBe("Done");
      const request = requests.at(-1);
      expect(request?.path).toBe("/custom/v1/chat/completions");
      expect(request?.auth).toBe("Bearer local-test-key");
      expect(request?.body.model).toBe("team/reasoner");
      if (thinkingLevel === "high")
        expect(JSON.stringify(request?.body.messages)).toContain(
          "data:image/png;base64,test-image",
        );
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
    modelLimits: { contextWindow: 128000, maxOutputTokens: 16000 },
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

test("model capacity and explicit input limits reject before reservation or dispatch", async () => {
  let reservations = 0;
  let calls = 0;
  const runner = new PiRunner(() => {
    calls++;
    return stream(message([{ type: "text", text: "Done" }]));
  });
  const model = {
    ...selectedModel("gpt-4.1-mini"),
    contextWindow: 5000,
    maxTokens: 3000,
  };
  const base = input({
    model,
    maxInputChars: 0,
    maxOutputTokens: 1000,
    reserve: async () => {
      reservations++;
      return "id";
    },
  });
  await expect(runner.run({ ...base, maxOutputTokens: 3001 })).rejects.toThrow(
    "model_output_limit_exceeded",
  );
  await expect(
    runner.run({ ...base, prompt: "字".repeat(1500) }),
  ).rejects.toThrow("model_context_limit_exceeded");
  await expect(runner.run({ ...base, maxInputChars: 10 })).rejects.toThrow(
    "input_budget_exceeded",
  );
  expect(reservations).toBe(0);
  expect(calls).toBe(0);
  expect((await runner.run({ ...base, maxOutputTokens: 2500 })).status).toBe(
    "succeeded",
  );
  expect(calls).toBe(1);
});

test("automatic input capacity permits a tool result that exceeded the old 16K cap", async () => {
  let calls = 0;
  const runner = new PiRunner(() =>
    stream(
      ++calls === 1
        ? message(
            [{ type: "toolCall", id: "large", name: "read", arguments: {} }],
            "toolUse",
          )
        : message([{ type: "text", text: "Done" }]),
    ),
  );
  const result = await runner.run(
    input({
      maxInputChars: 0,
      tools: [
        {
          name: "read",
          label: "Read",
          description: "Read",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "source".repeat(4000) }],
            details: {},
          }),
        },
      ],
    }),
  );
  expect(result.status).toBe("succeeded");
  expect(calls).toBe(2);
});

test("automatic output fits remaining dollars and preserves the model response", async () => {
  let outputLimit = 0;
  let reserved = 0;
  const runner = new PiRunner((_model, _context, options) => {
    outputLimit = options?.maxTokens ?? 0;
    return stream(message([{ type: "text", text: "这是模型原样回复。" }]));
  });
  const model = {
    ...selectedModel("gpt-4.1-mini"),
    cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
  const result = await runner.run(
    input({
      model,
      maxInputChars: undefined,
      maxOutputTokens: undefined,
      remainingBudget: async () => ({ run: 0.0003, workspace: 10 }),
      reserve: async (amount) => {
        reserved = amount;
        return "id";
      },
    }),
  );
  expect(result.text).toBe("这是模型原样回复。");
  expect(outputLimit).toBeGreaterThan(250);
  expect(outputLimit).toBeLessThanOrEqual(300);
  expect(reserved).toBeLessThanOrEqual(0.0003);
});

test("automatic output shrinks to remaining context and supports zero-cost models", async () => {
  let sent = 0;
  const model = {
    ...selectedModel("gpt-4.1-mini"),
    contextWindow: 5000,
    maxTokens: 3000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runner = new PiRunner((_model, context, options) => {
    sent++;
    const output = options?.maxTokens ?? 0;
    expect(output).toBeGreaterThan(0);
    expect(output).toBeLessThan(3000);
    expect(Buffer.byteLength(JSON.stringify(context)) + output).toBe(5000);
    return stream(message([{ type: "text", text: "Done" }]));
  });
  await runner.run(
    input({
      model,
      prompt: "a".repeat(3500),
      maxInputChars: undefined,
      maxOutputTokens: undefined,
      remainingBudget: async () => ({ run: 0, workspace: 0 }),
      reserve: async (amount) => {
        expect(amount).toBe(0);
        return "id";
      },
    }),
  );
  expect(sent).toBe(1);
});

test("automatic output rejects an unaffordable input before reserving or dispatching", async () => {
  let sent = 0;
  let reserved = 0;
  const runner = new PiRunner(() => {
    sent++;
    return stream(message([]));
  });
  await expect(
    runner.run(
      input({
        maxOutputTokens: undefined,
        remainingBudget: async () => ({ run: 1, workspace: 0 }),
        reserve: async () => {
          reserved++;
          return "id";
        },
      }),
    ),
  ).rejects.toThrow("workspace_budget_exhausted");
  expect(sent).toBe(0);
  expect(reserved).toBe(0);
});
