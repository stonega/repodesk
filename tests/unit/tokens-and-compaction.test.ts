import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  compactionPlan,
  compactTopic,
  sanitizeCompactionSummary,
} from "../../src/agent/compaction.ts";
import { buildContext } from "../../src/agent/context.ts";
import {
  type AgentInput,
  type AgentRunner,
  PiRunner,
  selectedModel,
} from "../../src/agent/runtime.ts";
import {
  DEFAULT_COMPACTION_CONTEXT_WINDOW,
  effectiveCompactionWindow,
  estimateContextTokens,
  estimateTextTokens,
  truncateUtf8Safe,
} from "../../src/agent/tokens.ts";
import type { Store } from "../../src/db/repositories.ts";
import type { Run, Workspace } from "../../src/domain.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { recordThreadAnswer } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

function fakeStream(text: string) {
  const msg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4.1-mini",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: {
        input: 0.00004,
        output: 0.000032,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.000072,
      },
    },
  };
  const s = new AssistantMessageEventStream();
  s.push({ type: "done", reason: "stop", message: msg });
  s.end(msg);
  return s;
}

test("token estimator avoids 2-4x UTF-8 byte overestimation for English and CJK text", () => {
  const english = "The quick brown fox jumps over the lazy dog. ".repeat(100);
  const englishBytes = Buffer.byteLength(english, "utf8");
  const englishTokens = estimateTextTokens(english);
  // 4500 bytes of English prose is ~900-1100 real tokens (our estimate ~1300, far below 4500 bytes).
  expect(englishTokens).toBeLessThan(englishBytes * 0.45);
  expect(englishTokens).toBeGreaterThan(englishBytes * 0.2);

  const chinese = "今天我们来讨论一下系统架构升级与性能优化方案。".repeat(100);
  const chineseBytes = Buffer.byteLength(chinese, "utf8");
  const chineseTokens = estimateTextTokens(chinese);
  // 2300 Chinese chars = 6900 UTF-8 bytes; real tokens ~2300-2600 (our estimate ~2530, well below 6900 bytes).
  expect(chineseTokens).toBeLessThan(chineseBytes * 0.5);
  expect(chineseTokens).toBeGreaterThan(chinese.length * 0.8);
});

test("PiRunner reserves based on estimated tokens rather than raw UTF-8 bytes and reports telemetry", async () => {
  const longEnglish = "configuration documentation ".repeat(400); // ~11,200 bytes, ~3,200 tokens
  const rawBytes = Buffer.byteLength(longEnglish, "utf8");
  let reservedUsd = 0;
  let estimatedInput: number | undefined;
  let latencyMs: number | undefined;
  let stopReason: string | undefined;

  const model = selectedModel("gpt-4.1-mini", {
    modelPricing: { input: 10, output: 10 },
    modelLimits: { contextWindow: 128000, maxOutputTokens: 1000 },
  });
  const runner = new PiRunner(() => fakeStream("OK"));
  await runner.run({
    actor: "101",
    runId: "r-est",
    model,
    apiKey: "fake",
    system: "Be concise.",
    prompt: longEnglish,
    transcript: [],
    tools: [],
    maxTurns: 1,
    maxOutputTokens: 200,
    signal: new AbortController().signal,
    guard: async () => {},
    reserve: async (amount, _purpose, meta) => {
      reservedUsd = amount;
      estimatedInput = meta?.estimatedInputTokens;
      return "attempt-1";
    },
    checkpoint: async (msg, _id, _purpose, meta) => {
      if (msg.role === "assistant") {
        latencyMs = meta?.latencyMs;
        stopReason = meta?.stopReason;
      }
    },
  });

  expect(estimatedInput).toBeDefined();
  expect(estimatedInput as number).toBeLessThan(rawBytes * 0.5);
  const byteBasedCost = ((rawBytes + 200) * 10) / 1_000_000;
  expect(reservedUsd).toBeLessThan(byteBasedCost * 0.6);
  expect(latencyMs).toBeGreaterThanOrEqual(0);
  expect(stopReason).toBe("stop");
});

test("unknown contextWindow falls back to DEFAULT_COMPACTION_CONTEXT_WINDOW so compaction still triggers", () => {
  const custom = selectedModel("custom/private-model");
  expect(custom.contextWindowKnown).toBe(false);
  expect(
    effectiveCompactionWindow(custom.contextWindow, custom.contextWindowKnown),
  ).toBe(DEFAULT_COMPACTION_CONTEXT_WINDOW);
  expect(effectiveCompactionWindow(Number.MAX_SAFE_INTEGER)).toBe(
    DEFAULT_COMPACTION_CONTEXT_WINDOW,
  );
  expect(effectiveCompactionWindow(64000, true)).toBe(64000);

  // Build a conversation exceeding 80% of 128k tokens on a custom model with unknown window.
  const w = workspace();
  for (let i = 0; i < 120; i++) {
    const r = createRun(
      w,
      "101",
      `turn ${i}: ${"architecture decision detail ".repeat(110)}`,
      "101",
      10,
      "custom/private-model",
      { botId: "999" },
    );
    r.status = "succeeded";
    r.result = "Recorded decision.";
    recordThreadAnswer(w, r);
  }
  const current = createRun(
    w,
    "101",
    "What did we decide?",
    "101",
    10,
    "custom/private-model",
    { botId: "999" },
  );
  const plan = compactionPlan(w, current, {
    model: custom,
    tools: [],
  } as unknown as AgentInput);
  expect(plan).toBeDefined();
  expect(plan?.summary.sourceIds.length).toBeGreaterThan(0);
});

