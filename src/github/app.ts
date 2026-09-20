import { createHash, sign } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.ts";
import { Fault, requireThat } from "../domain.ts";

export interface GitHubAppConfig {
  id: number;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  slug: string;
}
const accountSchema = z.object({ login: z.string().min(1).max(100) });
const installationSchema = z.object({
  id: z.number().int().positive(),
  app_id: z.number().int().positive(),
  account: accountSchema,
  suspended_at: z.string().nullable(),
});
const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
});
export type GitHubRepository = z.infer<typeof repositorySchema>;
export interface GitHubInstallation {
  id: number;
  account: string;
}
export class GitHubApp {
  constructor(
    readonly config: GitHubAppConfig,
    private transport: typeof fetch = fetch,
  ) {}
  authorizationUrl(state: string, verifier: string, callback: string) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: callback,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }
  get installUrl() {
    return `https://github.com/apps/${this.config.slug}/installations/new`;
  }
  private async request(url: string, token?: string, body?: unknown) {
    try {
      const response = await this.transport(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if ([401, 403, 404].includes(response.status))
        throw new Fault("github_access_denied", 403);
      requireThat(response.ok, "github_unavailable", 502);
      return await response.json();
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault("github_unavailable", 502);
    }
  }
  async exchange(code: string, verifier: string, callback: string) {
    const data = await this.request(
      "https://github.com/login/oauth/access_token",
      undefined,
      {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: callback,
      },
    );
    const result = z
      .object({ access_token: z.string().min(1).max(8192) })
      .safeParse(data);
    requireThat(result.success, "github_authorization_failed", 400);
    const user = accountSchema.parse(
      await this.request(
        "https://api.github.com/user",
        result.data.access_token,
      ),
    );
    return { token: result.data.access_token, login: user.login };
  }
  private async pages(
    token: string,
    path: string,
    field: string,
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= 5; page++) {
      const data = await this.request(
        `https://api.github.com${path}?per_page=100&page=${page}`,
        token,
      );
      const items = z.array(z.unknown()).parse(data[field]);
      result.push(...items);
      if (items.length < 100) return result;
    }
    throw new Fault("github_selection_too_large", 400);
  }
  async installations(token: string): Promise<GitHubInstallation[]> {
    return z
      .array(installationSchema)
      .parse(await this.pages(token, "/user/installations", "installations"))
      .filter((i) => i.app_id === this.config.id && !i.suspended_at)
      .map((i) => ({ id: i.id, account: i.account.login }));
  }
  async repositories(
    token: string,
    installationId: number,
  ): Promise<GitHubRepository[]> {
    requireThat(
      (await this.installations(token)).some((i) => i.id === installationId),
      "github_access_denied",
      403,
    );
    return z
      .array(repositorySchema)
      .parse(
        await this.pages(
          token,
          `/user/installations/${installationId}/repositories`,
          "repositories",
        ),
      );
  }
  private jwt() {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.config.clientId })}`;
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), this.config.privateKey).toString("base64url")}`;
  }
  async installationToken(installationId: number, repositoryIds: number[]) {
    requireThat(
      repositoryIds.length > 0 && repositoryIds.length <= 12,
      "github_repository_not_connected",
      409,
    );
    const data = await this.request(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      this.jwt(),
      {
        repository_ids: repositoryIds,
        permissions: { contents: "read" },
      },
    );
    return z
      .object({
        token: z.string().min(1).max(8192),
        expires_at: z.string().datetime(),
      })
      .parse(data);
  }
}

export function configuredGitHubApp(config: Config) {
  if (
    !config.GITHUB_APP_ID ||
    !config.GITHUB_APP_CLIENT_ID ||
    !config.GITHUB_APP_CLIENT_SECRET ||
    !config.GITHUB_APP_PRIVATE_KEY ||
    !config.GITHUB_APP_SLUG
  )
    return undefined;
  return new GitHubApp({
    id: config.GITHUB_APP_ID,
    clientId: config.GITHUB_APP_CLIENT_ID,
    clientSecret: config.GITHUB_APP_CLIENT_SECRET,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
    slug: config.GITHUB_APP_SLUG,
  });
}
