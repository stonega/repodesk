import { describe, expect, test } from "bun:test";
import type { GitHubRepository } from "../../src/github/app.ts";
import { mergeRepositories } from "../../src/github/repository-sync.ts";

describe("mergeRepositories", () => {
  const saved: GitHubRepository[] = [
    {
      id: 1,
      full_name: "org/original",
      private: false,
      permissions: { pull: true, push: false, admin: false },
    },
    { id: 2, full_name: "org/removed", private: true },
  ];

  const accessible: GitHubRepository[] = [
    { id: 1, full_name: "org/renamed", private: true },
    { id: 3, full_name: "org/new-repo", private: false },
  ];

  test("selected-only mode updates metadata and drops removed repos without adding new ones", () => {
    expect(mergeRepositories(saved, accessible, false)).toEqual([
      {
        id: 1,
        full_name: "org/renamed",
        private: true,
        permissions: { pull: true, push: false, admin: false },
      },
    ]);
  });

  test("allRepositories mode preserves saved metadata updates, drops removed repos, and appends newly accessible repos", () => {
    expect(mergeRepositories(saved, accessible, true)).toEqual([
      {
        id: 1,
        full_name: "org/renamed",
        private: true,
        permissions: { pull: true, push: false, admin: false },
      },
      { id: 3, full_name: "org/new-repo", private: false },
    ]);
  });
});
