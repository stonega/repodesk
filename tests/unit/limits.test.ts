import { expect, test } from "bun:test";
import { inputByteLimit } from "../../src/agent/limits.ts";
import { modelLimitsSchema } from "../../src/agent/model-settings.ts";
import { modelCapabilities, selectedModel } from "../../src/agent/runtime.ts";
import { Fault, settingsSchema } from "../../src/domain.ts";
import { safeLogCode } from "../../src/observability/logs.ts";

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
  expect(settings.maxTurns).toBe(20);
  expect(settingsSchema.parse({ ...settings, maxTurns: 1 }).maxTurns).toBe(1);
  for (const patch of [
    { runBudgetUsd: -1 },
    { monthlyBudgetUsd: Infinity },
    { maxTurns: 0 },
    { maxTurns: 21 },
    { maxTurns: 1.5 },
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

test("model limits use explicit custom capabilities or catalog, never invented custom metadata", () => {
  expect(modelCapabilities("gpt-4.1-mini")?.source).toBe("catalog");
  expect(modelCapabilities("team/custom")).toBeUndefined();
  expect(() =>
    selectedModel("team/custom", { modelPricing: { input: 0, output: 0 } }),
  ).toThrow("model_limits_required");
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
