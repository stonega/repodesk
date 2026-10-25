import { expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import { currencies } from "../../src/currency.ts";
import { settingsSchema } from "../../src/domain.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

test("team currency defaults to USD and accepts only supported currency codes", () => {
  const settings = { name: "Team", timezone: "UTC" };
  expect(settingsSchema.parse(settings).currency).toBe("USD");
  for (const currency of currencies)
    expect(settingsSchema.parse({ ...settings, currency }).currency).toBe(
      currency,
    );
  for (const currency of ["", "twd", "XYZ", null, 123])
    expect(settingsSchema.safeParse({ ...settings, currency }).success).toBe(
      false,
    );
});

test("assistant currency uses the run snapshot, isolates teams and supports historical runs", () => {
  const w = workspace();
  w.settings.currency = "TWD";
  w.settings.runBudgetUsd = 10;
  const run = createRun(
    w,
    "101",
    "Estimate the cost",
    "101",
    0,
    "gpt-4.1-mini",
  );
  w.settings.currency = "EUR";
  const context = buildContext(w, run);
  expect(JSON.parse(context.prompt)).toMatchObject({
    currency: "TWD",
    runBudgetUsd: 10,
  });
  expect(context.system).toContain("never invent exchange rates");
  expect(workspace().settings.currency).toBe("USD");
  Reflect.deleteProperty(run.settings, "currency");
  expect(JSON.parse(buildContext(w, run).prompt).currency).toBe("USD");
});
