import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markPullRequestReady,
  publicationPushArgs,
} from "../../src/coding/local/publication.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { githubFixtureConfig } from "../github-fixture.ts";

test("publication refuses a concurrent maintainer rewind even when the patch is a fast-forward", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-publication-"));
  const remote = join(root, "remote.git"),
    local = join(root, "repo");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[], cwd = root) =>
    execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  const commit = () =>
    git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-am",
        "Fixture",
      ],
      local,
    );
  try {
    git(["init", "--bare", remote]);
    git(["init", "-b", "main", local]);
    git(["remote", "add", "origin", remote], local);
    await writeFile(join(local, "file.txt"), "seed\n");
    git(["add", "file.txt"], local);
    commit();
    const seed = git(["rev-parse", "HEAD"], local);
    await writeFile(join(local, "file.txt"), "maintainer commit\n");
    commit();
    const expected = git(["rev-parse", "HEAD"], local);
    git(["push", "origin", "main"], local);
    await writeFile(join(local, "file.txt"), "bot fix\n");
    commit();
    git(["merge-base", "--is-ancestor", expected, "HEAD"], local);
    git(["--git-dir", remote, "update-ref", "refs/heads/main", seed]);
    expect(() => git(publicationPushArgs("main", expected), local)).toThrow();
    expect(git(["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(
      seed,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const expected = {
  number: 43,
  branch: "codex/repodesk-task",
  headSha: "b".repeat(40),
  baseBranch: "main",
};
const pull = {
  node_id: "PR_fixture",
  number: expected.number,
  state: "open",
  merged: false,
  draft: true,
  head: {
    ref: expected.branch,
    sha: expected.headSha,
    repo: { full_name: "example/workspace" },
  },
  base: { ref: expected.baseBranch },
};
const readyResult = {
  data: {
    markPullRequestReadyForReview: {
      pullRequest: {
        id: pull.node_id,
        isDraft: false,
        headRefOid: expected.headSha,
      },
    },
  },
};
function readinessFixture(
  snapshot: unknown = pull,
  outcome: unknown = readyResult,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = (async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return Response.json(snapshot);
    if (outcome instanceof Error) throw outcome;
    if (outcome instanceof Response) return outcome;
    return Response.json(outcome);
  }) as typeof fetch;
  return { calls, transport };
}

test("a verified same-PR publication marks its existing draft ready with the scoped token", async () => {
  const f = readinessFixture();
  await markPullRequestReady(
    "example/workspace",
    expected,
    "write-fixture",
    f.transport,
  );
  expect(f.calls.map((c) => c.url)).toEqual([
    "https://api.github.com/repos/example/workspace/pulls/43",
    "https://api.github.com/graphql",
  ]);
  for (const call of f.calls) {
    expect(new Headers(call.init.headers).get("authorization")).toBe(
      "Bearer write-fixture",
    );
    expect(call.init.redirect).toBe("error");
  }
  expect(f.calls[1]?.init.method).toBe("POST");
  const body = JSON.parse(String(f.calls[1]?.init.body));
  expect(body.query).toContain("markPullRequestReadyForReview");
  expect(body.variables).toEqual({ id: "PR_fixture" });
});

test("an existing ready PR requires no readiness mutation", async () => {
  const f = readinessFixture({ ...pull, draft: false });
  await markPullRequestReady(
    "example/workspace",
    expected,
    "write-fixture",
    f.transport,
  );
  expect(f.calls).toHaveLength(1);
});

test("readiness cannot be applied to closed, merged, retargeted or changed PRs", async () => {
  for (const patch of [
    { number: 44 },
    { state: "closed" },
    { merged: true },
    { head: { ...pull.head, repo: null } },
    { head: { ...pull.head, repo: { full_name: "other/workspace" } } },
    { head: { ...pull.head, ref: "other-branch" } },
    { head: { ...pull.head, sha: "c".repeat(40) } },
    { base: { ref: "other-base" } },
  ]) {
    const f = readinessFixture({ ...pull, ...patch });
    await expect(
      markPullRequestReady(
        "example/workspace",
        expected,
        "write-fixture",
        f.transport,
      ),
    ).rejects.toThrow("coding_publication_unknown");
    expect(f.calls).toHaveLength(1);
  }
});

test("a lost readiness acknowledgement is never replayed", async () => {
  const f = readinessFixture(pull, new Error("Connection lost"));
  await expect(
    markPullRequestReady(
      "example/workspace",
      expected,
      "write-fixture",
      f.transport,
    ),
  ).rejects.toThrow("Connection lost");
  expect(f.calls).toHaveLength(2);
});

test("readiness requires a confirmed matching non-draft GraphQL result", async () => {
  for (const outcome of [
    new Response("Denied", { status: 403 }),
    { ...readyResult, errors: [{ message: "Denied" }] },
    { errors: [{ message: "Denied" }], data: null },
    ...[
      { id: "PR_other" },
      { isDraft: true },
      { headRefOid: "c".repeat(40) },
    ].map((patch) => ({
      data: {
        markPullRequestReadyForReview: {
          pullRequest: {
            ...readyResult.data.markPullRequestReadyForReview.pullRequest,
            ...patch,
          },
        },
      },
    })),
  ]) {
    const f = readinessFixture(pull, outcome);
    await expect(
      markPullRequestReady(
        "example/workspace",
        expected,
        "write-fixture",
        f.transport,
      ),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(2);
  }
});

test("lost publication reconciliation requires an open, ready PR at the verified commit", async () => {
  for (const patch of [
    { draft: false },
    { draft: true },
    { draft: false, state: "closed" },
    { draft: false, head: { ...pull.head, sha: "c".repeat(40) } },
  ]) {
    const app = new GitHubApp(githubFixtureConfig, (async (_input, _init) =>
      Response.json([{ ...pull, ...patch }])) as typeof fetch);
    const result = await app.codingPublishedPull(
      "read-fixture",
      "example/workspace",
      expected.branch,
      expected.headSha,
      expected.baseBranch,
    );
    expect(result?.number).toBe(
      patch.draft === false && !("state" in patch) && !("head" in patch)
        ? 43
        : undefined,
    );
  }
});
