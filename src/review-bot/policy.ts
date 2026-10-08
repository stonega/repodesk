import { operator } from "../admin/auth.ts";
import { type Admin, requireThat, type Workspace } from "../domain.ts";
import { repositoryAccess } from "../github/user-access.ts";
import { eligible } from "../workspaces/policy.ts";
import type { ReviewTask } from "./config.ts";

export function reviewAuthority(w: Workspace, admin: Admin) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
export function reviewActor(
  w: Workspace,
  githubId: number,
  repositoryId: number,
  write: boolean,
) {
  // Admin-selected profile associations do not verify ownership.
  const member = w.members.find((m) => m.github?.id === githubId);
  requireThat(member && eligible(w, member.id), "review_actor_unverified", 403);
  requireThat(
    repositoryAccess(w, member.id, repositoryId, write),
    "github_user_access_denied",
    403,
  );
  const coding = w.coding?.settings.repositories.find(
    (r) => r.repositoryId === repositoryId,
  );
  requireThat(
    coding?.maintainers.includes(member.id),
    "coding_maintainer_required",
    403,
  );
  return member.id;
}
export function checkReview(w: Workspace, task: ReviewTask, stopping = false) {
  requireThat(!w.deletion && eligible(w, task.actor), "access_denied", 403);
  if (stopping) return;
  const config = w.reviewBot;
  const target = config?.settings.repositories.find(
    (r) => r.repositoryId === task.payload.repositoryId,
  );
  requireThat(
    config?.settings.enabled &&
      config.revision === task.reviewRevision &&
      target,
    "review_configuration_changed",
    409,
  );
  requireThat(
    !w.settings.paused && !task.cancelRequested,
    "review_cancelled",
    409,
  );
  requireThat(
    task.automatic
      ? target.autoReview && target.reviewer === task.actor
      : target.acceptRequests,
    "review_requests_disabled",
    409,
  );
  requireThat(
    task.mode !== "fix" || target.allowFixes,
    "review_fixes_disabled",
    403,
  );
  const connection = w.github;
  requireThat(
    connection?.installationId === task.payload.installationId &&
      connection.revision === task.payload.githubRevision &&
      connection.repositories.some(
        (r) =>
          r.id === task.payload.repositoryId &&
          r.full_name === task.payload.repository,
      ),
    "github_repository_not_connected",
    409,
  );
  const coding = w.coding;
  const repository = coding?.settings.repositories.find(
    (r) => r.repositoryId === task.payload.repositoryId,
  );
  requireThat(
    coding?.settings.enabled &&
      coding.revision === task.payload.configRevision &&
      repository?.maintainers.includes(task.actor),
    "coding_configuration_changed",
    409,
  );
  requireThat(
    task.mode !== "fix" || repository?.development?.executionMode === "direct",
    "coding_direct_execution_disabled",
    403,
  );
  requireThat(
    repositoryAccess(
      w,
      task.actor,
      task.payload.repositoryId,
      task.mode === "fix",
    ),
    "github_user_access_denied",
    403,
  );
  if (!task.automatic)
    requireThat(
      w.members.find((m) => m.id === task.actor)?.github?.id ===
        task.githubUserId,
      "review_actor_unverified",
      403,
    );
}
