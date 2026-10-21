import { expect, test } from "bun:test";
import { inputByteLimit, remainingBudgets } from "../../src/agent/limits.ts";
import { modelLimitsSchema } from "../../src/agent/model-settings.ts";
import { modelCapabilities, selectedModel } from "../../src/agent/runtime.ts";
import { Fault, settingsSchema, workflowSchema } from "../../src/domain.ts";
import { safeLogCode } from "../../src/observability/logs.ts";
import {
  decide,
  proposeWorkflow,
  tick,
  workflowAction,
} from "../../src/workflows/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { spec, workspace } from "../fixtures.ts";

test("workflow proposals discard legacy budgets and keep other validation strict", () => {
  const w = workspace();
  const input = spec(w);
  expect(input).not.toHaveProperty("budgetUsd");
  for (const budgetUsd of [0, 0.1, 25, null]) {
    const legacy = { ...input, budgetUsd };
    expect(workflowSchema.parse(legacy)).toEqual(input);
    expect(proposeWorkflow(w, "101", legacy).workflow.spec).not.toHaveProperty(
      "budgetUsd",
    );
  }
  expect(workflowSchema.safeParse({ ...input, unexpected: true }).success).toBe(
    false,
  );
});

test.each([null, 0, 0.01, 25])(
  "manual workflow runs inherit team budget %s and ignore saved overrides",
  (runBudgetUsd) => {
    const w = workspace();
    w.settings.runBudgetUsd = runBudgetUsd;
    w.settings.monthlyBudgetUsd = 100;
    const p = proposeWorkflow(w, "101", spec(w));
    decide(w, "101", p.approval.id, true);
    // Represent an existing workflow saved before its own budget was retired.
    Object.assign(p.workflow.spec, { budgetUsd: 0.1 });
    const run = workflowAction(
      w,
      "101",
      p.workflow.id,
      "run",
      p.workflow.version,
      "gpt-4.1-mini",
    );
    if (!("attempts" in run)) throw Error("Expected a workflow run");
    expect(run.settings.runBudgetUsd).toBe(runBudgetUsd);
    expect(run.settings.monthlyBudgetUsd).toBe(100);
    run.attempts.push({
      id: "reserved",
      reserved: 0.02,
      status: "reserved",
      at: run.at,
    });
    expect(remainingBudgets(w, run)).toEqual({
      run: (runBudgetUsd ?? Infinity) - 0.02,
      workspace: 99.98,
    });
    w.settings.runBudgetUsd = 0;
    w.settings.monthlyBudgetUsd = 0;
    expect(remainingBudgets(w, run)).toEqual({ run: -0.02, workspace: -0.02 });
  },
);

test("scheduled runs use team settings at dispatch and deduplicate occurrences", () => {
  const w = workspace();
  w.settings.runBudgetUsd = 0.01;
  const p = proposeWorkflow(w, "101", spec(w));
  decide(w, "101", p.approval.id, true);
  Object.assign(p.workflow.spec, { budgetUsd: 0.1 });
  const due = new Date(p.workflow.nextAt as string);
  w.settings.runBudgetUsd = null;
  w.settings.monthlyBudgetUsd = 12;
  tick(w, "gpt-4.1-mini", due);
  tick(w, "gpt-4.1-mini", due);
  expect(w.runs).toHaveLength(1);
  expect(w.occurrences).toHaveLength(1);
  expect(w.runs[0]?.settings.runBudgetUsd).toBeNull();
  expect(w.runs[0]?.settings.monthlyBudgetUsd).toBe(12);
});

test("budgets have no pilot ceiling while invalid numbers and policy limits remain rejected", () => {
  const settings = settingsSchema.parse({
    name: "Team",
    timezone: "UTC",
    runBudgetUsd: 200,
    monthlyBudgetUsd: 2000,
    maxOutputTokens: 110000,
    maxInputChars: 500000,
    maxTurns: 20,
  });
  expect(settings.runBudgetUsd).toBe(200);
  expect(settings).not.toHaveProperty("maxTurns");
  for (const maxTurns of [0, 1, 21, 1.5])
    expect(settingsSchema.parse({ ...settings, maxTurns })).not.toHaveProperty(
      "maxTurns",
    );
  for (const patch of [
    { runBudgetUsd: -1 },
    { monthlyBudgetUsd: Infinity },
    { retentionDays: 91 },
    { missedRunMinutes: 6 },
  ]) {
    expect(settingsSchema.safeParse({ ...settings, ...patch }).success).toBe(
      false,
    );
  }
  expect(settings).not.toHaveProperty("maxInputChars");
  expect(settings).not.toHaveProperty("maxOutputTokens");
  expect(
    settingsSchema.parse({ name: "Team", timezone: "UTC", language: "en" }),
  ).not.toHaveProperty("language");
});

