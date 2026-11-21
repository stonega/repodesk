import { z } from "zod";
import { type Admin, requireThat, type Workspace } from "../domain.ts";
import { audit } from "../workspaces/policy.ts";

export const autonomyModeSchema = z.enum(["supervised", "check_in"]);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

export const repoAutonomyOverrideSchema = z.enum([
  "inherit",
  "supervised",
  "check_in",
]);
export type RepositoryAutonomyOverride = z.infer<
  typeof repoAutonomyOverrideSchema
>;

export const workspaceAutonomySchema = z
  .object({
    defaultMode: autonomyModeSchema.default("supervised"),
    revision: z.number().int().nonnegative().default(0),
    repositoryOverrides: z
      .record(z.string().regex(/^\d+$/), repoAutonomyOverrideSchema)
      .default({}),
    updatedAt: z.string().optional(),
    updatedBy: z.string().optional(),
  })
  .strict();
export type WorkspaceAutonomyConfig = z.infer<typeof workspaceAutonomySchema>;

export const autonomyUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    defaultMode: autonomyModeSchema,
  })
  .strict();

export const repositoryAutonomyUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    mode: repoAutonomyOverrideSchema,
  })
  .strict();

export type ActionClass = "L0" | "L1_L2" | "L3";

export type AutonomyAction =
  // L0 — Read & Observe (always automatic)
  | "read_query"
  | "research_subagent"
  | "codex_investigation"
  | "watcher_check"
  | "mission_followup_timer"
  // L1/L2 — Routine Non-Destructive Writes (automatic under check_in, gated under supervised)
  | "github_pr_create"
  | "github_issue_write"
  | "obsidian_note_write"
  | "skill_draft_save"
  | "lesson_draft_save"
  | "cloudflare_non_destructive_write"
  | "automation_write"
  // L3 — High-Impact / Destructive (IMMUTABLE human approval gate)
  | "github_pr_merge"
  | "github_pr_close"
  | "github_release_publish"
  | "cloudflare_destructive_write"
  | "obsidian_permanent_delete"
  | "workspace_delete"
  | "permission_or_autonomy_change";

const ACTION_CLASS: Record<AutonomyAction, ActionClass> = {
  read_query: "L0",
  research_subagent: "L0",
  codex_investigation: "L0",
  watcher_check: "L0",
  mission_followup_timer: "L0",

  github_pr_create: "L1_L2",
  github_issue_write: "L1_L2",
  obsidian_note_write: "L1_L2",
  skill_draft_save: "L1_L2",
  lesson_draft_save: "L1_L2",
  cloudflare_non_destructive_write: "L1_L2",
  automation_write: "L1_L2",

  github_pr_merge: "L3",
  github_pr_close: "L3",
  github_release_publish: "L3",
  cloudflare_destructive_write: "L3",
  obsidian_permanent_delete: "L3",
  workspace_delete: "L3",
  permission_or_autonomy_change: "L3",
};

export interface AutonomyDecision {
  action: AutonomyAction;
  actionClass: ActionClass;
  effectiveMode: AutonomyMode;
  allowedAutomatic: boolean;
  requiresApproval: boolean;
  reason: string;
}

export function workspaceAutonomy(w: Workspace): WorkspaceAutonomyConfig {
  return (
    w.autonomy ?? {
      defaultMode: "supervised",
      revision: 0,
      repositoryOverrides: {},
    }
  );
}

export function effectiveAutonomyMode(
  w: Workspace,
  repositoryId?: number,
): AutonomyMode {
  const cfg = workspaceAutonomy(w);
  if (repositoryId !== undefined) {
    const override = cfg.repositoryOverrides[String(repositoryId)];
    if (override === "supervised" || override === "check_in") return override;
  }
  return cfg.defaultMode;
}

/**
 * Deterministic server-side autonomy evaluation.
 * L3 high-impact and destructive actions ALWAYS require explicit human approval.
 */
