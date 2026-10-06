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
      executionMode: "direct",
      publishByDefault: true,
    }),
  ).toEqual({ executionMode: "direct", publishByDefault: true });
  expect(developmentPolicy.parse({})).toEqual({
    executionMode: "reviewed",
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
      repositories: [
        {
          repositoryId: 1,
          baseBranch: "develop",
          maintainers: ["101"],
          development: {
            ...legacy,
            executionMode: "direct",
            publishByDefault: true,
          },
        },
      ],
    },
  });
  expect(save.settings.repositories[0]?.development).toEqual({
    executionMode: "direct",
    publishByDefault: true,
  });
});
