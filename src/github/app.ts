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
  webhookSecret?: string;
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
  private: z.boolean().optional(),
  permissions: z
    .object({
      pull: z.boolean(),
      push: z.boolean(),
      admin: z.boolean(),
      triage: z.boolean().optional(),
      maintain: z.boolean().optional(),
    })
    .optional(),
});
export type GitHubRepository = z.infer<typeof repositorySchema>;
const memberSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/),
});
export type GitHubMember = z.infer<typeof memberSchema>;
const memberRepositoryBatchSize = 8;
export interface GitHubMemberDirectory {
  connected: boolean;
  revision: number;
  account?: string;
  source?: "organization" | "repositories";
  members: GitHubMember[];
}
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
  private async request(
    url: string,
    token?: string,
    body?: unknown,
    signal?: AbortSignal,
    method?: "PATCH",
  ) {
    try {
      signal?.throwIfAborted();
      const response = await this.transport(url, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(10000),
          ...(signal ? [signal] : []),
        ]),
      });
      if ([401, 403, 404].includes(response.status))
        throw new Fault("github_access_denied", 403);
      if (
        response.status === 422 &&
        url.startsWith("https://api.github.com/app/installations/") &&
        url.endsWith("/access_tokens")
      ) {
        const error = z
          .object({ message: z.string() })
          .safeParse(await response.json());
        if (
          error.success &&
          /permissions requested.*not granted/i.test(error.data.message)
        )
          throw new Fault("github_app_permissions_missing", 409);
      }
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
    const result = this.userToken(data);
    const user = await this.user(result.token);
    return { ...result, login: user.login, id: user.id };
  }
  private userToken(data: unknown) {
    const result = z
      .object({
        access_token: z.string().min(1).max(8192),
        refresh_token: z.string().min(1).max(8192).optional(),
        expires_in: z.number().int().positive().max(31536000).optional(),
      })
      .safeParse(data);
    requireThat(result.success, "github_authorization_failed", 400);
    return {
      token: result.data.access_token,
      refreshToken: result.data.refresh_token,
      expiresAt: result.data.expires_in
        ? new Date(Date.now() + result.data.expires_in * 1000).toISOString()
        : undefined,
    };
  }
  async user(token: string) {
    return accountSchema
      .extend({ id: z.number().int().positive().safe() })
      .parse(await this.request("https://api.github.com/user", token));
  }
  async refresh(refreshToken: string) {
    return this.userToken(
      await this.request(
        "https://github.com/login/oauth/access_token",
        undefined,
        {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
      ),
    );
  }
  private async pages(
    token: string,
    path: string,
    field?: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.request(
        `https://api.github.com${path}?per_page=100&page=${page}`,
        token,
        undefined,
        signal,
      );
      const items = z.array(z.unknown()).parse(field ? data[field] : data);
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
  async metadataToken(installationId: number) {
    return z
      .object({
        token: z.string().min(1).max(8192),
        expires_at: z.string().datetime(),
      })
      .parse(
        await this.request(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          this.jwt(),
          { permissions: { metadata: "read" } },
        ),
      );
  }
  async members(
    installationId: number,
    repositories: GitHubRepository[],
    signal?: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(60000);
    const controller = new AbortController();
    const lookupSignal = AbortSignal.any([
      timeout,
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    try {
      return await this.fetchMembers(
        installationId,
        repositories,
        lookupSignal,
      );
    } catch (error) {
      if (timeout.aborted) throw new Fault("github_members_timeout", 504);
      throw error;
    } finally {
      controller.abort();
    }
  }
  private async fetchMembers(
    installationId: number,
    repositories: GitHubRepository[],
    signal: AbortSignal,
  ) {
    const installation = z
      .object({
        app_id: z.number().int().positive(),
        account: memberSchema.extend({
          type: z.enum(["Organization", "User"]),
        }),
        suspended_at: z.string().nullable(),
        permissions: z.object({ members: z.string().optional() }),
      })
      .parse(
        await this.request(
          `https://api.github.com/app/installations/${installationId}`,
          this.jwt(),
          undefined,
          signal,
        ),
      );
    requireThat(
      installation.app_id === this.config.id && !installation.suspended_at,
      "github_access_denied",
      403,
    );
    const organization = installation.account.type === "Organization";
    if (organization)
      requireThat(
        ["read", "write"].includes(installation.permissions.members ?? ""),
        "github_members_permission_missing",
        409,
      );
    else
      for (const repository of repositories)
        requireThat(
          repository.full_name.split("/")[0]?.toLowerCase() ===
            installation.account.login.toLowerCase(),
          "github_access_denied",
          403,
        );
    const credential = z.object({ token: z.string().min(1).max(8192) }).parse(
      await this.request(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        this.jwt(),
        {
          permissions: organization
            ? { members: "read" }
            : { metadata: "read" },
        },
        signal,
      ),
    );
    const members = new Map<number, GitHubMember>();
    if (organization) {
      for (const member of z
        .array(memberSchema)
        .parse(
          await this.pages(
            credential.token,
            `/orgs/${installation.account.login}/members`,
            undefined,
            signal,
          ),
        ))
        members.set(member.id, member);
    } else {
      members.set(
        installation.account.id,
        memberSchema.parse(installation.account),
      );
      for (
        let index = 0;
        index < repositories.length;
        index += memberRepositoryBatchSize
      ) {
        const batch = await Promise.all(
          repositories
            .slice(index, index + memberRepositoryBatchSize)
            .map(async (repository) =>
              z
                .array(memberSchema)
                .parse(
                  await this.pages(
                    credential.token,
                    `/repos/${repository.full_name}/collaborators`,
                    undefined,
                    signal,
                  ),
                ),
            ),
        );
        for (const membersInRepository of batch)
          for (const member of membersInRepository)
            members.set(member.id, member);
      }
    }
    return {
      account: installation.account.login,
      source: organization
        ? ("organization" as const)
        : ("repositories" as const),
      members: [...members.values()].sort((a, b) =>
        a.login.localeCompare(b.login),
      ),
    };
  }
  async installationRepositories(token: string): Promise<GitHubRepository[]> {
    // Installation permissions describe the App, not the authorizing user's role.
    return z
      .array(repositorySchema.omit({ permissions: true }))
      .parse(
        await this.pages(token, "/installation/repositories", "repositories"),
      );
  }
  async installationToken(
    installationId: number,
    repositoryIds: number[],
    permission:
      | "contents"
      | "issues"
      | "publish"
      | "coding_read"
      | "issues_read"
      | "pulls_read"
      | "review" = "contents",
  ) {
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
        permissions:
          permission === "review"
            ? { pull_requests: "write", issues: "write" }
            : permission === "issues_read"
              ? { issues: "read" }
              : permission === "pulls_read"
                ? { pull_requests: "read" }
                : permission === "issues"
                  ? { issues: "write" }
                  : permission === "publish"
                    ? { contents: "write", pull_requests: "write" }
                    : permission === "coding_read"
                      ? { contents: "read", pull_requests: "read" }
                      : { contents: "read" },
      },
    );
    return z
      .object({
        token: z.string().min(1).max(8192),
        expires_at: z.string().datetime(),
      })
      .parse(data);
  }
  async codingPull(token: string, repository: string, number: number) {
    const pr = z
      .object({
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        merged: z.boolean(),
        head: z.object({
          ref: z.string(),
          sha: z.string().regex(/^[0-9a-f]{40}$/),
          repo: z.object({ full_name: z.string() }).nullable(),
        }),
      })
      .parse(
        await this.request(
          `https://api.github.com/repos/${repository}/pulls/${number}`,
          token,
        ),
      );
    requireThat(pr.state === "open" && !pr.merged, "coding_pr_closed", 409);
    requireThat(
      pr.head.repo?.full_name === repository,
      "coding_pr_target_changed",
      409,
    );
    return {
      number: pr.number,
      url: `https://github.com/${repository}/pull/${pr.number}`,
      branch: pr.head.ref,
      headSha: pr.head.sha,
    };
  }
  /** Application-owned PR operations; never exposed as an arbitrary model tool. */
  async reviewResource(
    token: string,
    repository: string,
    path: string,
    body?: unknown,
    method?: "PATCH",
  ) {
    requireThat(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
      "github_repository_not_connected",
      409,
    );
    requireThat(
      /^(?:pulls\/[1-9]\d*(?:\/files|\/reviews)?|pulls\/comments\/[1-9]\d*|issues\/[1-9]\d*\/comments|issues\/comments\/[1-9]\d*)(?:\?per_page=100&page=[1-9]\d*)?$/.test(
        path,
      ),
      "invalid_github_item",
    );
    return this.request(
      `https://api.github.com/repos/${repository}/${path}`,
      token,
      body,
      undefined,
      method,
    );
  }
  async repositoryMetadata(
    token: string,
    repository: string,
    kind: "pulls" | "issues",
    parameters: URLSearchParams,
    number?: number,
    signal?: AbortSignal,
  ) {
    requireThat(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
      "github_repository_not_connected",
      409,
    );
    requireThat(
      number === undefined || (Number.isSafeInteger(number) && number > 0),
      "invalid_github_item",
    );
    return this.request(
      `https://api.github.com/repos/${repository}/${kind}${number ? `/${number}` : `?${parameters}`}`,
      token,
      undefined,
      signal,
    );
  }
  async codingPublishedPull(
    token: string,
    repository: string,
    branch: string,
    sha: string,
    baseBranch: string,
  ) {
    const owner = repository.split("/")[0];
    const params = new URLSearchParams({
      head: `${owner}:${branch}`,
      state: "all",
      per_page: "100",
    });
    const pulls = z
      .array(
        z.object({
          number: z.number().int().positive(),
          state: z.enum(["open", "closed"]),
          head: z.object({
            ref: z.string(),
            sha: z.string(),
            repo: z.object({ full_name: z.string() }).nullable(),
          }),
          base: z.object({ ref: z.string() }),
        }),
      )
      .parse(
        await this.request(
          `https://api.github.com/repos/${repository}/pulls?${params}`,
          token,
        ),
      );
    const matching = pulls.filter(
      (p) =>
        p.state === "open" &&
        p.head.ref === branch &&
        p.head.sha === sha &&
        p.head.repo?.full_name === repository &&
        p.base.ref === baseBranch,
    );
    if (matching.length !== 1) return;
    const number = matching[0]?.number;
    if (!number) return;
    return {
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      branch,
      headSha: sha,
    };
  }
  async createIssue(
    token: string,
    repository: string,
    title: string,
    body: string,
  ) {
    // No redirects or retries: an ambiguous POST must never be replayed.
    try {
      const response = await this.transport(
        `https://api.github.com/repos/${repository}/issues`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "X-GitHub-Api-Version": "2026-03-10",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ title, body }),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if ([401, 403, 404].includes(response.status))
        throw new Fault("github_issue_access_denied", 403);
      if (response.status === 410)
        throw new Fault("github_issues_disabled", 409);
      if ([400, 422, 429].includes(response.status))
        throw new Fault("github_issue_rejected", 409);
      requireThat(response.status === 201, "github_issue_outcome_unknown", 409);
      const result = z
        .object({ number: z.number().int().positive() })
        .parse(await response.json());
      return {
        number: result.number,
        url: `https://github.com/${repository}/issues/${result.number}`,
      };
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault("github_issue_outcome_unknown", 409);
    }
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
