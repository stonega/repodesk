import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import type { CodingTask } from "./config.ts";

const runSchema = z.object({
  id: z.number().int().positive(),
  display_title: z.string(),
  event: z.string(),
  head_branch: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
export class CodingGitHub {
  constructor(private transport: typeof fetch = fetch) {}
  private async request(token: string, path: string, body?: unknown) {
    try {
      const response = await this.transport(`https://api.github.com${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
          authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if ([400, 401, 403, 404, 409, 422, 429].includes(response.status))
        throw new Fault("coding_github_rejected", 409);
      requireThat(
        response.ok,
        body === undefined
          ? "coding_github_unavailable"
          : "coding_outcome_unknown",
        502,
      );
      if (response.status === 204 || response.status === 202) return undefined;
      return await response.json();
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(
        body === undefined
          ? "coding_github_unavailable"
          : "coding_outcome_unknown",
        502,
      );
    }
  }
  async dispatch(token: string, task: CodingTask) {
    const p = task.payload;
    requireThat(task.issue, "coding_issue_missing", 409);
    const result = await this.request(
      token,
      `/repos/${p.repository}/actions/workflows/${encodeURIComponent(p.workflowFile)}/dispatches`,
      {
        ref: `refs/heads/${p.baseBranch}`,
        inputs: {
          task_id: task.id,
          issue_number: String(task.issue.number),
          title: p.title,
          body: p.body,
        },
      },
    );
    // Older GitHub API versions return 204; discover those runs by exact run-name.
    if (result === undefined) return undefined;
    const parsed = z
      .object({ workflow_run_id: z.number().int().positive() })
      .safeParse(result);
    requireThat(parsed.success, "coding_outcome_unknown", 409);
    return parsed.data.workflow_run_id;
  }
  async run(token: string, task: CodingTask) {
    const p = task.payload;
    const matches = (run: z.infer<typeof runSchema>) =>
      [`repodesk-coding:${task.id}`, `deepx-coding:${task.id}`].includes(
        run.display_title,
      ) &&
      run.event === "workflow_dispatch" &&
      run.head_branch === p.baseBranch;
    if (task.workflowRunId) {
      const run = runSchema.parse(
        await this.request(
          token,
          `/repos/${p.repository}/actions/runs/${task.workflowRunId}`,
        ),
      );
      requireThat(matches(run), "coding_run_mismatch", 409);
      return run;
    }
    const found: z.infer<typeof runSchema>[] = [];
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({
        event: "workflow_dispatch",
        branch: p.baseBranch,
        created: `>=${task.createdAt}`,
        per_page: "100",
        page: String(page),
      });
      const result = z
        .object({ workflow_runs: z.array(runSchema) })
        .parse(
          await this.request(
            token,
            `/repos/${p.repository}/actions/workflows/${encodeURIComponent(p.workflowFile)}/runs?${params}`,
          ),
        );
      found.push(...result.workflow_runs.filter(matches));
      if (result.workflow_runs.length < 100) break;
    }
    requireThat(found.length <= 1, "coding_run_ambiguous", 409);
    return found[0];
  }
  async pull(token: string, task: CodingTask) {
    const p = task.payload;
    const branches = [`codex/repodesk-${task.id}`, `codex/deepx-${task.id}`];
    const pullSchema = z.array(
      z.object({
        number: z.number().int().positive(),
        body: z.string().nullable(),
        head: z.object({
          ref: z.string(),
          repo: z.object({ full_name: z.string() }).nullable(),
        }),
        base: z.object({ ref: z.string() }),
      }),
    );
    const matches: z.infer<typeof pullSchema> = [];
    for (const branch of branches) {
      const params = new URLSearchParams({
        state: "all",
        head: `${p.repository.split("/")[0]}:${branch}`,
        base: p.baseBranch,
      });
      const pulls = pullSchema.parse(
        await this.request(token, `/repos/${p.repository}/pulls?${params}`),
      );
      matches.push(
        ...pulls.filter(
          (r) =>
            r.head.ref === branch &&
            r.head.repo?.full_name === p.repository &&
            r.base.ref === p.baseBranch &&
            r.body?.includes(
              `https://github.com/${p.repository}/issues/${task.issue?.number}`,
            ),
        ),
      );
    }
    requireThat(matches.length <= 1, "coding_pr_ambiguous", 409);
    return matches[0]
      ? `https://github.com/${p.repository}/pull/${matches[0].number}`
      : undefined;
  }
  async cancel(token: string, task: CodingTask) {
    requireThat(task.workflowRunId, "coding_run_missing", 409);
    await this.request(
      token,
      `/repos/${task.payload.repository}/actions/runs/${task.workflowRunId}/cancel`,
      {},
    );
  }
}
