import { type Run, requireThat, type Workspace } from "../domain.ts";
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
  run: Pick<Run, "attempts" | "settings">,
  now = new Date(),
) {
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const own = run.attempts.reduce((n, a) => n + (a.actual ?? a.reserved), 0);
  const monthly = [...workspace.runs, ...(workspace.adminChecks ?? [])]
    .flatMap((r) => r.attempts)
    .filter((a) => Date.parse(a.at) >= month);
  const total = monthly.reduce((n, a) => n + (a.actual ?? a.reserved), 0);
  const runLimit = Math.min(
    run.settings.runBudgetUsd ?? Infinity,
    workspace.settings.runBudgetUsd ?? Infinity,
  );
  const monthlyLimit = workspace.settings.monthlyBudgetUsd ?? Infinity;
  requireThat(
    !(
      Number.isFinite(runLimit) &&
      run.attempts.some((a) => a.pricingUnknown && a.actual === undefined)
    ) &&
      !(
        Number.isFinite(monthlyLimit) &&
        monthly.some((a) => a.pricingUnknown && a.actual === undefined)
      ),
    "unpriced_usage_requires_reconciliation",
    409,
  );
  return {
    run: runLimit - own,
    workspace: monthlyLimit - total,
  };
}