test("workspace budgets default to unlimited and null is distinct from zero", () => {
  const defaults = settingsSchema.parse({ name: "Team", timezone: "UTC" });
  expect(defaults.runBudgetUsd).toBeNull();
  expect(defaults.monthlyBudgetUsd).toBeNull();
  expect(defaults).not.toHaveProperty("maxTurns");
  for (const budget of [null, 0, 100]) {
    const parsed = settingsSchema.parse({
      ...defaults,
      runBudgetUsd: budget,
      monthlyBudgetUsd: budget,
    });
    expect(parsed.runBudgetUsd).toBe(budget);
    expect(parsed.monthlyBudgetUsd).toBe(budget);
  }
});

test("unlimited budgets preserve configured and pinned caps and account for reservations", () => {
  const w = workspace();
  const r = createRun(w, "101", "test", "101", 0, "gpt-4.1-mini");
  const now = new Date();
  r.attempts.push({
    id: "unknown-charge",
    status: "unknown",
    reserved: 2,
    at: now.toISOString(),
  });
  expect(remainingBudgets(w, r, now)).toEqual({
    run: Infinity,
    workspace: Infinity,
  });
  w.settings.runBudgetUsd = 10;
  expect(remainingBudgets(w, r, now).run).toBe(8);
  w.settings.runBudgetUsd = null;
  r.settings.runBudgetUsd = 5;
  expect(remainingBudgets(w, r, now).run).toBe(3);
  r.settings.runBudgetUsd = null;
  w.settings.monthlyBudgetUsd = 3;
  expect(remainingBudgets(w, r, now)).toEqual({ run: Infinity, workspace: 1 });
  w.settings.runBudgetUsd = 0;
  w.settings.monthlyBudgetUsd = 0;
  expect(remainingBudgets(w, r, now)).toEqual({ run: -2, workspace: -2 });
});

test("optional model capacity uses catalog or documented app defaults and independent overrides", () => {
  expect(modelCapabilities("gpt-4.1-mini")?.source).toBe("catalog");
  expect(modelCapabilities("team/custom")).toEqual({
    limits: { maxOutputTokens: 16384 },
    source: "default",
  });
  expect(selectedModel("team/custom").pricingKnown).toBe(false);
  expect(
    selectedModel("team/custom", { modelPricing: { input: 0, output: 0 } })
      .pricingKnown,
  ).toBe(true);
  expect(
    modelCapabilities("team/custom", { modelLimits: { contextWindow: 100 } })
      .limits,
  ).toEqual({ contextWindow: 100, maxOutputTokens: 99 });
  expect(
    modelCapabilities("team/custom", { modelLimits: { maxOutputTokens: 1000 } })
      .limits,
  ).toEqual({ maxOutputTokens: 1000 });
  const limits = { contextWindow: 200000, maxOutputTokens: 120000 };
  expect(modelCapabilities("team/custom", { modelLimits: limits })).toEqual({
    limits,
    source: "operator",
  });
  expect(
    modelLimitsSchema.safeParse({ contextWindow: 100, maxOutputTokens: 100 })
      .success,
  ).toBe(false);
  expect(inputByteLimit({}, limits)).toBe(199999);
  expect(inputByteLimit({ maxOutputTokens: 110000 }, limits)).toBe(90000);
  expect(
    inputByteLimit({ maxInputChars: 16000, maxOutputTokens: 110000 }, limits),
  ).toBe(16000);
});

test("limit failures remain recognizable in sanitized logs", () => {
  for (const code of [
    "input_budget_exceeded",
    "model_context_limit_exceeded",
    "model_output_limit_exceeded",
    "model_limits_required",
  ]) {
    expect(safeLogCode(new Fault(code))).toBe(code);
  }
});
