import { type Run, requireThat, type Workspace } from "../domain.ts";
import { eligible } from "../workspaces/policy.ts";
import type { RepositoryObjective } from "./objective-schema.ts";

export {
  type RepositoryObjective,
  repositoryObjective,
} from "./objective-schema.ts";
export interface RepositoryTaskSettings {
  revision: number;
  repositories: {
    repositoryId: number;
    investigation: boolean;
    release: boolean;
  }[];
}

export function objectiveAllowed(
  w: Workspace,
  repositoryId: number,
  objective?: RepositoryObjective,
) {
  if (!objective || objective.kind === "development") return;
  const configured = w.repositoryTasks?.repositories.find(
    (r) => r.repositoryId === repositoryId,
  );
  requireThat(
    w.github?.repositories.some((r) => r.id === repositoryId) &&
      (configured?.[objective.kind] ?? true),
    "coding_objective_disabled",
    409,
  );
}

/** Objective classification is descriptive. Only the retained human request supplies intent. */
export function releaseInstruction(text: string) {
  if (
    /^\s*(?:(?:please|can you|could you)\s+)?(?:release|publish)\s+(?:notes?|documentation|docs|checklist|procedure|plan|guide)\b/i.test(
      text,
    )
  )
    return false;
  return (
    /^\s*(?:(?:please|can you|could you)\s+)?(?:release|publish)\b/i.test(
      text,
    ) ||
    /^\s*(?:发布|發佈|发行|發行)/.test(text) ||
    /^\s*(?:请|請|帮我|幫我|给|給|为|為)(?!.*(?:不要|别|別|解释|解釋|如何|怎么|怎麼)).{0,120}(?:发布|發佈|发行|發行)/.test(
      text,
    )
  );
}
export const releasePreparation = (text: string) =>
  /^\s*(?:(?:please|can you|could you)\s+)?prepare\s+(?:a\s+|the\s+)?release\b/i.test(
    text,
  ) || /^\s*(?:请|請)?(?:准备|準備)发布/.test(text);

export function versionMentioned(text: string, version: string) {
  const literal = version
    .replace(/^v/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w.])v?${literal}(?![\\w.-])`, "i").test(text);
}

/** A later version decision replaces older evidence; preparation never grants a write. */
function releaseDecisionInputs(inputs: { text: string; revision: number }[]) {
  const directive = inputs
    .filter((i) => releaseInstruction(i.text) || releasePreparation(i.text))
    .at(-1);
  return directive && releaseInstruction(directive.text)
    ? inputs.filter((i) => i.revision >= directive.revision)
    : [];
}
export function releaseVersionAuthorized(
  inputs: { text: string; revision: number }[],
  tag: string,
) {
  const decision = releaseDecisionInputs(inputs)
    .filter((i) => /\bv?\d+\.\d+\.\d+(?:-[\w.-]+)?\b/i.test(i.text))
    .at(-1);
  const versions = new Set(
    (decision?.text.match(/\bv?\d+\.\d+\.\d+(?:-[\w.-]+)?\b/gi) ?? []).map(
      (v) => v.replace(/^v/i, ""),
    ),
  );
  return versions.size === 1 && versions.has(tag.replace(/^v/i, ""));
}

export function releaseFlagAuthorized(
  inputs: { text: string; revision: number }[],
  flag: "draft" | "prerelease",
  tag: string,
) {
  const marker =
    flag === "draft" ? /\bdraft\b|草稿/i : /\bpre-?release\b|预发布|預發佈/i;
  const decision = releaseDecisionInputs(inputs)
    .filter((i) => marker.test(i.text))
    .at(-1)?.text;
  if (!decision) return flag === "prerelease" && tag.includes("-");
  return !/(?:\b(?:not|don't|do not|never)\b.{0,30}(?:draft|pre-?release)|(?:不要|不做|非).{0,10}(?:草稿|预发布|預發佈))/i.test(
    decision,
  );
}

export function configureRepositoryTasks(
  w: Workspace,
  run: Run,
  args: {
    sourceId: string;
    repositoryId: number;
    investigation: boolean;
    release: boolean;
  },
) {
  requireThat(eligible(w, run.actor, true), "admin_required", 403);
  const source = w.messages.find(
    (s) =>
      s.id === args.sourceId &&
      s.runId === run.id &&
      s.role === "user" &&
      s.author === run.actor &&
      s.chatId === run.chatId &&
      s.topicId === run.topicId,
  );
  requireThat(
    source &&
      /^(?:configure repository tasks|配置仓库任务|設定倉庫任務)\s*:/i.test(
        source.text,
      ),
    "coding_settings_request_required",
    403,
  );
  const repo = w.github?.repositories.find((r) => r.id === args.repositoryId);
  requireThat(
    repo && source.text.includes(repo.full_name),
    "coding_repository_required",
    403,
  );
  // The explicit command is small and exact; a model cannot substitute the settings.
  const value = source.text.slice(source.text.indexOf(":") + 1).trim();
  requireThat(
    value ===
      `${repo.full_name} investigation=${args.investigation} release=${args.release}`,
    "coding_settings_request_required",
    403,
  );
  const prior = w.repositoryTasks?.repositories ?? [];
  const next = {
    repositoryId: args.repositoryId,
    investigation: args.investigation,
    release: args.release,
  };
  const existing = prior.find((r) => r.repositoryId === args.repositoryId);
  if (
    existing?.investigation === next.investigation &&
    existing?.release === next.release
  )
    return w.repositoryTasks;
  w.repositoryTasks = {
    revision: (w.repositoryTasks?.revision ?? 0) + 1,
    repositories: [
      ...prior.filter((r) => r.repositoryId !== args.repositoryId),
      next,
    ],
  };
  return w.repositoryTasks;
}
