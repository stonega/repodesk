import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { codingSaveSchema } from "../../src/coding/config.ts";
import { developmentRun } from "../../src/coding/development.ts";
import { developmentPolicy } from "../../src/coding/development-policy.ts";

const legacy = {
  maxAttempts: 1,
  maxRepairAttempts: 0,
  activeSeconds: 60,
  maxTokens: 1000,
};

test("retired Codex quotas are discarded without default or hidden overrides", () => {
  expect(
    developmentPolicy.parse({
      ...legacy,
      publishByDefault: true,
    }),
  ).toEqual({ publishByDefault: true });
  expect(developmentPolicy.parse({})).toEqual({
    publishByDefault: false,
  });
  const run = developmentRun.parse({
    ...legacy,
    taskId: randomUUID(),
    revision: 1,
    mode: "work",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "101:10",
        text: "Fix pagination",
        kind: "request",
      },
    ],
  });
  for (const key of Object.keys(legacy)) expect(run).not.toHaveProperty(key);
  expect(() => developmentPolicy.parse({ executionMode: "bypass" })).toThrow();
  expect(() => developmentPolicy.parse({ allowSecrets: true })).toThrow();
  expect(() => developmentRun.parse({ ...run, bypassChecks: true })).toThrow();
});

test("older settings clients cannot preserve retired execution overrides", () => {
  const save = codingSaveSchema.parse({
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      development: {
        ...legacy,
        publishByDefault: true,
      },
    },
  });
  expect(save.settings.development).toEqual({
    publishByDefault: true,
  });
});

test("Codex has one workflow and rejects the removed execution policy", () => {
  for (const executionMode of ["reviewed", "direct"]) {
    expect(() => developmentPolicy.parse({ executionMode })).toThrow();
    expect(() =>
      codingSaveSchema.parse({
        revision: 1,
        settings: {
          enabled: true,
          backend: "podman",
          development: { executionMode },
        },
      }),
    ).toThrow();
  }
});
