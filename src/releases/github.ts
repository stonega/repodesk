import { createHash } from "node:crypto";
import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import { type PreparedRelease, sha } from "./types.ts";

const release = z.object({
  id: z.number().int().positive(),
  html_url: z.string(),
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});
export type RemoteRelease = z.infer<typeof release>;
const asset = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  digest: z.string().nullable(),
  state: z.string(),
  browser_download_url: z.string(),
});

/** Fixed GitHub endpoints only. Secrets and raw upstream errors never escape this adapter. */
export class ReleaseGitHub {
  constructor(
    private repository: string,
    private token: string,
    private transport: typeof fetch = fetch,
  ) {
    requireThat(
      /^[\w.-]+\/[\w.-]+$/.test(repository),
      "coding_release_repository_invalid",
    );
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    binary?: Buffer,
  ): Promise<unknown | undefined> {
    try {
      const response = await this.transport(
        `https://${binary ? "uploads" : "api"}.github.com/repos/${this.repository}/${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/vnd.github+json",
            "content-type": binary
              ? "application/octet-stream"
              : "application/json",
            "X-GitHub-Api-Version": "2026-03-10",
          },
          body: binary
            ? new Uint8Array(binary)
            : body === undefined
              ? undefined
              : JSON.stringify(body),
        },
      );
      if (response.status === 404 && method === "GET") return;
      requireThat(
        response.ok,
        method === "GET"
          ? "coding_release_read_failed"
          : "coding_release_outcome_unknown",
        502,
      );
      const text = await response.text();
      requireThat(
        Buffer.byteLength(text) <= 512 * 1024,
        "coding_release_response_invalid",
        502,
      );
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(
        method === "GET"
          ? "coding_release_read_failed"
          : "coding_release_outcome_unknown",
        502,
      );
    }
  }
  async tag(tag: string) {
    let value = await this.request(`git/ref/tags/${encodeURIComponent(tag)}`);
    if (!value) return;
    let object = z
      .object({ object: z.object({ sha, type: z.string() }) })
      .parse(value).object;
    for (let depth = 0; object.type === "tag" && depth < 4; depth++) {
      value = await this.request(`git/tags/${object.sha}`);
      object = z
        .object({ object: z.object({ sha, type: z.string() }) })
        .parse(value).object;
    }
    requireThat(object.type === "commit", "coding_release_tag_conflict", 409);
    return object.sha;
  }
  async createTag(tag: string, commit: string) {
    await this.request("git/refs", "POST", {
      ref: `refs/tags/${tag}`,
      sha: sha.parse(commit),
    });
  }
  async readRelease(tag: string) {
    const value = await this.request(
      `releases/tags/${encodeURIComponent(tag)}`,
    );
    if (!value) return;
    const parsed = release.parse(value);
    requireThat(
      parsed.html_url ===
        `https://github.com/${this.repository}/releases/tag/${encodeURIComponent(tag)}` ||
        parsed.html_url ===
          `https://github.com/${this.repository}/releases/tag/${tag}`,
      "coding_release_response_invalid",
      502,
    );
    return parsed;
  }
  async createRelease(p: PreparedRelease) {
    const r = p.proposal;
    await this.request("releases", "POST", {
      tag_name: r.tag,
      target_commitish: p.targetSha,
      name: r.name,
      body: r.body,
      draft: r.draft,
      prerelease: r.prerelease,
      generate_release_notes: false,
    });
  }
  async assets(id: number) {
    const value = await this.request(`releases/${id}/assets?per_page=100`);
    const assets = z.array(asset).max(99).parse(value);
    return assets;
  }
  async upload(id: number, file: PreparedRelease["assets"][number]) {
    const bytes = Buffer.from(file.data, "base64");
    requireThat(
      bytes.length <= 1024 * 1024 &&
        createHash("sha256").update(bytes).digest("hex") === file.digest,
      "coding_release_asset_invalid",
      409,
    );
    await this.request(
      `releases/${id}/assets?name=${encodeURIComponent(file.name)}`,
      "POST",
      undefined,
      bytes,
    );
  }
  async ci(commit: string) {
    const status = z
      .object({
        state: z.string(),
        total_count: z.number().int().nonnegative(),
      })
      .parse(await this.request(`commits/${sha.parse(commit)}/status`));
    const checks = z
      .object({
        total_count: z.number().int().nonnegative(),
        check_runs: z.array(
          z.object({
            head_sha: sha,
            status: z.string(),
            conclusion: z.string().nullable(),
          }),
        ),
      })
      .parse(await this.request(`commits/${commit}/check-runs?per_page=100`));
    requireThat(
      checks.total_count <= 100 &&
        checks.check_runs.length === checks.total_count &&
        checks.check_runs.every((c) => c.head_sha === commit),
      "coding_release_ci_incomplete",
      409,
    );
    if (
      status.state === "failure" ||
      status.state === "error" ||
      checks.check_runs.some(
        (c) => c.status === "completed" && c.conclusion !== "success",
      )
    )
      return "failed";
    if (
      status.total_count + checks.total_count === 0 ||
      (status.total_count > 0 && status.state !== "success") ||
      checks.check_runs.some((c) => c.status !== "completed")
    )
      return "pending";
    return "passed";
  }
  async mergedPull(number: number, head: string) {
    const p = z
      .object({
        merged: z.boolean(),
        state: z.string(),
        merge_commit_sha: sha.nullable(),
        head: z.object({ sha }),
        base: z.object({
          ref: z.string(),
          repo: z.object({ full_name: z.string() }),
        }),
      })
      .parse(await this.request(`pulls/${number}`));
    requireThat(
      p.head.sha === head && p.base.repo.full_name === this.repository,
      "coding_release_target_changed",
      409,
    );
    requireThat(
      p.state !== "closed" || p.merged,
      "coding_release_pr_closed",
      409,
    );
    return p;
  }
  async branch(branch: string) {
    return z
      .object({ object: z.object({ sha }) })
      .parse(await this.request(`git/ref/heads/${encodeURIComponent(branch)}`))
      .object.sha;
  }
}
