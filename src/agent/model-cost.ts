import { Type } from "typebox";
import { z } from "zod";
import { type Run, requireThat, type Workspace } from "../domain.ts";
import { authorize } from "../workspaces/policy.ts";

export const modelCostParameters = Type.Object(
  {
    scope: Type.Optional(
      Type.Union([Type.Literal("self"), Type.Literal("workspace")]),
    ),
    period: Type.Optional(
      Type.Union([
        Type.Literal("today"),
        Type.Literal("month"),
        Type.Literal("retained"),
      ]),
    ),
  },
  { additionalProperties: false },
);
const querySchema = z
  .object({
    scope: z.enum(["self", "workspace"]).default("self"),
    period: z.enum(["today", "month", "retained"]).default("month"),
  })
  .strict();

export function authorizeModelCost(w: Workspace, run: Run, args: unknown) {
  const query = querySchema.parse(args);
  authorize(w, run.actor, query.scope === "workspace");
  requireThat(
    run.chatId === run.actor,
    "model_cost_requires_private_chat",
    403,
  );
  return query;
}

function emptyTotals() {
  return {
    calls: 0,
    settledCalls: 0,
    reservedCalls: 0,
    unknownCalls: 0,
    settledUsd: 0,
    reservedUsd: 0,
    unknownUsd: 0,
    accountedUsd: 0,
  };
}

export function queryModelCost(
  w: Workspace,
  run: Run,
  args: unknown,
  now = new Date(),
) {
  const { scope, period } = authorizeModelCost(w, run, args);
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const start =
    period === "month"
      ? month
      : period === "today"
        ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        : 0;
  const totals = emptyTotals();
  const models = new Map<string, ReturnType<typeof emptyTotals>>();
  let monthlyAccountedUsd = 0;
  for (const item of w.runs) {
    if (scope === "self" && item.actor !== run.actor) continue;
    for (const attempt of item.attempts) {
      const at = Date.parse(attempt.at);
      if (!Number.isFinite(at) || at > now.getTime()) continue;
      const accounted = attempt.actual ?? attempt.reserved;
      if (at >= month) monthlyAccountedUsd += accounted;
      if (at < start) continue;
      const model = models.get(item.model) ?? emptyTotals();
      models.set(item.model, model);
      for (const summary of [totals, model]) {
        summary.calls++;
        summary.accountedUsd += accounted;
        if (attempt.status === "settled") {
          summary.settledCalls++;
          summary.settledUsd += accounted;
        } else if (attempt.status === "reserved") {
          summary.reservedCalls++;
          summary.reservedUsd += accounted;
        } else {
          summary.unknownCalls++;
          summary.unknownUsd += accounted;
        }
      }
    }
  }
  return {
    currency: "USD",
    scope,
    period,
    timezone: "UTC",
    start: start ? new Date(start).toISOString() : null,
    asOf: now.toISOString(),
    totals,
    byModel: [...models]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, summary]) => ({ model, ...summary })),
    ...(scope === "workspace"
      ? {
          monthlyBudget: {
            limitUsd: w.settings.monthlyBudgetUsd,
            accountedUsd: monthlyAccountedUsd,
            remainingUsd: w.settings.monthlyBudgetUsd - monthlyAccountedUsd,
          },
        }
      : {}),
    note: "Recorded application costs, not a provider invoice. Settled costs use recorded usage and configured prices or operator reconciliation. Reserved and unknown amounts are not confirmed charges. Only retained accounting is included (up to 90 days); later calls, including the final answer to this query, are excluded.",
  };
}
