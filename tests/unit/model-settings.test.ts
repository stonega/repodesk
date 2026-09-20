import { expect, test } from "bun:test";
import { credentialsSchema } from "../../src/agent/model-settings.ts";

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
    { modelPricing: { input: 1 } },
    { arbitrarySetting: true },
  ]) {
    expect(credentialsSchema.safeParse({ version: 1, ...patch }).success).toBe(
      false,
    );
  }
});
