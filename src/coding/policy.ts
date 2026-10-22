import { requireThat, type Workspace } from "../domain.ts";
import { githubConnectionRevision } from "../github/config.ts";
import { authorizeVerifiedRepository } from "../github/user-access.ts";
import { fingerprint } from "../setup/credentials.ts";
import { authorize } from "../workspaces/policy.ts";
import { type CodingPayload, codingInput, codingPayload } from "./config.ts";

export function codingDestination(
  w: Workspace,
  actor: string,
  value: unknown,
): CodingPayload {
  authorize(w, actor);
  requireThat(
    !w.settings.paused && w.coding?.settings.enabled,
    "coding_disabled",
    409,
  );
  requireThat(
    w.coding.settings.backend === "podman",
    "coding_local_configuration_required",
    409,
  );
  const input = codingInput.parse(value);
  const repo = w.github?.repositories.find((r) => r.id === input.repositoryId);
  requireThat(
    repo && w.github?.installationId,
    "github_repository_not_connected",
    409,
  );
  authorizeVerifiedRepository(w, actor, input.repositoryId, true);
  requireThat(repo.default_branch, "github_default_branch_unavailable", 409);
  return codingPayload.parse({
    ...input,
    repository: repo.full_name,
    installationId: w.github.installationId,
    githubRevision: w.github.revision,
    githubScope: {
      connectionRevision: githubConnectionRevision(w.github),
      repositoryRevision: w.github.repositoryRevisions?.[repo.id] ?? 0,
      private: repo.private ?? null,
    },
    configRevision: w.coding.revision,
    baseBranch: repo.default_branch,
    backend: "podman",
    authMode: w.coding.settings.authMode ?? "provider_key",
  });
}
export function checkCodingPayload(
  w: Workspace,
  actor: string,
  payload: CodingPayload,
) {
  const connection = w.github;
  const scope = payload.githubScope;
  const githubUnchanged = scope
    ? connection &&
      githubConnectionRevision(connection) === scope.connectionRevision &&
      (connection.repositoryRevisions?.[payload.repositoryId] ?? 0) ===
        scope.repositoryRevision
    : connection?.revision === payload.githubRevision;
  requireThat(
    w.coding?.revision === payload.configRevision && githubUnchanged,
    "coding_configuration_changed",
    409,
  );
  const { repositoryId, title, body } = payload;
  const current = codingDestination(w, actor, { repositoryId, title, body });
  if (payload.githubScope) {
    // The current access check above still requires a fresh workspace-wide sync.
    // Only this task's connection and repository generations govern its grant.
    current.githubRevision = payload.githubRevision;
  } else {
    // Historical grants have no scoped snapshot; retain their original boundary.
    delete current.githubScope;
  }
  requireThat(
    fingerprint(current) === fingerprint(payload),
    "coding_configuration_changed",
    409,
  );
}
