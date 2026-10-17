import { expect, test } from "bun:test";
import {
  runMessageEntries,
  summarizeRun,
} from "../../src/admin/run-statistics.ts";
import type { Run } from "../../src/domain.ts";

type SummaryRun = Parameters<typeof summarizeRun>[0];
const run = (patch: Partial<SummaryRun> = {}): SummaryRun => ({
  task: "Inspect the repository",
  transcript: [],
  tools: {},
  attempts: [],
  ...patch,
});
const attempt = (
  patch: Partial<Run["attempts"][number]> = {},
): Run["attempts"][number] => ({
  id: crypto.randomUUID(),
  at: "2026-10-17T00:00:00Z",
  status: "settled",
  reserved: 1,
  ...patch,
});

test("message counts match the displayed request and retained entries without duplicating the final answer", () => {
  const value = run({
    transcript: [
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "toolResult", toolName: "search", content: [] },
    ],
    result: " Done. ",
  });
  expect(runMessageEntries(value).map((entry) => entry.label)).toEqual([
    "Request",
    "Assistant",
    "Tool · search",
  ]);
  expect(summarizeRun(value).messages).toBe(3);
  expect(summarizeRun({ ...value, result: "Another answer" }).messages).toBe(4);
  expect(
    summarizeRun(run({ transcript: [null, "legacy checkpoint"] })).messages,
  ).toBe(3);
});

test("tool calls merge checkpoints and durable IDs, including blocked, extension and started calls", () => {
  const value = run({
    transcript: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "saved", name: "search" },
          { type: "toolCall", id: "blocked", name: "write" },
          { type: "toolCall", id: "extension", name: "lookup" },
          { type: "toolCall", name: "legacy" },
          null,
        ],
      },
      { role: "toolResult", toolCallId: "saved", content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "saved" }] },
    ],
    tools: {
      saved: { name: "search", state: "done" },
      resumed: { name: "lookup", state: "started" },
    },
  });
  expect(summarizeRun(value).toolCalls).toBe(5);
});

test("all attempt purposes contribute usage and cache writes count as input but not hits", () => {
  const value = run({
    attempts: [
      attempt({
        actual: 0.1,
        tokens: { input: 100, output: 40, cacheRead: 600, cacheWrite: 100 },
      }),
      attempt({
        purpose: "followup",
        actual: 0,
        tokens: { input: 50, output: 10, cacheRead: 0, cacheWrite: 50 },
      }),
      attempt({
        purpose: "compaction",
        actual: 0.2,
        tokens: { input: 50, output: 50, cacheRead: 0, cacheWrite: 50 },
      }),
    ],
  });
  const result = summarizeRun(value);
  expect(result.input).toBe(1000);
  expect(result.totalTokens).toBe(1100);
  expect(result.cacheHitRate).toBe(0.6);
  expect(result.cost).toBeCloseTo(0.3);
  expect(result.tokenAttempts).toBe(3);
  expect(result.costAttempts).toBe(3);
});

test("unreported and partial usage and charges remain distinct from known zero", () => {
  const missing = attempt({ status: "unknown", pricingUnknown: true });
  const known = attempt({
    actual: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const unknown = summarizeRun(run({ attempts: [missing] }));
  expect(unknown.tokens).toBeUndefined();
  expect(unknown.cost).toBeUndefined();
  expect(unknown.cacheHitRate).toBeUndefined();
  const partial = summarizeRun(run({ attempts: [known, missing] }));
  expect(partial.tokens).toEqual(known.tokens);
  expect(partial.totalTokens).toBe(0);
  expect(partial.cost).toBe(0);
  expect(partial.tokenAttempts).toBe(1);
  expect(partial.costAttempts).toBe(1);
  expect(partial.attempts).toBe(2);
});

test("a queued run has a request, no usage and no cache denominator", () => {
  const summary = summarizeRun(run());
  expect(summary.messages).toBe(1);
  expect(summary.toolCalls).toBe(0);
  expect(summary.attempts).toBe(0);
  expect(summary.totalTokens).toBe(0);
  expect(summary.cost).toBe(0);
  expect(summary.cacheHitRate).toBeUndefined();
});
