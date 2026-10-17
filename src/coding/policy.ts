import { requireThat, type Workspace } from "../domain.ts";
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
  requireThat(
    w.coding?.revision === payload.configRevision &&
      w.github?.revision === payload.githubRevision,
    "coding_configuration_changed",
    409,
  );
  const { repositoryId, title, body } = payload;
  requireThat(
    fingerprint(codingDestination(w, actor, { repositoryId, title, body })) ===
      fingerprint(payload),
    "coding_configuration_changed",
    409,
  );
}
