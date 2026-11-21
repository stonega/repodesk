import type {
  Run,
  Skill,
  SkillAudience,
  SkillScope,
  SkillSpec,
  Workspace,
} from "../domain.ts";
import {
  repositoryAccess,
  verifiedRepositoryAccess,
} from "../github/user-access.ts";
import type { SkillExtractionState } from "./types.ts";

export function skillExtractionState(w: Workspace): SkillExtractionState {
  w.skillExtraction ??= {
    enabled: true,
    jobs: [],
    checkpoints: [],
    suppressed: [],
  };
  return w.skillExtraction;
}

export function skillExtractionEnabled(w: Workspace): boolean {
  return w.skillExtraction?.enabled !== false;
}

export function normalizeSkillScope(
  spec: Pick<SkillSpec, "scope">,
): SkillScope {
  if (spec.scope?.kind === "project") {
    return {
      kind: "project",
      repositoryId: spec.scope.repositoryId,
      ...(spec.scope.repository ? { repository: spec.scope.repository } : {}),
    };
  }
  return { kind: "global" };
}

export function skillScopeKey(scope: SkillScope | undefined): string {
  if (scope?.kind === "project") return `project:${scope.repositoryId}`;
  return "global";
}

export function skillAudience(
  spec: Pick<SkillSpec, "audience">,
): SkillAudience {
  return spec.audience ?? "chat";
}

export function resolveSkillRepositoryName(
  w: Workspace,
  scope: SkillScope | undefined,
): string | undefined {
  if (scope?.kind !== "project") return undefined;
  return (
    w.github?.repositories.find((r) => r.id === scope.repositoryId)
      ?.full_name ?? scope.repository
  );
}

export function skillScopeLabel(
  w: Workspace,
  spec: Pick<SkillSpec, "scope">,
): string {
  const scope = normalizeSkillScope(spec);
  if (scope.kind === "global") return "Global";
  const repoName = resolveSkillRepositoryName(w, scope);
  return repoName ? `Project · ${repoName}` : `Project #${scope.repositoryId}`;
}

export function resolveRunRepositoryIds(
  w: Workspace,
  run: Pick<
    Run,
    "groupRepository" | "repository" | "githubRead" | "workflowId"
  >,
): Set<number> {
  const ids = new Set<number>();
  if (run.groupRepository?.repositoryId) {
    ids.add(run.groupRepository.repositoryId);
    return ids;
  }
  if (run.repository?.id) ids.add(run.repository.id);
  for (const repoId of run.githubRead?.repositoryIds ?? []) {
    ids.add(repoId);
  }
  if (run.workflowId) {
    const workflow = w.workflows.find((f) => f.id === run.workflowId);
    for (const repoId of workflow?.spec.github?.repositoryIds ?? []) {
      ids.add(repoId);
    }
  }
  return ids;
}

export function actorCanReadProjectSkill(
  w: Workspace,
  actor: string,
  repositoryId: number,
  strictVerified = false,
): boolean {
  const repo = w.github?.repositories.find((r) => r.id === repositoryId);
  if (!repo || repo.archived || repo.disabled) return false;
  if (strictVerified) {
    return verifiedRepositoryAccess(w, actor, repositoryId, false);
  }
  if (actor === w.operatorId) return true;
  const member = w.members.find((m) => m.id === actor && m.active);
  if (!member) return false;
  // Unlinked members on public repositories retain workspace policy; private repos require GitHub read access.
  if (!member.github) return !repo.private;
  return repositoryAccess(w, actor, repositoryId, false);
}

export function skillAllowedForContext(
  w: Workspace,
  actor: string,
  spec: SkillSpec,
  activeRepoIds: ReadonlySet<number>,
  options: {
    forChat?: boolean;
    forCoding?: boolean;
    strictRepoAccess?: boolean;
  } = {},
): boolean {
  const audience = skillAudience(spec);
  if (options.forChat && audience !== "chat" && audience !== "all") {
    return false;
  }
  if (options.forCoding && audience !== "coding" && audience !== "all") {
    return false;
  }
  const scope = normalizeSkillScope(spec);
  if (scope.kind === "global") return true;
  if (!activeRepoIds.has(scope.repositoryId)) return false;
  return actorCanReadProjectSkill(
    w,
    actor,
    scope.repositoryId,
    options.strictRepoAccess ?? false,
  );
}

export function recordSkillSuppression(
  w: Workspace,
  skill: Skill,
  reason: "archived" | "disabled",
  now = new Date().toISOString(),
) {
  if (!skill.auto) return;
  const state = skillExtractionState(w);
  const scopeKey = skillScopeKey(skill.draft.scope);
  state.suppressed = [
    ...state.suppressed.filter(
      (item) => !(item.slug === skill.draft.slug && item.scopeKey === scopeKey),
    ),
    {
      slug: skill.draft.slug,
      name: skill.draft.name,
      scopeKey,
      reason,
      at: now,
    },
  ].slice(-64);
}
