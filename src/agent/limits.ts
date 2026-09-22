import type { Run, Workspace } from "../domain.ts";
import type { ModelLimits } from "./model-settings.ts";

// Internal caps remain available to bounded evaluations; workspaces use automatic capacity.
export function inputByteLimit(
  input: { maxInputChars?: number; maxOutputTokens?: number },
  limits: ModelLimits,
) {
  return Math.max(
    0,
    Math.min(
      input.maxInputChars || Number.MAX_SAFE_INTEGER,
      limits.contextWindow - (input.maxOutputTokens ?? 1),
    ),
  );
}

export function remainingBudgets(
  workspace: Workspace,
  run: Run,
  now = new Date(),
) {
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const own = run.attempts.reduce((n, a) => n + (a.actual ?? a.reserved), 0);
  const total = workspace.runs
    .flatMap((r) => r.attempts)
    .filter((a) => Date.parse(a.at) >= month)
    .reduce((n, a) => n + (a.actual ?? a.reserved), 0);
  return {
    run:
      Math.min(run.settings.runBudgetUsd, workspace.settings.runBudgetUsd) -
      own,
    workspace: workspace.settings.monthlyBudgetUsd - total,
  };
}
