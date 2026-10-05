import { requireThat, type Workspace } from "../domain.ts";
import type { GitHubRepository } from "./app.ts";

export interface GitHubUserAccess {
  id: number;
  login: string;
  status: "connected" | "unavailable" | "disconnected";
  connectionRevision: number;
  syncedAt: string;
  repositories: GitHubRepository[];
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
    access.connectionRevision === w.github?.revision &&
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
  requireThat(
    repositoryAccess(w, actor, repositoryId, write),
    "github_user_access_denied",
    403,
  );
}
export function invalidateGitHubWork(w: Workspace, actor: string) {
  for (const a of w.approvals) {
    if (
      a.actor === actor &&
      ["github_issue", "coding_task"].includes(a.kind) &&
      !a.issue &&
      a.decision !== "rejected"
    )
      a.decision = "revoked";
  }
  for (const task of w.codingTasks ?? [])
    if (task.actor === actor) task.cancelRequested = true;
  // A queued answer may contain source material retrieved under prior permissions.
  for (const run of w.runs)
    if (
      run.actor === actor &&
      ["queued", "running", "awaiting_approval"].includes(run.status)
    ) {
      run.cancelled = true;
      run.status = "cancelled";
    }
  for (const d of w.deliveries)
    if (d.actor === actor && d.runId && d.state === "pending")
      d.state = "cancelled";
}
