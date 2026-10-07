import { z } from "zod";
import type { Store } from "../db/repositories.ts";
import { requireThat } from "../domain.ts";
import { repositoryReportWindow } from "../workflows/schedule.ts";
import { runAllowed } from "../workspaces/policy.ts";
import type { GitHubApp } from "./app.ts";
import { recordRepositoryRead } from "./metadata-policy.ts";
import { GitHubApps } from "./registry.ts";

export const metadataQuery = z
  .object({
    repositoryId: z.number().int().positive().safe(),
    kind: z.enum(["pulls", "issues"]),
    number: z.number().int().positive().safe().optional(),
    state: z.enum(["open", "closed", "all", "merged"]).default("open"),
    since: z.iso.datetime().optional(),
    until: z.iso.datetime().optional(),
    page: z.number().int().min(1).max(100).default(1),
  })
  .strict()
  .refine((q) => q.state !== "merged" || q.kind === "pulls")
  .refine(
    (q) => !q.since || !q.until || Date.parse(q.since) < Date.parse(q.until),
  );
const person = z.object({ login: z.string() });
const item = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable().optional(),
  merged_at: z.iso.datetime().nullable().optional(),
  user: person.nullable(),
  assignees: z.array(person).optional(),
  requested_reviewers: z.array(person).optional(),
  requested_teams: z.array(z.object({ slug: z.string() })).optional(),
  draft: z.boolean().optional(),
  pull_request: z.unknown().optional(),
});

/** Bounded, credential-free results; tokens remain in this service. */
export class GitHubMetadata {
  constructor(
    private store: Store,
    private apps: GitHubApps | GitHubApp,
  ) {}
  async read(
    workspaceId: string,
    runId: string,
    value: unknown,
    signal: AbortSignal,
    guard: () => Promise<void>,
  ) {
    const q = metadataQuery.parse(value);
    const check = async () => {
      signal.throwIfAborted();
      await guard();
      return this.store.change(workspaceId, (w) => {
        const r = w.runs.find((r) => r.id === runId);
        requireThat(
          r && r.status === "running" && runAllowed(w, r),
          "tool_policy_denied",
          403,
        );
        requireThat(
          w.github?.installationId,
          "github_repository_not_connected",
          409,
        );
        recordRepositoryRead(w, r, q.repositoryId, w.github.revision);
        const repo = w.github.repositories.find(
          (repo) => repo.id === q.repositoryId,
        );
        requireThat(repo, "github_repository_not_connected", 409);
        const workflow = w.workflows.find((f) => f.id === r.workflowId);
        return {
          repository: repo.full_name,
          installationId: w.github.installationId,
          operatorId: w.operatorId,
          window: workflow?.spec.github
            ? repositoryReportWindow(r.at, workflow.spec)
            : undefined,
        };
      });
    };
    const scope = await check();
    const app =
      this.apps instanceof GitHubApps
        ? await this.apps.get(scope.operatorId)
        : this.apps;
    requireThat(app, "github_app_not_configured", 409);
    const token = await app.installationToken(
      scope.installationId,
      [q.repositoryId],
      q.kind === "pulls" ? "pulls_read" : "issues_read",
    );
    await check();
    const since =
      q.since ?? (q.state === "merged" ? scope.window?.since : undefined);
    const until =
      q.until ?? (q.state === "merged" ? scope.window?.until : undefined);
    const params = new URLSearchParams({
      state: q.state === "merged" ? "closed" : q.state,
      sort: "updated",
      direction: "desc",
      per_page: "20",
      page: String(q.page),
    });
    if (q.kind === "issues" && since) params.set("since", since);
    const raw = await app.repositoryMetadata(
      token.token,
      scope.repository,
      q.kind,
      params,
      q.number,
      signal,
    );
    await check();
    const rows = q.number ? [item.parse(raw)] : z.array(item).parse(raw);
    requireThat(
      !q.number || rows[0]?.number === q.number,
      "github_item_response_mismatch",
      502,
    );
    requireThat(
      !q.number || q.kind !== "issues" || !rows[0]?.pull_request,
      "github_item_is_pull_request",
      409,
    );
    const matches = rows.filter(
      (row) =>
        (q.kind !== "issues" || !row.pull_request) &&
        (q.number || q.state !== "merged" || !!row.merged_at) &&
        (!since ||
          Date.parse(
            q.state === "merged" ? (row.merged_at ?? "") : row.updated_at,
          ) >= Date.parse(since)) &&
        (!until ||
          Date.parse(
            q.state === "merged" ? (row.merged_at ?? "") : row.updated_at,
          ) < Date.parse(until)),
    );
    const reachedWindow =
      !!since &&
      !!rows.length &&
      rows.every((row) => Date.parse(row.updated_at) < Date.parse(since));
    const hasMore = !q.number && rows.length === 20 && !reachedWindow;
    return {
      repository: scope.repository,
      repositoryId: q.repositoryId,
      kind: q.kind,
      retrievedAt: new Date().toISOString(),
      window: { since, until },
      page: q.page,
      hasMore,
      nextPage: hasMore && q.page < 100 ? q.page + 1 : undefined,
      complete: !hasMore,
      scanned: rows.length,
      coverage: hasMore
        ? "More pages may contain matching items. Continue paging; if stopped, disclose incomplete coverage."
        : "End of this query reached. Metadata does not establish user impact, CI success or completed reviews.",
      items: matches.map((row) => ({
        number: row.number,
        title: row.title.slice(0, 256),
        ...(q.number
          ? {
              body: row.body?.slice(0, 2000),
              bodyTruncated: (row.body?.length ?? 0) > 2000,
            }
          : {}),
        state: row.merged_at ? "merged" : row.state,
        url: `https://github.com/${scope.repository}/${q.kind === "pulls" ? "pull" : "issues"}/${row.number}`,
        author: row.user?.login,
        assignees: row.assignees?.map((p) => p.login),
        requestedReviewers: row.requested_reviewers?.map((p) => p.login),
        requestedTeams: row.requested_teams?.map((t) => t.slug),
        draft: row.draft,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        mergedAt: row.merged_at,
        closedAt: row.closed_at,
      })),
    };
  }
}
