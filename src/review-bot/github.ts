import { z } from "zod";
import type { GitHubApp } from "../github/app.ts";
import type { ReviewTask } from "./config.ts";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const pullSnapshot = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  draft: z.boolean(),
  title: z.string(),
  body: z.string().nullable(),
  head: z.object({
    ref: z.string(),
    sha,
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string(), sha }),
});
export type PullSnapshot = z.infer<typeof pullSnapshot>;
export const reviewFinding = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1000)
      .refine((p) => !p.startsWith("/") && !p.split("/").includes("..")),
    line: z.number().int().positive(),
    side: z.enum(["LEFT", "RIGHT"]),
    severity: z.enum(["high", "medium", "low"]),
    body: z.string().min(1).max(3000),
  })
  .strict();
export const reviewFindings = z.array(reviewFinding).max(20);
export type ReviewFinding = z.infer<typeof reviewFinding>;
export const progressMarker = (task: ReviewTask) =>
  `<!-- repodesk-review-task:${task.id} -->`;
export const reviewMarker = (task: ReviewTask) =>
  `<!-- repodesk-review:${task.id}:${task.headSha} -->`;

export function diffLines(patch: string): Set<string> {
  const lines = new Set<string>();
  let left = 0,
    right = 0,
    inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("-")) lines.add(`LEFT:${left++}`);
    else if (line.startsWith("+")) lines.add(`RIGHT:${right++}`);
    else if (line.startsWith(" ")) {
      lines.add(`LEFT:${left++}`);
      lines.add(`RIGHT:${right++}`);
    } else inHunk = false;
  }
  return lines;
}
export class ReviewGitHub {
  constructor(
    readonly app: GitHubApp,
    readonly token: string,
    readonly repository: string,
  ) {}
  async pull(number: number): Promise<PullSnapshot> {
    return pullSnapshot.parse(
      await this.app.reviewResource(
        this.token,
        this.repository,
        `pulls/${number}`,
      ),
    );
  }
  async source(kind: "issue" | "review", id: number) {
    return z
      .object({
        body: z.string(),
        user: z.object({ id: z.number().int().positive() }),
        path: z.string().optional(),
        line: z.number().nullable().optional(),
        in_reply_to_id: z.number().int().positive().optional(),
        pull_request_url: z.string().optional(),
        issue_url: z.string().optional(),
      })
      .parse(
        await this.app.reviewResource(
          this.token,
          this.repository,
          `${kind === "issue" ? "issues" : "pulls"}/comments/${id}`,
        ),
      );
  }
  async progress(task: ReviewTask, body: string) {
    const path = task.progress?.id
      ? `issues/comments/${task.progress.id}`
      : `issues/${task.number}/comments`;
    return z
      .object({ id: z.number().int().positive() })
      .parse(
        await this.app.reviewResource(
          this.token,
          this.repository,
          path,
          { body },
          task.progress?.id ? "PATCH" : undefined,
        ),
      );
  }
  async find(
    number: number,
    kind: "review" | "progress",
    marker: string,
    commitId?: string,
  ) {
    const path =
      kind === "review"
        ? `pulls/${number}/reviews`
        : `issues/${number}/comments`;
    for (let page = 1; page <= 20; page++) {
      const items = z
        .array(
          z.object({
            id: z.number().int().positive(),
            body: z.string().nullable(),
            commit_id: z.string().optional(),
            user: z.object({ login: z.string(), type: z.string() }),
          }),
        )
        .parse(
          await this.app.reviewResource(
            this.token,
            this.repository,
            `${path}?per_page=100&page=${page}`,
          ),
        );
      const match = items.find(
        (i) =>
          i.user.type === "Bot" &&
          i.user.login === `${this.app.config.slug}[bot]` &&
          i.body?.trimEnd().endsWith(marker) &&
          (!commitId || i.commit_id === commitId),
      );
      if (match) return match.id;
      if (items.length < 100) break;
    }
    return undefined;
  }
  async review(task: ReviewTask) {
    const anchors = new Map<string, Set<string>>();
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const files = z
        .array(z.object({ filename: z.string(), patch: z.string().optional() }))
        .parse(
          await this.app.reviewResource(
            this.token,
            this.repository,
            `pulls/${task.number}/files?per_page=100&page=${page}`,
          ),
        );
      for (const file of files)
        anchors.set(file.filename, diffLines(file.patch ?? ""));
      if (files.length < 100) {
        complete = true;
        break;
      }
    }
    const findings = reviewFindings.parse(task.result?.reviewFindings ?? []);
    const comments: {
      path: string;
      line: number;
      side: "LEFT" | "RIGHT";
      body: string;
    }[] = [];
    const unanchored: string[] = [];
    for (const finding of findings) {
      const body = `**${finding.severity}**: ${finding.body}`;
      if (anchors.get(finding.path)?.has(`${finding.side}:${finding.line}`))
        comments.push({
          path: finding.path,
          line: finding.line,
          side: finding.side,
          body,
        });
      else unanchored.push(`- ${finding.path}:${finding.line} — ${body}`);
    }
    const body = `${task.result?.summary ?? "Review completed."}${unanchored.length ? `\n\nFindings without an inline anchor:\n${unanchored.join("\n")}` : ""}${complete ? "" : "\n\nInline placement covered the first 1,000 changed files."}\n\n${reviewMarker(task)}`;
    return { commit_id: task.headSha, event: "COMMENT", body, comments };
  }
  async publishReview(
    task: ReviewTask,
    payload: Awaited<ReturnType<ReviewGitHub["review"]>>,
  ) {
    return z
      .object({ id: z.number().int().positive() })
      .parse(
        await this.app.reviewResource(
          this.token,
          this.repository,
          `pulls/${task.number}/reviews`,
          payload,
        ),
      );
  }
}
