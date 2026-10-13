import { expect, test } from "bun:test";
import {
  credentialsSchema,
  modelCurrencies,
} from "../../src/agent/model-settings.ts";

test("model configuration validates URL, model ID, thinking and prices", () => {
  expect(
    credentialsSchema.parse({
      version: 1,
      modelBaseUrl: " http://localhost:11434/v1/ ",
      model: " team/custom ",
      modelKey: "local",
      thinkingLevel: "high",
    }),
  ).toMatchObject({
    modelBaseUrl: "http://localhost:11434/v1",
    model: "team/custom",
    modelKey: "local",
  });
  for (const modelBaseUrl of [
    "",
    "not a URL",
    "file:///tmp/model",
    "ftp://host/api",
    "https://user:secret@host/v1",
    "https://host/v1?api_key=secret",
    "https://host/v1#secret",
  ]) {
    expect(
      credentialsSchema.safeParse({ version: 1, modelBaseUrl }).success,
    ).toBe(false);
  }
  for (const patch of [
    { model: " " },
    { model: "a b" },
    { modelKey: " " },
    { thinkingLevel: "extreme" },
    { modelPricing: { input: -1, output: 1 } },
    { modelPricing: { output: Infinity } },
    { modelLimits: { contextWindow: 0 } },
    { arbitrarySetting: true },
  ]) {
    expect(credentialsSchema.safeParse({ version: 1, ...patch }).success).toBe(
      false,
    );
  }
  for (const patch of [
    { modelPricing: { input: 1 } },
    { modelPricing: { output: 0 } },
    { modelLimits: { contextWindow: 1000000 } },
    { modelLimits: { maxOutputTokens: 200000 } },
  ])
    expect(credentialsSchema.safeParse({ version: 1, ...patch }).success).toBe(
      true,
    );
});

test("model price currencies require an explicit valid USD rate and retain legacy USD prices", () => {
  const parse = (modelPricing: unknown) =>
    credentialsSchema.safeParse({ version: 1, modelPricing });
  expect(parse({ input: 7, output: 21 }).success).toBe(true);
  for (const currency of modelCurrencies) {
    expect(
      parse({ currency, usdRate: currency === "USD" ? 1 : 0.14, input: 0 })
        .success,
    ).toBe(true);
  }
  for (const modelPricing of [
    { currency: "CNY", input: 7 },
    { currency: "invalid", usdRate: 1 },
    { currency: "USD", usdRate: 0.14 },
    { usdRate: 0.14 },
    ...[0, -1, Infinity, NaN, 10001].map((usdRate) => ({
      currency: "CNY",
      usdRate,
    })),
  ])
    expect(parse(modelPricing).success).toBe(false);
  expect(parse({ currency: "TWD", usdRate: 0.03 }).success).toBe(true);
});
