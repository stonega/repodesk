import { expect, test } from "bun:test";
import {
  codeRepositorySchema,
  codeTruthSchema,
  targetsFor,
} from "../../src/code-truth/config.ts";

const workspace = "34cae046-0696-45c1-9bd6-79964f756101";
const repository = {
  repositoryUrl: "https://github.com/example/application.git",
  description: "  Application source and shared packages.  ",
  workspaces: [workspace],
};

test("repository IDs are generated without user input and stay stable on edit", () => {
  const saved = codeRepositorySchema.parse(repository);
  expect(saved.id).toMatch(/^repo-[0-9a-f-]{36}$/);
  expect(saved.description).toBe("Application source and shared packages.");
  expect(codeRepositorySchema.parse(repository).id).not.toBe(saved.id);
  expect(
    codeRepositorySchema.parse({ ...saved, description: "Updated" }).id,
  ).toBe(saved.id);
});

test("legacy mappings become default-branch targets without losing IDs or tenant scope", () => {
  const settings = codeTruthSchema.parse({
    enabled: true,
    repositories: [
      {
        ...repository,
        id: "legacy",
        networks: { devnet: "develop", testnet: "test" },
      },
    ],
  });
  expect(settings.repositories[0]).not.toHaveProperty("networks");
  expect(settings.repositories[0]?.id).toBe("legacy");
  expect(targetsFor(settings, workspace)).toEqual([
    {
      id: "legacy",
      repositoryUrl: repository.repositoryUrl,
      description: "Application source and shared packages.",
      networks: { default: "HEAD" },
    },
  ]);
  expect(targetsFor(settings, "another-workspace")).toEqual([]);
});

test("descriptions are optional and bounded; duplicate repositories cannot acquire different IDs", () => {
  expect(
    codeRepositorySchema.safeParse({ ...repository, description: undefined })
      .success,
  ).toBe(true);
  expect(
    codeRepositorySchema.safeParse({
      ...repository,
      description: "x".repeat(2001),
    }).success,
  ).toBe(false);
  expect(
    codeTruthSchema.safeParse({
      enabled: true,
      repositories: [
        repository,
        {
          ...repository,
          repositoryUrl: "https://github.com/EXAMPLE/application",
        },
      ],
    }).success,
  ).toBe(false);
});
