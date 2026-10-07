import { generateKeyPairSync } from "node:crypto";
import { GitHubApp } from "../src/github/app.ts";

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
export const githubFixtureConfig = {
  id: 123,
  clientId: "Iv1.fixture",
  clientSecret: "fixture-client-secret",
  privateKey: keys.privateKey,
  slug: "deepx-fixture",
};
export const githubPublicKey = keys.publicKey;
export function githubTransport(
  observe?: (url: string, init: RequestInit) => void,
  repositoryCount = 2,
) {
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    observe?.(url, init);
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status });
    if (
      url ===
      "https://api.github.com/app-manifests/fixture-manifest-code/conversions"
    )
      return json(
        {
          id: githubFixtureConfig.id,
          slug: githubFixtureConfig.slug,
          client_id: githubFixtureConfig.clientId,
          client_secret: githubFixtureConfig.clientSecret,
          pem: githubFixtureConfig.privateKey,
          owner: { login: "example" },
          permissions: {
            contents: "write",
            metadata: "read",
            issues: "write",
            pull_requests: "write",
            members: "read",
          },
        },
        201,
      );
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init.body));
      if (
        body.code !== "fixture-code" ||
        !body.code_verifier ||
        body.client_secret !== githubFixtureConfig.clientSecret
      )
        return json({ error: "bad_verification_code" });
      return json({ access_token: "ghu_fixture_secret" });
    }
    if (url === "https://api.github.com/user")
      return json({ id: 42, login: "fixture-user" });
    if (url.startsWith("https://api.github.com/user/installations?"))
      return json({
        installations: [
          {
            id: 501,
            app_id: 123,
            account: { login: "example" },
            suspended_at: null,
          },
          {
            id: 999,
            app_id: 456,
            account: { login: "wrong-app" },
            suspended_at: null,
          },
        ],
      });
    if (
      url.startsWith(
        "https://api.github.com/user/installations/501/repositories?",
      ) ||
      url.startsWith("https://api.github.com/installation/repositories?")
    )
      return json({
        repositories: Array.from({ length: repositoryCount }, (_, index) => ({
          id: 7001 + index,
          full_name:
            index === 0
              ? "example/workspace"
              : index === 1
                ? "example/second"
                : `example/repo-${index + 1}`,
        })),
      });
    if (url === "https://api.github.com/app/installations/501/access_tokens")
      return json({
        token: "ghs_fixture_installation_secret",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    if (url === "https://api.github.com/app/installations/501")
      return json({
        app_id: 123,
        account: { id: 100, login: "example", type: "Organization" },
        suspended_at: null,
        permissions: { members: "read" },
      });
    if (url.startsWith("https://api.github.com/orgs/example/members?"))
      return json([
        { id: 42, login: "fixture-user" },
        { id: 43, login: "second-user" },
      ]);
    return json({ message: "denied" }, 404);
  }) as typeof fetch;
  return fetcher;
}
export function githubFixture(
  observe?: (url: string, init: RequestInit) => void,
  repositoryCount = 2,
) {
  return new GitHubApp(
    githubFixtureConfig,
    githubTransport(observe, repositoryCount),
  );
}
