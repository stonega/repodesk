import type { Workflow, Workspace } from "../domain.ts";
import { repositoryAccess } from "../github/user-access.ts";
import { nextOccurrences } from "../workflows/schedule.ts";

export const visibleWorkflows = (w: Workspace, actor: string) =>
  w.workflows.filter(
    (f) =>
      f.status !== "deleted" &&
      (f.owner === actor ||
        w.chats.some((chat) => chat.id === f.spec.chatId && chat.active)),
  );

export function workflowMetadata(
  f: Workflow,
  now = new Date(),
): WorkflowMetadata {
  return {
    id: f.id,
    name: f.spec.name,
    owner: f.owner,
    status: f.status,
    version: f.version,
    recurrence: f.spec.recurrence,
    budgetUsd: f.spec.budgetUsd,
    // These are recurrence previews, not promises that a run will dispatch.
    next: nextOccurrences(f.spec.recurrence, now),
    reason: f.reason,
  };
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
  name: string;
  recurrence: Workflow["spec"]["recurrence"];
  budgetUsd: number;
  next: string[];
};
export type MemberWorkflow = Workflow & { next: string[] };
type RepositorySources = ReturnType<typeof workflowRepositories>;
export type WorkflowCollection =
  | { mode: "operator"; items: WorkflowMetadata[]; total: number }
  | {
      mode: "member";
      items: MemberWorkflow[];
      repositorySources: RepositorySources;
      total: number;
    };
export type WorkflowDetail =
  | { mode: "operator"; workflow: WorkflowMetadata }
  | {
      mode: "member";
      workflow: MemberWorkflow;
      repositorySources: RepositorySources;
    };
