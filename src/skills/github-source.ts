import { z } from "zod";
import { Fault, requireThat, type SkillSpec } from "../domain.ts";
import { importMarkdown } from "./import.ts";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const githubSkillUrl = z.string().trim().min(1).max(2048);
export type GitHubSkillLink = {
  repository: string;
  kind: "repository" | "tree" | "blob";
  segments: string[];
};
export type GitHubSkillCandidate = {
  path: string;
  sha: string;
  spec?: SkillSpec;
  error?: string;
  alreadyImported?: boolean;
  duplicate?: boolean;
};
export type GitHubSkillDiscovery = {
  repository: string;
  ref: string;
  scope: string;
  commit: string;
  access: "public" | "connected";
  skills: GitHubSkillCandidate[];
};

function safePath(path: string) {
  return (
    path.length <= 1000 &&
    !path.includes("\\") &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function parseGitHubSkillLink(value: string): GitHubSkillLink {
  try {
    const url = new URL(githubSkillUrl.parse(value));
    requireThat(
      url.protocol === "https:" &&
        url.hostname === "github.com" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search,
      "invalid_github_skill_url",
    );
    const parts = url.pathname
      .replace(/\/$/, "")
      .slice(1)
      .split("/")
      .map(decodeURIComponent);
    const owner = parts.shift();
    const repo = parts.shift()?.replace(/\.git$/, "");
    requireThat(
      owner &&
        /^[A-Za-z0-9-]+$/.test(owner) &&
        repo &&
        /^[A-Za-z0-9_.-]+$/.test(repo) &&
        repo !== "." &&
        repo !== "..",
      "invalid_github_skill_url",
    );
    if (!parts.length)
      return {
        repository: `${owner}/${repo}`,
        kind: "repository",
        segments: [],
      };
    const kind = parts.shift();
    requireThat(
      (kind === "tree" || kind === "blob") &&
        parts.length > 0 &&
        parts.length <= 12 &&
        safePath(parts.join("/")),
      "invalid_github_skill_url",
    );
    requireThat(
      kind !== "blob" || parts.at(-1) === "SKILL.md",
      "invalid_github_skill_url",
    );
    return { repository: `${owner}/${repo}`, kind, segments: parts };
  } catch {
    throw new Fault("invalid_github_skill_url");
  }
}

/** Public reads never carry App credentials and cannot follow redirects. */
export async function publicSkillResource(
  repository: string,
  path: string,
  transport: typeof fetch = fetch,
): Promise<unknown> {
  try {
    const response = await transport(
      `https://api.github.com/repos/${repository}${path ? `/${path}` : ""}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if ([401, 403, 404].includes(response.status))
      throw new Fault("github_access_denied", 403);
    requireThat(response.ok, "github_unavailable", 502);
    requireThat(response.body, "github_unavailable", 502);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        requireThat(
          size <= 8 * 1024 * 1024,
          "github_skill_repository_too_large",
        );
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("github_unavailable", 502);
  }
}

export class GitHubSkillReader {
  constructor(private read: (path: string) => Promise<unknown>) {}
  async resolve(link: GitHubSkillLink) {
    if (link.kind === "repository") {
      const metadata = z
        .object({ default_branch: z.string().min(1).max(200) })
        .parse(await this.read(""));
      return {
        ref: metadata.default_branch,
        scope: "",
        commit: await this.commit(metadata.default_branch),
      };
    }
    // GitHub links do not delimit slash-containing branches. Resolve the longest
    // actual ref before treating the remaining segments as a repository path.
    const maximum =
      link.kind === "blob" ? link.segments.length - 1 : link.segments.length;
    for (let length = maximum; length > 0; length--) {
      const ref = link.segments.slice(0, length).join("/");
      try {
        const commit = await this.commit(ref);
        return { ref, scope: link.segments.slice(length).join("/"), commit };
      } catch (error) {
        if (!(error instanceof Fault) || error.code !== "github_access_denied")
          throw error;
      }
    }
    throw new Fault("github_skill_ref_not_found", 404);
  }
  async commit(ref: string) {
    return z
      .object({ sha })
      .parse(await this.read(`commits/${encodeURIComponent(ref)}`)).sha;
  }
  async files(commit: string, scope: string, exact = false) {
    const tree = z
      .object({
        truncated: z.boolean(),
        tree: z
          .array(
            z.object({
              path: z.string(),
              sha,
              type: z.string(),
              mode: z.string(),
              size: z.number().optional(),
            }),
          )
          .max(50000),
      })
      .parse(await this.read(`git/trees/${commit}?recursive=1`));
    requireThat(!tree.truncated, "github_skill_repository_too_large");
    const files = tree.tree.filter(
      (file) =>
        file.type === "blob" &&
        ["100644", "100755"].includes(file.mode) &&
        (file.path === "SKILL.md" || file.path.endsWith("/SKILL.md")) &&
        (exact
          ? file.path === scope
          : !scope ||
            file.path === `${scope}/SKILL.md` ||
            file.path.startsWith(`${scope}/`)),
    );
    requireThat(files.length <= 100, "github_too_many_skills");
    return files
      .map((file) => {
        requireThat(safePath(file.path), "invalid_github_skill_path");
        return file;
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  async candidate(file: {
    path: string;
    sha: string;
    size?: number;
  }): Promise<GitHubSkillCandidate> {
    if ((file.size ?? 0) > 16384)
      return { path: file.path, sha: file.sha, error: "invalid_markdown" };
    const blob = z
      .object({
        sha,
        encoding: z.literal("base64"),
        size: z.number().max(16384),
        content: z.string().max(24000),
      })
      .safeParse(await this.read(`git/blobs/${file.sha}`));
    if (!blob.success || blob.data.sha !== file.sha)
      return { path: file.path, sha: file.sha, error: "invalid_markdown" };
    try {
      const bytes = Buffer.from(blob.data.content, "base64");
      requireThat(bytes.length === blob.data.size, "invalid_markdown");
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { path: file.path, sha: file.sha, spec: importMarkdown(markdown) };
    } catch (error) {
      return {
        path: file.path,
        sha: file.sha,
        error: error instanceof Fault ? error.code : "invalid_skill_metadata",
      };
    }
  }
  async discover(link: GitHubSkillLink) {
    const source = await this.resolve(link);
    const files = await this.files(
      source.commit,
      source.scope,
      link.kind === "blob",
    );
    const skills: GitHubSkillCandidate[] = [];
    // Bound upstream concurrency and retain invalid candidates for explicit UI feedback.
    for (let i = 0; i < files.length; i += 4)
      skills.push(
        ...(await Promise.all(
          files.slice(i, i + 4).map((file) => this.candidate(file)),
        )),
      );
    return { ...source, skills };
  }
}
