import {
  type Member,
  requireThat,
  type Workflow,
  type WorkflowSpec,
  type Workspace,
} from "../domain.ts";
import { repositoryAccess } from "../github/user-access.ts";
import { nextOccurrences } from "../workflows/schedule.ts";
import { membersWithProfiles } from "../workspaces/member-profile.ts";
import { eligible } from "../workspaces/policy.ts";

// Panel authority and the Telegram identity used at execution are separate.
export function workflowOwner(
  w: Workspace,
  actor: string,
  spec?: WorkflowSpec,
  id?: string,
) {
  if (id) {
    const workflow = w.workflows.find(
      (f) => f.id === id && f.status !== "deleted",
    );
    requireThat(workflow, "not_found", 404);
    return workflow.owner;
  }
  requireThat(spec, "invalid_workflow");
  const owner = spec.chatId.startsWith("-")
    ? eligible(w, actor)
      ? actor
      : (w.members.find((m) => m.active && m.role === "owner")?.id ??
        w.members.find((m) => m.active && m.role === "admin")?.id)
    : spec.chatId;
  requireThat(owner && eligible(w, owner), "workflow_owner_unavailable", 409);
  return owner;
}

export function workflowRepositories(w: Workspace, actor: string) {
  return {
    revision: w.github?.revision ?? 0,
    repositories: w.github?.installationId
      ? w.github.repositories
          .filter((repo) => repositoryAccess(w, actor, repo.id))
          .map((repo) => ({
            id: repo.id,
            full_name: repo.full_name,
            private: repo.private,
          }))
      : [],
  };
}

export type WorkflowMetadata = Pick<
  Workflow,
  "id" | "owner" | "status" | "version" | "reason"
> & {
  ownerProfile?: Pick<Member, "id" | "name" | "username">;
  name: string;
  recurrence: Workflow["spec"]["recurrence"];
  next: string[];
};
export type MemberWorkflow = Workflow &
  Pick<WorkflowMetadata, "ownerProfile"> & { next: string[] };

export function workflowView(w: Workspace, workflow: Workflow): MemberWorkflow {
  const owner = membersWithProfiles(w).find((m) => m.id === workflow.owner);
  return {
    ...workflow,
    ownerProfile: {
      id: workflow.owner,
      name: owner?.name,
      username: owner?.username,
    },
    next: nextOccurrences(workflow.spec.recurrence, new Date()),
  };
}
type RepositorySources = ReturnType<typeof workflowRepositories>;
export type WorkflowCollection = {
  mode: "operator" | "member";
  items: MemberWorkflow[];
  repositorySources: RepositorySources;
  total: number;
};
export type WorkflowDetail = {
  mode: "operator" | "member";
  workflow: MemberWorkflow;
  repositorySources: RepositorySources;
};