test("sanitizeCompactionSummary strips invalid citations and truncates UTF-8 safely without throwing", () => {
  const raw = `Confirmed decision [source:valid-1] and bogus [source:hallucinated-99] ( [source:bad-2] ). ${"中文摘要内容".repeat(40)}`;
  const res = sanitizeCompactionSummary(raw, ["valid-1"], 120);
  expect(res.strippedCitations).toBe(2);
  expect(res.truncated).toBe(true);
  expect(res.text).toContain("[source:valid-1]");
  expect(res.text).not.toContain("hallucinated-99");
  expect(res.text).not.toContain("bad-2");
  expect(Buffer.byteLength(res.text, "utf8")).toBeLessThanOrEqual(120);
  // Ensure no broken surrogate/UTF-8 replacement character exists.
  expect(res.text).not.toContain("\uFFFD");

  // Truncating inside a [source:...] tag never leaves an unclosed citation fragment.
  const citationEdge = `${"a".repeat(30)} [source:valid-1234567890] trailing`;
  const clipped = truncateUtf8Safe(citationEdge, 42);
  expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(42);
  expect(clipped).not.toContain("[source:");
});

test("compactTopic tolerates oversized summary and invalid citations and retries once on empty summary", async () => {
  const w = workspace();
  for (let i = 0; i < 18; i++) {
    const r = createRun(
      w,
      "101",
      `turn ${i}: ${"detail ".repeat(450)}`,
      "101",
      10,
      "gpt-4.1-mini",
      { botId: "999" },
    );
    r.status = "succeeded";
    r.result = "Recorded decision.";
    recordThreadAnswer(w, r);
  }
  const run = createRun(w, "101", "Continue", "101", 10, "gpt-4.1-mini", {
    botId: "999",
  });
  run.status = "running";
  run.fence = 1;

  const store = {
    change: async <T>(_id: string, fn: (ws: Workspace) => T) => fn(w),
  } as unknown as Store;

  let calls = 0;
  const runner: AgentRunner = {
    async run(_input) {
      calls++;
      if (calls === 1) {
        // First pass returns empty -> should trigger 1 automatic retry.
        return {
          text: "   ",
          status: "succeeded",
          turns: 1,
          tools: 0,
          transcript: [],
        };
      }
      // Retry returns oversized text + invalid citation -> should sanitize & truncate instead of failing!
      const validId = run.sources[0]?.id ?? "missing";
      const oversized = `Summary keeps [source:${validId}] and drops [source:invented-id]. ${"重要上下文摘要。".repeat(800)}`;
      return {
        text: oversized,
        status: "succeeded",
        turns: 1,
        tools: 0,
        transcript: [],
      };
    },
  };

  const agentInput: AgentInput = {
    actor: run.actor,
    workspaceId: w.id,
    runId: run.id,
    model: {
      ...selectedModel("gpt-4.1-mini"),
      contextWindow: 24000,
      maxTokens: 4000,
    },
    apiKey: "fake",
    system: "",
    prompt: "",
    transcript: [],
    tools: [],
    signal: new AbortController().signal,
    guard: async () => {},
    reserve: async () => "attempt",
    checkpoint: async () => {},
  };

  const compacted = await compactTopic(
    store,
    w.id,
    run.id,
    run.fence,
    runner,
    agentInput,
  );
  expect(calls).toBe(2);
  expect(compacted.contextSummary?.text).toBeTruthy();
  expect(compacted.contextSummary?.text).not.toContain("invented-id");
  expect(
    Buffer.byteLength(compacted.contextSummary?.text ?? "", "utf8"),
  ).toBeLessThanOrEqual(compacted.compaction?.maxBytes ?? 12000);
});

test("buildContext produces native multi-turn user/assistant history with byte-identical cache prefix", () => {
  const w = workspace();
  const ask = (text: string) =>
    createRun(w, "101", text, "101", 10, "gpt-4.1-mini", { botId: "999" });
  const answer = (r: Run, text: string) => {
    r.status = "succeeded";
    r.result = text;
    recordThreadAnswer(w, r);
  };

  const r1 = ask("Write a `sum(a, b)` function in TypeScript.");
  answer(r1, "```ts\nexport const sum = (a: number, b: number) => a + b;\n```");

  const r2 = ask("Add a check for finite numbers.");
  const ctx2 = buildContext(w, r2);
  expect(ctx2.historyMessages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
  ]);
  // Native unescaped code block in assistant history message (no JSON-escaped \n or \").
  const histAssistant = ctx2.historyMessages[1];
  expect(histAssistant?.role).toBe("assistant");
  if (histAssistant?.role === "assistant") {
    const text = histAssistant.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("```ts\nexport const sum");
  }
  answer(r2, "Updated with Number.isFinite checks.");

  const r3 = ask("Now write unit tests for it.");
  const ctx3 = buildContext(w, r3);
  expect(ctx3.historyMessages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  // Strict append-only prefix preservation for prompt caching!
  expect(ctx3.historyMessages.slice(0, 2)).toEqual(ctx2.historyMessages);
  expect(ctx3.system).toBe(ctx2.system);
  expect(ctx3.prompt).toContain("Now write unit tests for it.");
  expect(ctx3.prompt).toContain("<runtime_context>");

  // Token estimator handles native multi-turn context cleanly.
  const est = estimateContextTokens({
    systemPrompt: ctx3.system,
    messages: [
      ...ctx3.historyMessages,
      { role: "user", content: ctx3.prompt, timestamp: 0 },
    ],
  });
  expect(est.totalTokens).toBeGreaterThan(0);
  expect(est.imageTokens).toBe(0);
});
