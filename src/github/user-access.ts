import { Fault, type Run, requireThat, type Workspace } from "../domain.ts";
import type { GitHubRepository } from "./app.ts";
import { githubRepositoryScopeCurrent } from "./config.ts";

export interface GitHubUserAccess {
  id: number;
  login: string;
  status: "connected" | "unavailable" | "disconnected";
  connectionRevision: number;
  syncedAt: string;
  repositories: GitHubRepository[];
  syncError?:
    | "github_access_denied"
    | "github_rate_limited"
    | "github_unavailable";
  retryAt?: string;
  syncFailures?: number;
}
export function githubAccessPending(error: unknown) {
  return (
    error instanceof Fault &&
    [
      "github_user_access_unavailable",
      "github_unavailable",
      "github_rate_limited",
    ].includes(error.code)
  );
}
// Existing unlinked members retain the operator-managed policy. Linking adds
// an upstream boundary; disconnecting cannot remove that boundary.
export function repositoryAccess(
  w: Workspace,
  actor: string,
  repositoryId: number,
  write = false,
) {
  const access = w.members.find((m) => m.id === actor)?.github;
  if (!access) return true;
  const repo = access.repositories.find((r) => r.id === repositoryId);
  return (
    access.status === "connected" &&
    githubRepositoryScopeCurrent(w.github, access.connectionRevision, [
      repositoryId,
    ]) &&
    Date.parse(access.syncedAt) > Date.now() - 10 * 60000 &&
    (write
      ? repo?.permissions?.push === true || repo?.permissions?.admin === true
      : repo?.permissions?.pull === true)
  );
}
export function authorizeRepository(
  w: Workspace,
  actor: string,
  repositoryId: number,
  write = false,
) {
  const access = w.members.find((m) => m.id === actor)?.github;
  if (
    access &&
    access.status !== "disconnected" &&
    access.syncError !== "github_access_denied"
  )
    requireThat(
      access.status === "connected" &&
        githubRepositoryScopeCurrent(w.github, access.connectionRevision, [
          repositoryId,
        ]) &&
        Date.parse(access.syncedAt) > Date.now() - 10 * 60000,
      "github_user_access_unavailable",
      503,
    );
  requireThat(
    repositoryAccess(w, actor, repositoryId, write),
    "github_user_access_denied",
    403,
  );
}
/** Coding/review actions use verified GitHub access, with no unlinked fallback. */
export function verifiedRepositoryAccess(
  w: Workspace,
  actor: string,
  repositoryId: number,
  write = false,
) {
  const repository = w.github?.repositories.find((r) => r.id === repositoryId);
  const access = w.members.find((m) => m.id === actor)?.github;
  return (
    !!access &&
    access.connectionRevision === w.github?.revision &&
    !!w.github?.installationId &&
    !!repository &&
    !repository.archived &&
    !repository.disabled &&
    repositoryAccess(w, actor, repositoryId, write)
  );
}
export function authorizeVerifiedRepository(
  w: Workspace,
  actor: string,
  repositoryId: number,
  write = false,
) {
  const access = w.members.find((m) => m.id === actor)?.github;
  requireThat(access, "github_user_connection_required", 403);
  requireThat(
    access.status !== "connected" ||
      access.connectionRevision === w.github?.revision,
    "github_user_access_unavailable",
    503,
  );
  authorizeRepository(w, actor, repositoryId, write);
  requireThat(
    verifiedRepositoryAccess(w, actor, repositoryId, write),
    "github_user_access_denied",
    403,
  );
}
export function invalidateGitHubWork(
  w: Workspace,
  actor: string,
  repositoryIds?: number[],
) {
  if (repositoryIds?.length === 0) return;
  const affected = repositoryIds ? new Set(repositoryIds) : undefined;
  const approvalAffected = (payload: unknown) => {
    if (!affected) return true;
    const id = (payload as { repositoryId?: unknown } | null)?.repositoryId;
    // Historical payloads without a target cannot prove that they are unaffected.
    return typeof id !== "number" || affected.has(id);
  };
  const runAffected = (run: Run, seen = new Set<string>()): boolean => {
    if (!affected) return true;
    if (seen.has(run.id) || seen.size > 100) return true;
    const ids = [
      ...(run.githubRead?.repositoryIds ?? []),
      ...(run.handoffRead?.repositoryIds ?? []),
      ...(run.repository ? [run.repository.id] : []),
      ...(w.workflows.find((f) => f.id === run.workflowId)?.spec.github
        ?.repositoryIds ?? []),
    ];
    if (ids.some((id) => affected.has(id))) return true;
    if (
      w.approvals.some(
        (a) =>
          a.runId === run.id &&
          ["github_issue", "github_pull_request"].includes(a.kind) &&
          approvalAffected(a.payload),
      )
    )
      return true;
    const dependencies = [
      ...(run.handoffRead?.runIds ?? []),
      ...(run.followup ? [run.followup.anchorRunId] : []),
    ];
    // Untracked historical provenance cannot establish an unaffected scope.
    if (!ids.length && !dependencies.length) return true;
    return dependencies.some((id) => {
      const source = w.runs.find((r) => r.id === id);
      return !source || runAffected(source, new Set([...seen, run.id]));
    });
  };
  for (const a of w.approvals) {
    if (
      a.actor === actor &&
      ["github_issue", "github_pull_request"].includes(a.kind) &&
      approvalAffected(a.payload) &&
      !a.issue &&
      !a.pullRequest &&
      a.decision !== "rejected"
    )
      a.decision = "revoked";
  }
  // A queued answer may contain source material retrieved under prior permissions.
  for (const run of w.runs)
    if (
      run.actor === actor &&
      runAffected(run) &&
      ["queued", "running", "awaiting_approval"].includes(run.status)
    ) {
      run.cancelled = true;
      run.status = "cancelled";
    }
  for (const d of w.deliveries)
    if (
      d.actor === actor &&
      d.runId &&
      d.state === "pending" &&
      (!affected || w.runs.some((r) => r.id === d.runId && runAffected(r)))
    )
      d.state = "cancelled";
}
