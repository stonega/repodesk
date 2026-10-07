import { expect, test } from "bun:test";
import { compactionPlan } from "../../src/agent/compaction.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import type { Store } from "../../src/db/repositories.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { recordThreadAnswer } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";
import { fixtureValue } from "../team-workflows-fixture.ts";

test("post-summary hysteresis still requires another bounded batch for oversized history", () => {
  const w = workspace();
  for (let i = 0; i < 50; i++) {
    const r = createRun(
      w,
      "101",
      `Decision ${i}: ${"detail ".repeat(440)}`,
      "-100100",
      0,
      "gpt-4.1-mini",
      { botId: "999" },
    );
    r.status = "succeeded";
    r.result = "A recorded decision";
    recordThreadAnswer(w, r);
  }
  const r = createRun(
    w,
    "101",
    "Explain the recent decision",
    "-100100",
    0,
    "gpt-4.1-mini",
    { botId: "999" },
  );
  const input: AgentInput = {
    model: {
      ...selectedModel("gpt-4.1-mini"),
      contextWindow: 50000,
      maxTokens: 4000,
    },
    tools: applicationTools({} as Store, w.id, r.id, 1),
    actor: r.actor,
    workspaceId: w.id,
    runId: r.id,
    apiKey: "fake",
    system: "",
    prompt: "",
    transcript: [],
    maxTurns: 20,
    maxTools: 8,
    signal: new AbortController().signal,
    guard: async () => {},
    reserve: async () => "attempt",
    checkpoint: async () => {},
  };
  const first = fixtureValue(compactionPlan(w, r, input));
  r.contextSummary = {
    ...first.summary,
    text: "Earlier decisions remain reference data.",
  };
  r.compaction = { ...first, state: "done", summary: r.contextSummary };
  const second = fixtureValue(compactionPlan(w, r, input));
  expect(second.summary.sourceIds.length).toBeGreaterThan(
    first.summary.sourceIds.length,
  );
  expect(second.summary.sourceIds.length).toBeLessThan(r.sources.length);
  expect(second.maxBytes).toBeLessThanOrEqual(12000);
});
