import { expect, test } from "bun:test";
import { GitHubApp, GitHubRateLimitError } from "../../src/github/app.ts";
import { githubFixtureConfig } from "../github-fixture.ts";

function rejected(body: unknown) {
  return (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body, { status: 422 })) as typeof fetch;
}

test("missing installation permissions report a configuration blocker for scoped coding tokens", async () => {
  const app = new GitHubApp(
    githubFixtureConfig,
    rejected({
      message:
        "The permissions requested are not granted to this installation.",
      privateDiagnostic: "private secret",
    }),
  );
  for (const permission of ["contents", "coding_read", "publish"] as const)
    await expect(
      app.installationToken(501, [7001], permission),
    ).rejects.toThrow("github_app_permissions_missing");
});
test("primary and secondary rate limits remain retryable and respect GitHub cooldowns", async () => {
  const reset = Math.ceil(Date.now() / 1000) + 3600;
  for (const response of [
    Response.json(
      {},
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
      },
    ),
    Response.json({}, { status: 429, headers: { "retry-after": "3600" } }),
    Response.json(
      { message: "You have exceeded a secondary rate limit. private secret" },
      { status: 403 },
    ),
  ]) {
    const started = Date.now();
    const app = new GitHubApp(
      githubFixtureConfig,
      (async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response) as typeof fetch,
    );
    try {
      await app.user("fixture");
      throw new Error("Expected a rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubRateLimitError);
      const limit = error as GitHubRateLimitError;
      expect(limit.retryAt).toBeGreaterThanOrEqual(started + 60000);
      if (response.headers.has("x-ratelimit-reset"))
        expect(limit.retryAt).toBeGreaterThanOrEqual(reset * 1000);
      if (response.status === 429)
        expect(limit.retryAt).toBeGreaterThanOrEqual(started + 3600000);
      expect(String(error)).not.toContain("private secret");
    }
  }
  const app = new GitHubApp(githubFixtureConfig, (async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ) =>
    Response.json(
      { message: "Permission denied" },
      { status: 403 },
    )) as typeof fetch);
  await expect(app.user("fixture")).rejects.toThrow("github_access_denied");
});

test("unrelated GitHub rejections and invalid responses stay generic without leaking response text", async () => {
  for (const body of [
    { message: "private secret" },
    { message: { privateDiagnostic: "private secret" } },
  ]) {
    const app = new GitHubApp(githubFixtureConfig, rejected(body));
    await expect(app.installationToken(501, [7001])).rejects.toThrow(
      "github_unavailable",
    );
  }
  const app = new GitHubApp(
    githubFixtureConfig,
    rejected({
      message:
        "The permissions requested are not granted to this installation.",
    }),
  );
  await expect(app.user("fixture")).rejects.toThrow("github_unavailable");
});
