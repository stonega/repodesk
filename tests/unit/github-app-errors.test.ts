import { expect, test } from "bun:test";
import { GitHubApp } from "../../src/github/app.ts";
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
