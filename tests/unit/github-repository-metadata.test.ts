import { expect, test } from "bun:test";
import { GitHubApp } from "../../src/github/app.ts";
import { githubFixtureConfig } from "../github-fixture.ts";

test("installation metadata pagination returns every repository without App permission flags", async () => {
  const pages: number[] = [];
  const app = new GitHubApp(githubFixtureConfig, (async (input) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/installation/repositories");
    expect(url.searchParams.get("per_page")).toBe("100");
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    return Response.json({
      repositories: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
        id: (page - 1) * 100 + i + 1,
        full_name: `example/repo-${(page - 1) * 100 + i + 1}`,
        private: true,
        archived: false,
        disabled: false,
        pushed_at: "2026-10-08T00:00:00Z",
        updated_at: "2026-10-08T00:00:01Z",
        permissions: { pull: true, push: true, admin: true },
      })),
    });
  }) as typeof fetch);
  const repositories = await app.installationRepositories("metadata-token");
  expect(pages).toEqual([1, 2]);
  expect(repositories).toHaveLength(101);
  expect(repositories[100]).toEqual({
    id: 101,
    full_name: "example/repo-101",
    private: true,
    archived: false,
    disabled: false,
    pushed_at: "2026-10-08T00:00:00Z",
    updated_at: "2026-10-08T00:00:01Z",
  });
  expect(repositories.every((r) => r.permissions === undefined)).toBe(true);
});

test("an incomplete or failed installation listing never returns partial results", async () => {
  for (const fail of [false, true]) {
    const app = new GitHubApp(githubFixtureConfig, (async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      if (fail && page === 2) return Response.json({}, { status: 503 });
      return Response.json({
        repositories: Array.from({ length: 100 }, (_, i) => ({
          id: (page - 1) * 100 + i + 1,
          full_name: `example/repo-${i}`,
        })),
      });
    }) as typeof fetch);
    await expect(
      app.installationRepositories("metadata-token"),
    ).rejects.toMatchObject({
      code: fail ? "github_unavailable" : "github_selection_too_large",
    });
  }
});
