import { expect, test } from "bun:test";
import { OctokitGitHubRepositorySource } from "../src/upstream/codegraph/github-repository-source.ts";

test("default branch discovery uses repository metadata instead of assuming main", async () => {
  const paths: string[] = [];
  let branch = "trunk";
  const source = new OctokitGitHubRepositorySource({
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      paths.push(path);
      return Response.json(
        path.endsWith(`/branches/${branch}`)
          ? { commit: { sha: "a".repeat(40) } }
          : { default_branch: branch },
      );
    },
  });
  const repository = { owner: "example", repo: "application" };
  expect(await source.defaultBranch(repository)).toBe("trunk");
  expect(await source.resolveBranch(repository, "trunk")).toBe("a".repeat(40));
  branch = "develop";
  expect(await source.defaultBranch(repository)).toBe("develop");
  expect(paths).toEqual([
    "/repos/example/application",
    "/repos/example/application/branches/trunk",
    "/repos/example/application",
  ]);
});

test("missing default branch metadata fails without guessing a branch", async () => {
  const source = new OctokitGitHubRepositorySource({
    fetch: async () => Response.json({}),
  });
  await expect(
    source.defaultBranch({ owner: "example", repo: "empty" }),
  ).rejects.toThrow("invalid default branch");
});