export function evaluateAutonomy(
  w: Workspace,
  action: AutonomyAction,
  repositoryId?: number,
): AutonomyDecision {
  const actionClass = ACTION_CLASS[action];
  const effectiveMode = effectiveAutonomyMode(w, repositoryId);
  if (actionClass === "L0") {
    return {
      action,
      actionClass,
      effectiveMode,
      allowedAutomatic: true,
      requiresApproval: false,
      reason: "l0_read_automatic",
    };
  }
  if (actionClass === "L3") {
    return {
      action,
      actionClass,
      effectiveMode,
      allowedAutomatic: false,
      requiresApproval: true,
      reason: "autonomy_l3_approval_required",
    };
  }
  const automatic = effectiveMode === "check_in";
  return {
    action,
    actionClass,
    effectiveMode,
    allowedAutomatic: automatic,
    requiresApproval: !automatic,
    reason: automatic
      ? "check_in_routine_write_automatic"
      : "supervised_write_approval_required",
  };
}

export function isDestructiveCloudflareAction(action: string): boolean {
  return (
    action === "dns_delete" ||
    action.includes("delete") ||
    action.includes("destroy") ||
    action.includes("remove")
  );
}

export function updateWorkspaceAutonomy(
  w: Workspace,
  actor: string,
  raw: unknown,
  now = new Date(),
): WorkspaceAutonomyConfig {
  const input = autonomyUpdateSchema.parse(raw);
  const current = workspaceAutonomy(w);
  requireThat(input.revision === current.revision, "version_conflict", 409);
  const next: WorkspaceAutonomyConfig = {
    defaultMode: input.defaultMode,
    revision: current.revision + 1,
    repositoryOverrides: { ...current.repositoryOverrides },
    updatedAt: now.toISOString(),
    updatedBy: actor,
  };
  w.autonomy = next;
  audit(w, actor, "autonomy.updated", w.id, next.revision, now);
  return next;
}

export function updateRepositoryAutonomy(
  w: Workspace,
  actor: string,
  repositoryId: number,
  raw: unknown,
  now = new Date(),
): WorkspaceAutonomyConfig {
  const input = repositoryAutonomyUpdateSchema.parse(raw);
  requireThat(
    w.github?.repositories.some((r) => r.id === repositoryId),
    "github_repository_not_connected",
    404,
  );
  const current = workspaceAutonomy(w);
  requireThat(input.revision === current.revision, "version_conflict", 409);
  const overrides = { ...current.repositoryOverrides };
  if (input.mode === "inherit") delete overrides[String(repositoryId)];
  else overrides[String(repositoryId)] = input.mode;
  const next: WorkspaceAutonomyConfig = {
    defaultMode: current.defaultMode,
    revision: current.revision + 1,
    repositoryOverrides: overrides,
    updatedAt: now.toISOString(),
    updatedBy: actor,
  };
  w.autonomy = next;
  audit(
    w,
    actor,
    "autonomy.repository_updated",
    String(repositoryId),
    next.revision,
    now,
  );
  return next;
}

export interface AutonomyView {
  revision: number;
  defaultMode: AutonomyMode;
  updatedAt?: string;
  updatedBy?: string;
  l3ImmutableGates: readonly string[];
  repositories: {
    id: number;
    full_name: string;
    override: RepositoryAutonomyOverride;
    effectiveMode: AutonomyMode;
  }[];
}

export const L3_IMMUTABLE_GATES = [
  "Merge or close GitHub pull requests",
  "Publish GitHub Releases, tags, or release assets",
  "Delete DNS/Pages resources or destroy workspace data",
  "Modify workspace permissions, membership, or autonomy policies",
] as const;

export function autonomyView(w: Workspace, _admin?: Admin): AutonomyView {
  const cfg = workspaceAutonomy(w);
  const repos = w.github?.installationId ? w.github.repositories : [];
  return {
    revision: cfg.revision,
    defaultMode: cfg.defaultMode,
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
    l3ImmutableGates: L3_IMMUTABLE_GATES,
    repositories: repos.map((repo) => {
      const override = cfg.repositoryOverrides[String(repo.id)] ?? "inherit";
      return {
        id: repo.id,
        full_name: repo.full_name,
        override,
        effectiveMode: effectiveAutonomyMode(w, repo.id),
      };
    }),
  };
}
