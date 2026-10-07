import {
  type RepositorySources,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { repositoryAccess } from "./user-access.ts";

export function repositorySourcesAllowed(
  w: Workspace,
  actor: string,
  scope: RepositorySources,
) {
  return (
    !!w.github?.installationId &&
    w.github.revision === scope.revision &&
    scope.repositoryIds.every(
      (id) =>
        w.github?.repositories.some((r) => r.id === id) &&
        repositoryAccess(w, actor, id),
    )
  );
}

export function workflowRepositoriesAllowed(
  w: Workspace,
  actor: string,
  chatId: string,
  scope: RepositorySources,
) {
  return (
    repositorySourcesAllowed(w, actor, scope) &&
    (chatId === actor ||
      scope.repositoryIds.every(
        (id) =>
          w.github?.repositories.find((r) => r.id === id)?.private === false,
      ) ||
      w.members.some((m) => m.id === actor && m.active && m.role !== "member"))
  );
}

export function githubReadAllowed(w: Workspace, r: Run, scope = r.githubRead) {
  if (!scope) return true;
  if (!repositorySourcesAllowed(w, r.actor, scope)) return false;
  if (r.chatId === r.actor) return true;
  if (
    scope.repositoryIds.every(
      (id) =>
        w.github?.repositories.find((repo) => repo.id === id)?.private ===
        false,
    )
  )
    return true;
  const workflow = w.workflows.find((f) => f.id === r.workflowId);
  return (
    !!workflow &&
    workflow.status === "active" &&
    workflow.version === r.workflowVersion &&
    !!workflow.spec.github &&
    scope.repositoryIds.every((id) =>
      workflow.spec.github?.repositoryIds.includes(id),
    ) &&
    workflowRepositoriesAllowed(w, r.actor, r.chatId, workflow.spec.github)
  );
}

export function recordRepositoryRead(
  w: Workspace,
  r: Run,
  repositoryId: number,
  revision: number,
) {
  if (r.workflowId) {
    const workflow = w.workflows.find((f) => f.id === r.workflowId);
    requireThat(
      workflow?.spec.github?.repositoryIds.includes(repositoryId),
      "github_workflow_source_denied",
      403,
    );
  }
  const scope = {
    revision,
    repositoryIds: [
      ...new Set([...(r.githubRead?.repositoryIds ?? []), repositoryId]),
    ],
  };
  requireThat(
    githubReadAllowed(w, r, scope),
    "github_metadata_scope_denied",
    403,
  );
  r.githubRead = scope;
}
