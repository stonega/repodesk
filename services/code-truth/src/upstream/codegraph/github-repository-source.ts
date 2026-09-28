import { Octokit } from "@octokit/rest";
import type { GitHubRepository } from "../config/schema.ts";

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const BRANCH_REQUEST_TIMEOUT_MS = 60_000;
const ARCHIVE_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_API_URL = new URL("https://api.github.com");
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export type ArchiveStream = AsyncIterable<Uint8Array>;

export interface GitHubRepositorySource {
  resolveBranch(repository: GitHubRepository, branch: string): Promise<string>;
  downloadArchive(
    repository: GitHubRepository,
    commit: string,
  ): Promise<ArchiveStream>;
}

type GitHubRepositorySourceOptions = {
  token?: string;
  apiUrl?: URL;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export class OctokitGitHubRepositorySource implements GitHubRepositorySource {
  readonly #octokit: Octokit;

  constructor(options: GitHubRepositorySourceOptions) {
    const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.#octokit = new Octokit({
      ...(options.token ? { auth: options.token } : {}),
      baseUrl: apiUrl.href.replace(/\/$/, ""),
      userAgent: "repodesk-code-truth/1.0.0",
      log: silentLogger,
      ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    });
  }

  async resolveBranch(
    repository: GitHubRepository,
    branch: string,
  ): Promise<string> {
    const response = await this.#octokit.rest.repos.getBranch({
      ...repository,
      branch,
      request: { signal: AbortSignal.timeout(BRANCH_REQUEST_TIMEOUT_MS) },
    });
    const commit = response.data.commit.sha.toLowerCase();
    if (!COMMIT_PATTERN.test(commit)) {
      throw new Error("GitHub returned an invalid commit identifier");
    }
    return commit;
  }

  async downloadArchive(
    repository: GitHubRepository,
    commit: string,
  ): Promise<ArchiveStream> {
    if (!COMMIT_PATTERN.test(commit))
      throw new Error("Invalid commit identifier");
    const response = await this.#octokit.rest.repos.downloadTarballArchive({
      ...repository,
      ref: commit,
      request: {
        parseSuccessResponseBody: false,
        signal: AbortSignal.timeout(ARCHIVE_REQUEST_TIMEOUT_MS),
      },
    });
    const body: unknown = (response as unknown as { data?: unknown }).data;
    if (!isArchiveStream(body))
      throw new Error("GitHub returned an invalid repository archive");
    return body;
  }
}

function isArchiveStream(value: unknown): value is ArchiveStream {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}
